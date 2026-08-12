/**
 * @file store.ts — atomic, fault-tolerant persistence of {@link RoutineStore}.
 *
 * Reads/writes `${HOME}/.pi/agent/extensions/routines/state.json` (using the
 * OS home directory when HOME is unset).
 *
 * Design rules:
 * - {@link loadStore} never throws. Missing / corrupt / unreadable file all
 *   resolve to an empty store; corruption is logged once to stderr.
 * - {@link saveStore} writes atomically (`.tmp` + rename) and additionally
 *   produces a `.bak` copy after successful rename. Disk-full / permission
 *   errors are caught and logged — never thrown — because in-memory state is
 *   the authoritative source.
 */

import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import type {
	DeferredHookFire,
	Routine,
	RoutineRun,
	RoutineStore,
	RoutineTickState,
	RoutineTrigger,
} from "./types.ts";
import {
	MAX_DEFERRED_HOOKS,
	MAX_DEFERRED_TRANSCRIPT_BYTES,
	MAX_RUN_HISTORY,
	MAX_USER_STATE_BYTES,
	SCHEMA_VERSION,
	STATE_FILE,
} from "./types.ts";

/** Fresh, empty store. */
export function emptyStore(): RoutineStore {
	return { schemaVersion: SCHEMA_VERSION, routines: {}, tickState: {}, deferredHooks: [] };
}

/**
 * Normalize v1 (`trigger`) and v2 (`triggers`) stores into the current schema.
 *
 * - Wraps each routine's singular `trigger` into a single-element
 *   `triggers` array.
 * - Drops the old `trigger` field.
 * - Idempotent for stores that already use `triggers`.
 */
export function migrateV1ToV2(raw: unknown): RoutineStore {
	const empty = emptyStore();
	if (!raw || typeof raw !== "object") return empty;
	const obj = raw as Record<string, unknown>;

	const routinesIn = (obj.routines ?? {}) as Record<string, Record<string, unknown>>;
	const routinesOut: Record<string, Record<string, unknown>> = {};
	for (const [id, r] of Object.entries(routinesIn)) {
		if (!r || typeof r !== "object") continue;
		let triggers: RoutineTrigger[];
		if (Array.isArray(r.triggers)) {
			triggers = r.triggers as RoutineTrigger[];
		} else if (r.trigger && typeof r.trigger === "object") {
			triggers = [r.trigger as RoutineTrigger];
		} else {
			triggers = [];
		}
		const { trigger: _drop, ...rest } = r as { trigger?: unknown } & Record<string, unknown>;
		routinesOut[id] = { ...rest, triggers };
	}

	return {
		schemaVersion: SCHEMA_VERSION,
		routines: routinesOut as unknown as RoutineStore["routines"],
		tickState: (obj.tickState ?? {}) as RoutineStore["tickState"],
		deferredHooks: [],
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value: unknown, minimum = 0): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= minimum;
}

function optionalString(value: unknown): value is string | undefined {
	return value === undefined || typeof value === "string";
}

function validTimezone(value: unknown): value is string | undefined {
	if (value === undefined) return true;
	if (typeof value !== "string") return false;
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
		return true;
	} catch {
		return false;
	}
}

function sanitizeTrigger(value: unknown): RoutineTrigger | null {
	if (!isRecord(value) || typeof value.kind !== "string") return null;
	switch (value.kind) {
		case "pulse":
			if (
				!finiteNumber(value.intervalMs, 1) ||
				typeof value.intervalHuman !== "string" ||
				value.timezone !== undefined
			) {
				return null;
			}
			return {
				kind: "pulse",
				intervalMs: value.intervalMs,
				intervalHuman: value.intervalHuman,
			};
		case "cron":
			if (typeof value.expr !== "string" || !validTimezone(value.timezone)) return null;
			return {
				kind: "cron",
				expr: value.expr,
				...(value.timezone ? { timezone: value.timezone } : {}),
			};
		case "oneoff":
			if (
				typeof value.fireAtIso !== "string" ||
				!validTimezone(value.timezone) ||
				(value.fired !== undefined && typeof value.fired !== "boolean")
			) {
				return null;
			}
			return {
				kind: "oneoff",
				fireAtIso: value.fireAtIso,
				...(value.timezone ? { timezone: value.timezone } : {}),
				...(value.fired === true ? { fired: true } : {}),
			};
		case "hook":
			if (
				!["session_start", "agent_end", "session_shutdown"].includes(String(value.event)) ||
				(value.once !== undefined && !["daily", "per_session"].includes(String(value.once)))
			) {
				return null;
			}
			return {
				kind: "hook",
				event: value.event as "session_start" | "agent_end" | "session_shutdown",
				...(value.once ? { once: value.once as "daily" | "per_session" } : {}),
			};
		case "api":
			if (value.allowArgs !== undefined && typeof value.allowArgs !== "boolean") return null;
			return { kind: "api", ...(value.allowArgs === true ? { allowArgs: true } : {}) };
		case "github": {
			if (
				typeof value.repo !== "string" ||
				!/^[^/?#\s]+\/[^/?#\s]+$/.test(value.repo) ||
				![
					"pull_request.opened",
					"pull_request.closed",
					"issues.opened",
					"issues.closed",
					"issues.events",
					"discussion",
					"issue.comment",
					"discussion.comment",
					"push",
				].includes(String(value.event)) ||
				!finiteNumber(value.pollIntervalMs, 1)
			) {
				return null;
			}
			const filter = isRecord(value.filter) ? value.filter : undefined;
			const labels = Array.isArray(filter?.labels)
				? filter.labels.filter((v): v is string => typeof v === "string" && v.length > 0)
				: undefined;
			const branches = Array.isArray(filter?.branches)
				? filter.branches.filter((v): v is string => typeof v === "string" && v.length > 0)
				: undefined;
			if (branches?.length && value.event !== "push") return null;
			const branchCursors = isRecord(value.branchCursors)
				? Object.fromEntries(
						Object.entries(value.branchCursors).filter(
							(entry): entry is [string, string] =>
								entry[0].length > 0 && typeof entry[1] === "string",
						),
					)
				: undefined;
			return {
				kind: "github",
				repo: value.repo,
				event: value.event as
					| "pull_request.opened"
					| "pull_request.closed"
					| "issues.opened"
					| "issues.closed"
					| "issues.events"
					| "discussion"
					| "issue.comment"
					| "discussion.comment"
					| "push",
				pollIntervalMs: value.pollIntervalMs,
				...(filter
					? {
							filter: {
								...(labels?.length ? { labels } : {}),
								...(branches?.length ? { branches } : {}),
								...(filter.mergedOnly === true ? { mergedOnly: true } : {}),
							},
						}
					: {}),
				...(typeof value.cursor === "string" ? { cursor: value.cursor } : {}),
				...(branchCursors && Object.keys(branchCursors).length > 0 ? { branchCursors } : {}),
			} as RoutineTrigger;
		}
		default:
			return null;
	}
}

function sanitizeRoutine(id: string, value: unknown): Routine | null {
	if (!isRecord(value)) return null;
	if (
		value.id !== id ||
		typeof value.name !== "string" ||
		!/^[a-z0-9-]{1,32}$/.test(value.name) ||
		typeof value.prompt !== "string" ||
		!value.prompt.trim() ||
		value.context !== "session" ||
		typeof value.quiet !== "boolean" ||
		!finiteNumber(value.createdAt)
	) {
		return null;
	}
	if (!Array.isArray(value.triggers) || value.triggers.length === 0 || value.triggers.length > 4) {
		return null;
	}
	const triggers = value.triggers.map(sanitizeTrigger);
	if (triggers.some((trigger) => trigger === null)) return null;
	if (
		(value.maxTicks !== undefined &&
			(!Number.isInteger(value.maxTicks) || !finiteNumber(value.maxTicks, 1))) ||
		(value.maxRunsPerDay !== undefined &&
			(!Number.isInteger(value.maxRunsPerDay) || !finiteNumber(value.maxRunsPerDay, 1))) ||
		(value.paused !== undefined && typeof value.paused !== "boolean")
	) {
		return null;
	}
	return {
		id,
		name: value.name,
		prompt: value.prompt,
		triggers: triggers as RoutineTrigger[],
		context: "session",
		quiet: value.quiet,
		createdAt: value.createdAt,
		...(typeof value.maxTicks === "number" ? { maxTicks: value.maxTicks } : {}),
		...(typeof value.maxRunsPerDay === "number" ? { maxRunsPerDay: value.maxRunsPerDay } : {}),
		...(value.paused === true ? { paused: true } : {}),
	};
}

function sanitizeRun(value: unknown, routineId: string): RoutineRun | null {
	if (!isRecord(value)) return null;
	if (
		typeof value.id !== "string" ||
		value.routineId !== routineId ||
		!finiteNumber(value.startedAt) ||
		!finiteNumber(value.endedAt) ||
		!finiteNumber(value.durationMs) ||
		!["success", "error", "skipped", "silent"].includes(String(value.status)) ||
		!Number.isInteger(value.triggerIndex) ||
		!["pulse", "cron", "oneoff", "hook", "github", "api", "manual"].includes(
			String(value.triggerKind),
		) ||
		typeof value.snippet !== "string" ||
		!optionalString(value.skipReason)
	) {
		return null;
	}
	return value as unknown as RoutineRun;
}

function sanitizeTickState(routineId: string, value: unknown): RoutineTickState {
	const base: RoutineTickState = {
		tickCount: 0,
		lastFiredAt: 0,
		lastFiredDateLocal: "",
		userState: {},
	};
	if (!isRecord(value)) return base;
	const hookOnceDaily = isRecord(value.hookOnceDaily)
		? Object.fromEntries(
				Object.entries(value.hookOnceDaily).filter(
					(entry): entry is [string, string] => typeof entry[1] === "string",
				),
			)
		: undefined;
	const runs = Array.isArray(value.runs)
		? value.runs
				.map((run) => sanitizeRun(run, routineId))
				.filter((run): run is RoutineRun => run !== null)
				.slice(-MAX_RUN_HISTORY)
		: undefined;
	let userState = isRecord(value.userState) ? value.userState : {};
	try {
		if (Buffer.byteLength(JSON.stringify(userState), "utf8") > MAX_USER_STATE_BYTES) {
			userState = {};
		}
	} catch {
		userState = {};
	}
	return {
		tickCount:
			Number.isInteger(value.tickCount) && finiteNumber(value.tickCount) ? value.tickCount : 0,
		lastFiredAt: finiteNumber(value.lastFiredAt) ? value.lastFiredAt : 0,
		lastFiredDateLocal:
			typeof value.lastFiredDateLocal === "string" ? value.lastFiredDateLocal : "",
		userState,
		...(runs?.length ? { runs } : {}),
		...(Number.isInteger(value.runsToday) && finiteNumber(value.runsToday)
			? { runsToday: value.runsToday }
			: {}),
		...(typeof value.runsTodayDate === "string" ? { runsTodayDate: value.runsTodayDate } : {}),
		...(hookOnceDaily && Object.keys(hookOnceDaily).length > 0 ? { hookOnceDaily } : {}),
	};
}

function trimUtf8End(value: string, maxBytes: number): { text: string; truncated: boolean } {
	const encoded = Buffer.from(value, "utf8");
	if (encoded.length <= maxBytes) return { text: value, truncated: false };
	let text = encoded.subarray(encoded.length - maxBytes).toString("utf8");
	if (text.startsWith("\uFFFD")) text = text.slice(1);
	return { text, truncated: true };
}

function sanitizeDeferredHook(
	value: unknown,
	routines: Record<string, Routine>,
): DeferredHookFire | null {
	if (!isRecord(value)) return null;
	const routine = typeof value.routineId === "string" ? routines[value.routineId] : undefined;
	if (
		!routine ||
		typeof value.id !== "string" ||
		!Number.isInteger(value.triggerIndex) ||
		(value.triggerIndex as number) < 0 ||
		routine.triggers[value.triggerIndex as number]?.kind !== "hook" ||
		(routine.triggers[value.triggerIndex as number] as { event?: string }).event !==
			"session_shutdown" ||
		typeof value.endedSessionId !== "string" ||
		!finiteNumber(value.deferredAt) ||
		typeof value.endedSessionCwd !== "string" ||
		typeof value.endedDateLocal !== "string" ||
		typeof value.endedTimeLocal !== "string" ||
		typeof value.transcript !== "string"
	) {
		return null;
	}
	const transcript = trimUtf8End(value.transcript, MAX_DEFERRED_TRANSCRIPT_BYTES);
	return {
		id: value.id,
		routineId: value.routineId as string,
		triggerIndex: value.triggerIndex as number,
		endedSessionId: value.endedSessionId,
		deferredAt: value.deferredAt,
		endedSessionCwd: value.endedSessionCwd,
		endedDateLocal: value.endedDateLocal,
		endedTimeLocal: value.endedTimeLocal,
		transcript: transcript.text,
		...(transcript.truncated || value.transcriptTruncated === true
			? { transcriptTruncated: true }
			: {}),
	};
}

/** Validate and sanitize parsed state so one malformed routine cannot break startup. */
export function sanitizeStore(raw: unknown, migrateLegacyDaily = false): RoutineStore {
	if (!isRecord(raw)) return emptyStore();
	const routines: Record<string, Routine> = {};
	const rawRoutines = isRecord(raw.routines) ? raw.routines : {};
	for (const [id, value] of Object.entries(rawRoutines)) {
		const routine = sanitizeRoutine(id, value);
		if (routine) routines[id] = routine;
		else console.warn(`[pi-routines] ignoring invalid persisted routine '${id}'`);
	}
	const rawTicks = isRecord(raw.tickState) ? raw.tickState : {};
	const tickState = Object.fromEntries(
		Object.keys(routines).map((id) => [id, sanitizeTickState(id, rawTicks[id])]),
	);
	for (const [id, routine] of Object.entries(routines)) {
		const trigger = routine.triggers.length === 1 ? routine.triggers[0] : undefined;
		const tick = tickState[id];
		if (
			migrateLegacyDaily &&
			trigger?.kind === "hook" &&
			trigger.once === "daily" &&
			tick?.lastFiredDateLocal &&
			!tick.hookOnceDaily
		) {
			tick.hookOnceDaily = {
				[`${id}:${trigger.event}:0`]: tick.lastFiredDateLocal,
			};
		}
	}
	const deferredHooks = (Array.isArray(raw.deferredHooks) ? raw.deferredHooks : [])
		.map((value) => sanitizeDeferredHook(value, routines))
		.filter((value): value is DeferredHookFire => value !== null)
		.sort((a, b) => a.deferredAt - b.deferredAt)
		.slice(-MAX_DEFERRED_HOOKS);
	return { schemaVersion: SCHEMA_VERSION, routines, tickState, deferredHooks };
}

/**
 * Load the persisted store.
 *
 * Returns {@link emptyStore} for any failure mode (missing file, malformed
 * JSON, permission denied). Never throws. Logs a single warning to stderr
 * on corruption recovery so the operator can investigate.
 */
export async function loadStore(generation?: number): Promise<RoutineStore> {
	let raw: string;
	try {
		raw = await fs.readFile(STATE_FILE, "utf8");
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code !== "ENOENT") {
			console.warn(
				`[pi-routines] could not read state.json (${code ?? "unknown"}): ${(err as Error).message}`,
			);
		}
		return emptyStore();
	}

	try {
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		const version = typeof parsed.schemaVersion === "number" ? parsed.schemaVersion : 1;
		if (version > SCHEMA_VERSION) {
			console.warn(
				`[pi-routines] state.json schema ${version} is newer than supported ${SCHEMA_VERSION}; ignoring it`,
			);
			return emptyStore();
		}
		if (version === SCHEMA_VERSION) return sanitizeStore(parsed);

		// Older schema → current: back up raw, migrate, validate, and persist.
		const migrated = sanitizeStore(migrateV1ToV2(parsed), true);
		try {
			await fs.mkdir(dirname(STATE_FILE), { recursive: true });
			await fs.writeFile(`${STATE_FILE}.v${version}.bak`, raw, { encoding: "utf8", mode: 0o600 });
		} catch (err) {
			console.warn(`[pi-routines] could not write schema backup: ${(err as Error).message}`);
		}
		await saveStore(migrated, generation);
		console.warn(`[pi-routines] migrated state.json from v${version} to v${SCHEMA_VERSION}`);
		return migrated;
	} catch (err) {
		console.warn(`[pi-routines] state.json corrupt, starting fresh: ${(err as Error).message}`);
		return emptyStore();
	}
}

let activeGeneration = 0;
let writeChain: Promise<void> = Promise.resolve();

/** Start a new extension-store generation, invalidating queued writes from older loads. */
export function beginStoreGeneration(): number {
	activeGeneration += 1;
	return activeGeneration;
}

function isStaleGeneration(generation: number | undefined): boolean {
	return generation !== undefined && generation !== activeGeneration;
}

/** Wait until all writes queued before this call have settled. */
export async function flushStoreWrites(): Promise<void> {
	await writeChain;
}

/**
 * Persist the store atomically.
 *
 * Sequence:
 *   1. mkdir -p on the parent directory.
 *   2. Serialize the store (under the same try block, so a JSON error doesn't
 *      become an unhandled promise rejection from fire-and-forget callers).
 *   3. Write JSON to a UNIQUE per-call `.tmp.<rand>` file. Unique names are
 *      load-bearing — multiple call sites do `void saveStore(...)`
 *      (recordRun, the oneoff fired-flag callback, etc.), and with a single
 *      shared tmp filename two concurrent writers either interleave bytes
 *      into the same file or trip ENOENT when one rename consumes the
 *      inode the other expected.
 *   4. `fs.rename` → final path (atomic on POSIX). A module-level chain keeps
 *      writes in invocation order; runtime generations discard stale reloads.
 *   5. Copy final → `${STATE_FILE}.bak` for disaster recovery.
 *
 * Any I/O error (disk full, EACCES, etc.) is caught and logged. The caller's
 * in-memory state remains the source of truth.
 */
export function saveStore(store: RoutineStore, generation?: number): Promise<void> {
	const tmp = `${STATE_FILE}.tmp.${randomBytes(4).toString("hex")}`;
	const bak = `${STATE_FILE}.bak`;

	const write = async (): Promise<void> => {
		if (isStaleGeneration(generation)) return;
		try {
			const data = JSON.stringify(store, null, 2);
			await fs.mkdir(dirname(STATE_FILE), { recursive: true });
			const fh = await fs.open(tmp, "w", 0o600);
			try {
				await fh.writeFile(data, "utf8");
			} finally {
				await fh.close();
			}
			await fs.chmod(tmp, 0o600);
			if (isStaleGeneration(generation)) {
				await fs.rm(tmp, { force: true });
				return;
			}
			await fs.rename(tmp, STATE_FILE);
			await fs.chmod(STATE_FILE, 0o600);
			try {
				await fs.copyFile(STATE_FILE, bak);
				await fs.chmod(bak, 0o600);
			} catch (err) {
				console.warn(`[pi-routines] could not write .bak: ${(err as Error).message}`);
			}
		} catch (err) {
			console.warn(
				`[pi-routines] saveStore failed (${(err as NodeJS.ErrnoException).code ?? "unknown"}): ${(err as Error).message}`,
			);
			try {
				await fs.rm(tmp, { force: true });
			} catch {
				/* ignore */
			}
		}
	};

	const queued = writeChain.then(write, write);
	writeChain = queued.catch(() => {});
	return queued;
}

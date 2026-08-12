/**
 * @file _mutate.ts — single source of truth for routine create/delete mutations.
 *
 * Both the LLM-callable tools (routine-create, routine-delete) and the
 * user-facing slash commands (/routine, /routine-on, /routine-install,
 * /routine-stop) call into these helpers. They own:
 *   - name validation
 *   - interval parsing
 *   - agent_end uniqueness + global-cap checks
 *   - upsert semantics (preserve id/createdAt/tickState on update)
 *   - timer (re)scheduling / unscheduling
 *   - persistence via `saveStore`
 *
 * The thin wrappers above (tool `execute` bodies, command `handler` bodies)
 * are responsible only for argument shape validation and surfacing the
 * `{ error }` / success payloads in their respective UIs.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { nanoid } from "nanoid";
import { describeTrigger, describeTriggers } from "../format.ts";
import { nextCronFire, parseCron, parseInterval, parseOneOff } from "../parser.ts";
import { queueEntryRoutineId, scheduleRoutine, unscheduleRoutine } from "../scheduler.ts";
import { saveStore } from "../store.ts";
import { revokeToken } from "../tokens.ts";
import type {
	ApiTrigger,
	CronTrigger,
	GithubTrigger,
	HookEvent,
	HookTrigger,
	OneOffTrigger,
	PulseTrigger,
	Routine,
	RoutineRuntimeState,
	RoutineTrigger,
} from "../types.ts";
import { DEFAULT_GITHUB_POLL_MS, MIN_GITHUB_POLL_MS } from "../types.ts";
import { restartWidgetRefresh, updateWidget } from "../widget.ts";
import {
	listRoutineNames as listRoutineNamesFromStore,
	resolveRoutine as resolveFromStore,
} from "./_resolve.ts";

// Re-export so existing callers that imported these from `_mutate.ts` keep
// working without code churn. The single implementations live in `_resolve.ts`
// and `format.ts` respectively.
export { describeTrigger, describeTriggers };

const NAME_RE = /^[a-z0-9-]{1,32}$/;
const MAX_ROUTINES = 20;
/** Cap on the number of triggers any one routine may carry. */
const MAX_TRIGGERS_PER_ROUTINE = 4;

function validateTimezone(timezone: string | undefined): void {
	if (!timezone) return;
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
	} catch {
		throw new Error(`Invalid IANA timezone '${timezone}'.`);
	}
}

// ─── Raw input trigger shapes ────────────────────────────────────────────────
//
// These are what callers (LLM tool / slash commands) pass in. They contain
// human-friendly fields ("5m", "*/15 * * * *") which {@link resolveTrigger}
// converts into the typed {@link RoutineTrigger} shapes stored on disk.

export type PulseTriggerInput = { kind: "pulse"; interval: string; timezone?: string };
export type CronTriggerInput = { kind: "cron"; expr: string; timezone?: string };
export type OneOffTriggerInput = { kind: "oneoff"; fireAtIso: string; timezone?: string };
export type HookTriggerInput = {
	kind: "hook";
	event: HookEvent;
	once?: "daily" | "per_session";
};
export type ApiTriggerInput = { kind: "api"; allowArgs?: boolean };
export type GithubTriggerInput = {
	kind: "github";
	repo: string;
	event:
		| "pull_request.opened"
		| "pull_request.closed"
		| "issues.opened"
		| "issues.closed"
		| "issues.events"
		| "discussion"
		| "issue.comment"
		| "discussion.comment"
		| "push";
	pollInterval?: string; // human (parsed by parseInterval), defaults to DEFAULT_GITHUB_POLL_MS
	filter?: {
		labels?: string[];
		branches?: string[];
		mergedOnly?: boolean;
	};
};

/** Union of every trigger shape the LLM tool / slash commands may submit. */
export type TriggerInput =
	| PulseTriggerInput
	| CronTriggerInput
	| OneOffTriggerInput
	| HookTriggerInput
	| ApiTriggerInput
	| GithubTriggerInput;

/** Inputs accepted by {@link createRoutine}. */
export interface CreateRoutineInput {
	name: string;
	prompt: string;
	/**
	 * Singular trigger. Convenience shape preserved from v0.1 — most slash
	 * commands and templates pass a single trigger. For multi-trigger
	 * routines, use {@link CreateRoutineInput.triggers} instead.
	 */
	trigger?: TriggerInput;
	/**
	 * Multi-trigger list. Any combination of pulse / cron / oneoff / hook /
	 * api / github, capped at {@link MAX_TRIGGERS_PER_ROUTINE}. ANY trigger
	 * firing enqueues the routine once (multi-trigger collapse window
	 * dedupes near-simultaneous fires).
	 *
	 * If both `trigger` and `triggers` are provided, `trigger` is appended.
	 */
	triggers?: TriggerInput[];
	quiet?: boolean;
	maxTicks?: number;
	/** Optional per-day fire cap (see {@link Routine.maxRunsPerDay}). */
	maxRunsPerDay?: number;
}

export interface CreateRoutineSuccess {
	id: string;
	name: string;
	triggerDescription: string;
	/** Present only for pulse routines. */
	nextFireIn?: string;
	/** True if this updated an existing routine (same name); false if new. */
	updated: boolean;
}

export interface MutateError {
	error: string;
}

export type CreateRoutineResult = CreateRoutineSuccess | MutateError;

export interface DeleteRoutineSuccess {
	deletedId: string;
	deletedName: string;
}

export type DeleteRoutineResult = DeleteRoutineSuccess | MutateError;

/**
 * Resolve a routine by id-or-name (runtime-keyed convenience for callers
 * that hold a runtime rather than a bare store). Returns `undefined` when
 * nothing matches.
 *
 * Thin wrapper over the canonical {@link resolveFromStore}; kept for
 * source compatibility with the v0.1 call sites.
 */
export function resolveRoutine(
	idOrName: string,
	runtime: RoutineRuntimeState,
): Routine | undefined {
	if (!idOrName) return undefined;
	return resolveFromStore(runtime.store, idOrName) ?? undefined;
}

/** Comma-separated list of current routine names (for "not found" errors). */
export function listRoutineNames(runtime: RoutineRuntimeState): string {
	return listRoutineNamesFromStore(runtime.store);
}

/**
 * Resolve one raw {@link TriggerInput} into a typed {@link RoutineTrigger}.
 *
 * Throws `Error` with a user-readable message on any validation failure
 * (bad interval, malformed cron expression, past one-off timestamp, invalid
 * `repo` for github triggers, etc.). Callers wrap the throw in their own
 * `{ error }` shape.
 */
export function resolveTrigger(input: TriggerInput): RoutineTrigger {
	switch (input.kind) {
		case "pulse": {
			if (input.timezone) {
				throw new Error("pulse triggers do not support timezone; use a cron trigger");
			}
			const parsed = parseInterval(input.interval);
			const out: PulseTrigger = {
				kind: "pulse",
				intervalMs: parsed.ms,
				intervalHuman: parsed.human,
			};
			return out;
		}
		case "cron": {
			validateTimezone(input.timezone);
			// Validate by parsing + computing the next fire (also catches
			// "no fire within 4 years" early).
			parseCron(input.expr);
			nextCronFire(input.expr, input.timezone, new Date());
			const out: CronTrigger = { kind: "cron", expr: input.expr };
			if (input.timezone) out.timezone = input.timezone;
			return out;
		}
		case "oneoff": {
			validateTimezone(input.timezone);
			// parseOneOff throws on past timestamps and unparseable strings.
			parseOneOff(input.fireAtIso, input.timezone);
			const out: OneOffTrigger = { kind: "oneoff", fireAtIso: input.fireAtIso };
			if (input.timezone) out.timezone = input.timezone;
			return out;
		}
		case "hook": {
			const out: HookTrigger = { kind: "hook", event: input.event };
			if (input.once) out.once = input.once;
			return out;
		}
		case "api": {
			const out: ApiTrigger = { kind: "api" };
			if (input.allowArgs) out.allowArgs = true;
			return out;
		}
		case "github": {
			if (typeof input.repo !== "string" || !/^[^/?#\s]+\/[^/?#\s]+$/.test(input.repo)) {
				throw new Error(
					`github trigger requires 'repo' in 'owner/name' form (got '${input.repo}').`,
				);
			}
			const filter = input.filter;
			if (filter?.branches?.length && input.event !== "push") {
				throw new Error("github branch filters are only valid for push events");
			}
			if (filter?.labels?.length && !input.event.startsWith("pull_request.")) {
				throw new Error("github label filters are only valid for pull_request events");
			}
			if (filter?.mergedOnly && input.event !== "pull_request.closed") {
				throw new Error("mergedOnly is only valid for pull_request.closed");
			}
			if (filter?.branches?.some((branch) => !branch.trim())) {
				throw new Error("github branch filters cannot contain empty names");
			}
			let pollIntervalMs = DEFAULT_GITHUB_POLL_MS;
			if (input.pollInterval) {
				const parsed = parseInterval(input.pollInterval);
				pollIntervalMs = Math.max(MIN_GITHUB_POLL_MS, parsed.ms);
			}
			const out: GithubTrigger = {
				kind: "github",
				repo: input.repo,
				event: input.event,
				pollIntervalMs,
			};
			if (input.filter) out.filter = input.filter;
			return out;
		}
	}
}

/**
 * Create or update a routine (upsert by name). Persists, (re)schedules
 * timers, and enforces all invariants:
 *
 *   - name shape  (lowercase / digits / hyphens, ≤32 chars)
 *   - per-trigger validation (interval bounds, cron syntax, future timestamps,
 *     well-formed github repo)
 *   - one routine per `hook agent_end` event globally (loop avoidance)
 *   - no two `hook agent_end` triggers within a single routine
 *   - `MAX_TRIGGERS_PER_ROUTINE` (4) cap per routine
 *   - global routine cap (`MAX_ROUTINES` = 20)
 *
 * On update, `id`, `createdAt`, and `tickState` are preserved.
 */
export async function createRoutine(
	input: CreateRoutineInput,
	runtime: RoutineRuntimeState,
	pi: ExtensionAPI,
	getCtx: () => ExtensionContext | null,
): Promise<CreateRoutineResult> {
	const { name, prompt, quiet, maxTicks, maxRunsPerDay } = input;

	if (!NAME_RE.test(name)) {
		return {
			error: `Invalid name '${name}'. Use lowercase letters, digits, and hyphens (max 32 chars).`,
		};
	}
	if (typeof prompt !== "string" || !prompt.trim()) {
		return { error: "Prompt must contain at least one non-whitespace character." };
	}

	// Assemble the raw trigger list (singular + plural inputs are both accepted).
	const rawTriggers: TriggerInput[] = [];
	if (input.trigger) rawTriggers.push(input.trigger);
	if (input.triggers && input.triggers.length > 0) rawTriggers.push(...input.triggers);
	if (rawTriggers.length === 0) {
		return { error: "Provide at least one trigger (pulse / cron / oneoff / hook / api / github)." };
	}
	if (rawTriggers.length > MAX_TRIGGERS_PER_ROUTINE) {
		return {
			error: `Too many triggers (${rawTriggers.length}). Max is ${MAX_TRIGGERS_PER_ROUTINE} per routine.`,
		};
	}

	// Resolve each trigger; collect first error if any fails.
	const resolvedTriggers: RoutineTrigger[] = [];
	for (let i = 0; i < rawTriggers.length; i++) {
		try {
			const t = rawTriggers[i];
			if (!t) continue;
			resolvedTriggers.push(resolveTrigger(t));
		} catch (err) {
			return { error: `trigger #${i + 1}: ${(err as Error).message}` };
		}
	}

	// Disallow two agent_end hooks on the same routine — the engine only fires
	// one per turn anyway, so the second slot would silently never run.
	const localAgentEnd = resolvedTriggers.filter(
		(t) => t.kind === "hook" && t.event === "agent_end",
	);
	if (localAgentEnd.length > 1) {
		return { error: "A routine cannot carry more than one agent_end hook trigger." };
	}

	const existing = Object.values(runtime.store.routines).find((r) => r.name === name);

	// Global agent_end uniqueness — only one routine in the whole store may
	// react to agent_end (otherwise it's a feedback-loop attractor).
	if (resolvedTriggers.some((t) => t.kind === "hook" && t.event === "agent_end")) {
		const conflict = Object.values(runtime.store.routines).find(
			(r) =>
				r.id !== existing?.id &&
				r.triggers.some((t) => t.kind === "hook" && t.event === "agent_end"),
		);
		if (conflict) {
			return {
				error:
					`Another routine ('${conflict.name}') already uses the agent_end hook. ` +
					"Delete it first or pick a different event.",
			};
		}
	}

	if (!existing && Object.keys(runtime.store.routines).length >= MAX_ROUTINES) {
		return {
			error: `Routine limit reached (${MAX_ROUTINES}). Delete an existing routine first.`,
		};
	}

	let routine: Routine;
	if (existing) {
		routine = {
			...existing,
			prompt,
			triggers: resolvedTriggers,
			quiet: quiet ?? existing.quiet ?? false,
			...(maxTicks !== undefined ? { maxTicks } : { maxTicks: existing.maxTicks }),
			...(maxRunsPerDay !== undefined
				? { maxRunsPerDay }
				: { maxRunsPerDay: existing.maxRunsPerDay }),
		};
		unscheduleRoutine(existing.id, runtime);
	} else {
		routine = {
			id: nanoid(),
			name,
			prompt,
			triggers: resolvedTriggers,
			context: "session",
			quiet: quiet ?? false,
			...(maxTicks !== undefined ? { maxTicks } : {}),
			...(maxRunsPerDay !== undefined ? { maxRunsPerDay } : {}),
			createdAt: Date.now(),
		};
		runtime.store.tickState[routine.id] = {
			tickCount: 0,
			lastFiredAt: 0,
			lastFiredDateLocal: "",
			userState: {},
		};
	}

	runtime.store.routines[routine.id] = routine;
	await saveStore(runtime.store, runtime.storeGeneration);

	scheduleRoutine(routine, runtime, pi, getCtx);
	restartWidgetRefresh(runtime, getCtx);

	// Pick the "primary" trigger (first time-based one) for the convenience
	// `nextFireIn` field. Hook-only routines omit it.
	const primary = routine.triggers.find((t) => t.kind === "pulse");
	const result: CreateRoutineSuccess = {
		id: routine.id,
		name: routine.name,
		triggerDescription: describeTriggers(routine.triggers),
		updated: Boolean(existing),
	};
	if (primary && primary.kind === "pulse") {
		result.nextFireIn = primary.intervalHuman;
	}
	return result;
}

/**
 * Delete a routine by id or (case-insensitive) name. Unschedules any pulse
 * timer, drops any in-flight per-routine runtime state (queued trigger
 * origin, pending api args, pending github event), and persists the store.
 */
export async function deleteRoutine(
	idOrName: string,
	runtime: RoutineRuntimeState,
): Promise<DeleteRoutineResult> {
	if (!idOrName) {
		return { error: "Provide a routine id or name." };
	}
	const routine = resolveRoutine(idOrName, runtime);
	if (!routine) {
		return {
			error: `No routine matched '${idOrName}'. Current routines: ${listRoutineNames(runtime)}.`,
		};
	}
	unscheduleRoutine(routine.id, runtime);
	// Drop transient per-routine maps so they don't leak orphan entries
	// when a routine is removed mid-queue or with a pending api fire.
	runtime.triggerOrigin.delete(routine.id);
	runtime.apiArgs?.delete(routine.id);
	runtime.store.deferredHooks = runtime.store.deferredHooks.filter(
		(item) => item.routineId !== routine.id,
	);
	// Drop the routine from any pending queue position.
	runtime.queue = runtime.queue.filter((entry) => queueEntryRoutineId(entry) !== routine.id);
	delete runtime.store.routines[routine.id];
	delete runtime.store.tickState[routine.id];
	await saveStore(runtime.store, runtime.storeGeneration);
	try {
		await revokeToken(routine.id);
	} catch (err) {
		console.warn(`[pi-routines] could not revoke token for '${routine.name}':`, err);
	}
	return { deletedId: routine.id, deletedName: routine.name };
}

// ─── Pause / resume ──────────────────────────────────────────────────────────

export interface SetPausedSuccess {
	id: string;
	name: string;
	paused: boolean;
	/** True if the call actually changed the flag; false if it was already in target state. */
	changed: boolean;
}

export type SetPausedResult = SetPausedSuccess | MutateError;

/**
 * Pause or resume a routine by id-or-name. Idempotent: pausing an already
 * paused routine (or resuming a running one) is a no-op that returns
 * `changed: false`.
 *
 * We keep the routine's timers armed even while paused, because:
 *   - Re-arming on resume is cheap (it's how /reload works already).
 *   - Pulse timers fire at most every 30 s, so the wake-up cost is trivial.
 *   - It keeps the "paused" gate in exactly one place
 *     ({@link scheduler.enqueueTriggerFire}) which also catches the hook /
 *     api / github paths.
 */
export async function setPaused(
	idOrName: string,
	paused: boolean,
	runtime: RoutineRuntimeState,
): Promise<SetPausedResult> {
	if (!idOrName) return { error: "Provide a routine id or name." };
	const routine = resolveRoutine(idOrName, runtime);
	if (!routine) {
		return {
			error: `No routine matched '${idOrName}'. Current routines: ${listRoutineNames(runtime)}.`,
		};
	}
	const was = routine.paused === true;
	if (was === paused) {
		return { id: routine.id, name: routine.name, paused, changed: false };
	}
	if (paused) routine.paused = true;
	else delete routine.paused;
	await saveStore(runtime.store, runtime.storeGeneration);
	if (runtime.lastUiCtx) updateWidget(runtime, runtime.lastUiCtx);
	return { id: routine.id, name: routine.name, paused, changed: true };
}

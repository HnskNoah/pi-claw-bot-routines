/**
 * @file executor.ts — builds a routine's prompt and fires it.
 *
 * Owns:
 *   - {@link buildPrompt}: pure prompt assembly (prefix + placeholder substitution
 *     + optional quiet-mode `[~]` footer).
 *   - {@link fireRoutine}: side-effectful single-shot firing (maxTicks gate,
 *     guard acquisition, `pi.sendUserMessage`, tickState write-through, error
 *     recovery).
 *
 * Does NOT own:
 *   - Scheduling / queueing — that belongs to `scheduler.ts`.
 *   - Lifecycle event subscriptions — that belongs to `hooks.ts` (TP-006).
 *   - Suppression of `[~]` output in chat — that belongs to TP-003.
 *
 * Recursion guard is acquired here but is released by the caller of the
 * subsequent agent_end event (see `hooks.ts` in TP-006). On exception during
 * firing, the guard is released here so the routine survives.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { nanoid } from "nanoid";
import * as guard from "./guard.ts";
import { unscheduleRoutine } from "./scheduler.ts";
import { ghLogger } from "./pi-log.ts";
import { saveStore } from "./store.ts";
import type {
	Routine,
	RoutineFireOrigin,
	RoutineQueueEntry,
	RoutineRun,
	RoutineRuntimeState,
	RoutineStore,
	RoutineTickState,
	RoutineTrigger,
} from "./types.ts";
import { MAX_RUN_HISTORY, MAX_USER_STATE_BYTES } from "./types.ts";

/** Build the full prompt string that will be injected into the session. */
export function buildPrompt(
	routine: Routine,
	tickState: RoutineTickState,
	cwd: string,
	apiArgs?: Record<string, unknown> | null,
	githubEvent?: Record<string, unknown> | null,
	contextNote?: string | null,
): string {
	const now = new Date();
	const time = now.toLocaleTimeString();
	const date = now.toLocaleDateString();
	const hhmm = time.replace(/:\d{2}(?:\s?[AP]M)?$/i, (m) => {
		// Convert "14:23:45" → "14:23"; preserve am/pm if present.
		const ampm = /[AP]M/i.exec(m)?.[0] ?? "";
		return ampm ? ` ${ampm}` : "";
	});
	const nextTick = tickState.tickCount + 1;

	// userState injection with size cap.
	let userStateJson = JSON.stringify(tickState.userState ?? {});
	let truncated = false;
	if (userStateJson.length > MAX_USER_STATE_BYTES) {
		userStateJson = "{}";
		truncated = true;
	}

	// Substitute placeholders inside the user-authored prompt body.
	// patched by pi: {githubEvent} injects a chat-style message line when the
	// poller attached one (payload.message), falling back to JSON for other
	// event types; {githubMessage} is the same text under a friendlier name.
	const isObj = githubEvent !== null && typeof githubEvent === "object";
	const msg = isObj && typeof (githubEvent as Record<string, unknown>).message === "string"
		? ((githubEvent as Record<string, unknown>).message as string)
		: githubEvent
			? JSON.stringify(githubEvent)
			: "{}";
	const substituted = routine.prompt
		.replaceAll("{cwd}", cwd)
		.replaceAll("{date}", date)
		.replaceAll("{time}", time)
		.replaceAll("{state}", userStateJson)
		.replaceAll("{tickCount}", String(nextTick))
		.replaceAll("{apiArgs}", apiArgs ? JSON.stringify(apiArgs) : "{}")
		.replaceAll("{githubEvent}", msg)
		.replaceAll("{githubMessage}", msg);

	const header =
		`[↺ routine: ${routine.name} · tick ${nextTick} · ${hhmm}]\n` +
		`Previous state: ${userStateJson}\n\n` +
		(contextNote ? `${contextNote}\n\n` : "") +
		substituted;

	const truncNote = truncated ? "\n\n[state truncated]" : "";

	const quietFooter = routine.quiet
		? "\n\n---\n" +
			"If nothing changed and there is nothing to report, respond with exactly: [~]\n" +
			"Do not explain that you are responding with [~]. Just output [~] and nothing else."
		: "";

	return header + truncNote + quietFooter;
}

/**
 * Fire a single routine: gate on maxTicks + maxRunsPerDay, build prompt,
 * acquire guard, send message, update tickState (write-through). On
 * exception, release guard and log — the routine survives. The guard is
 * released by `hooks.ts` on the subsequent `agent_end` in the happy path.
 */
export type FireRoutineOutcome = "started" | "skipped" | "deleted" | "error";

function removeDeferredHook(store: RoutineStore, deferredHookId: string | undefined): void {
	if (!deferredHookId) return;
	store.deferredHooks = store.deferredHooks.filter((item) => item.id !== deferredHookId);
}

export async function fireRoutine(
	routine: Routine,
	runtime: RoutineRuntimeState,
	store: RoutineStore,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	request?: RoutineQueueEntry,
): Promise<FireRoutineOutcome> {
	const existing: RoutineTickState | undefined = store.tickState[routine.id];
	const tickState: RoutineTickState = existing ?? {
		tickCount: 0,
		lastFiredAt: 0,
		lastFiredDateLocal: "",
		userState: {},
	};

	// Object queue entries are authoritative. The map fallback remains for
	// direct callers and stores written by older extension instances.
	const origin = request?.origin ??
		runtime.triggerOrigin.get(routine.id) ?? {
			index: 0,
			kind: (routine.triggers[0]?.kind ?? "pulse") as RoutineTrigger["kind"] | "manual",
		};
	runtime.triggerOrigin.delete(routine.id);
	const runId = request?.runId ?? nanoid();

	// maxTicks gate — applied BEFORE acquiring the guard so an exhausted
	// routine cleans itself up without occupying a turn.
	if (typeof routine.maxTicks === "number" && tickState.tickCount >= routine.maxTicks) {
		unscheduleRoutine(routine.id, runtime);
		removeDeferredHook(store, request?.deferredHookId);
		delete store.routines[routine.id];
		delete store.tickState[routine.id];
		await saveStore(store, runtime.storeGeneration);
		return "deleted";
	}

	const startedAt = Date.now();
	const budgetExempt = origin.kind === "manual" || Boolean(request?.deferredHookId);

	// maxRunsPerDay soft cap — applied BEFORE acquiring the guard so capped
	// fires consume zero provider tokens. The counter rolls over to 0 at
	// local midnight (compared via the `en-CA` locale's ISO date format).
	// Manual and deferred shutdown fires bypass the cap: both are explicit
	// work that should not consume the automatic schedule's daily budget.
	if (typeof routine.maxRunsPerDay === "number" && !budgetExempt) {
		const today = new Date().toLocaleDateString("en-CA");
		const sameDay = tickState.runsTodayDate === today;
		const usedToday = sameDay ? (tickState.runsToday ?? 0) : 0;
		if (usedToday >= routine.maxRunsPerDay) {
			const hookTrigger = routine.triggers[origin.index];
			if (request?.hookOnceKey && request.hookOnce === "daily" && hookTrigger?.kind === "hook") {
				guard.commitHookFire(hookTrigger, tickState, runtime, request.hookOnceKey, today);
				store.tickState[routine.id] = tickState;
			}
			recordRun(runtime, store, {
				id: runId,
				routineId: routine.id,
				startedAt,
				endedAt: startedAt,
				durationMs: 0,
				status: "skipped",
				triggerIndex: origin.index,
				triggerKind: origin.kind,
				snippet: `Daily cap reached (${usedToday}/${routine.maxRunsPerDay})`,
				skipReason: "daily cap reached",
			});
			return "skipped";
		}
	}

	try {
		guard.acquireRoutineTurn(runtime, routine.name);

		// Open the run record. The suppressor / message_end handler will
		// populate `snippet` + downgrade to `"silent"` if the response is `[~]`.
		// `agent_end` finalises it.
		runtime.pendingRun = {
			routineId: routine.id,
			runId,
			triggerIndex: origin.index,
			triggerKind: origin.kind,
			startedAt,
			snippet: "",
			status: "success",
			...(request?.deferredHookId ? { deferredHookId: request.deferredHookId } : {}),
		};

		const apiArgs = request?.apiArgs ?? runtime.apiArgs?.get(routine.id) ?? null;
		runtime.apiArgs?.delete(routine.id);
		// patched by pi: github bridge injects via sendUserMessage with the
		// prompt already rendered; the legacy githubEvents map is gone.
		const githubEvent = request?.githubEvent ?? null;
		// patched by pi: fire log line (user: mature logging)
		ghLogger.info({ routine: routine.name, tick: tickState.tickCount + 1 }, "fire");
		const prompt = buildPrompt(
			routine,
			tickState,
			ctx.cwd,
			apiArgs,
			githubEvent,
			request?.contextNote,
		);

		// NB: PLAN/PROMPT request `deliverAs: "nextTurn"`, but the typed
		// ExtensionAPI.sendUserMessage signature only allows "steer" | "followUp".
		// "followUp" is the closest equivalent (queue after the current turn
		// without interrupting). See Discoveries.
		pi.sendUserMessage(prompt, { deliverAs: "followUp" });

		// Bump runsToday only for AUTOMATIC fires. Manual fires bypass the
		// daily cap on the pre-check (see above); they must not count toward
		// it post-fire either, or repeated /routine-run-now would silently
		// burn the day's budget for scheduled fires. The counter still rolls
		// over at local midnight via the runsTodayDate compare.
		const today = new Date().toLocaleDateString("en-CA");
		const sameDay = tickState.runsTodayDate === today;
		const carried = sameDay ? (tickState.runsToday ?? 0) : 0;
		const nextRunsToday = budgetExempt ? carried : carried + 1;
		const updated: RoutineTickState = {
			tickCount: tickState.tickCount + 1,
			lastFiredAt: Date.now(),
			lastFiredDateLocal: today,
			userState: tickState.userState ?? {},
			runs: tickState.runs ?? [],
			runsToday: nextRunsToday,
			runsTodayDate: today,
			hookOnceDaily: tickState.hookOnceDaily ?? {},
		};
		const hookTrigger = routine.triggers[origin.index];
		if (
			request?.hookOnceKey &&
			hookTrigger?.kind === "hook" &&
			request.hookOnce === hookTrigger.once
		) {
			guard.commitHookFire(hookTrigger, updated, runtime, request.hookOnceKey, today);
		}
		removeDeferredHook(store, request?.deferredHookId);
		store.tickState[routine.id] = updated;
		await saveStore(store, runtime.storeGeneration);
		return "started";
	} catch (err) {
		guard.releaseRoutineTurn(runtime);
		// Record the failed run synchronously — agent_end will not fire for
		// a turn that never started.
		recordRun(runtime, store, {
			id: runId,
			routineId: routine.id,
			startedAt,
			endedAt: Date.now(),
			durationMs: Date.now() - startedAt,
			status: "error",
			triggerIndex: origin.index,
			triggerKind: origin.kind,
			snippet: truncateSnippet(err instanceof Error ? err.message : String(err)),
		});
		runtime.pendingRun = null;
		console.error(`[pi-routines] fireRoutine '${routine.name}' (${routine.id}) failed:`, err);
		return "error";
	}
}

/**
 * Push a {@link RoutineRun} into the routine's `tickState.runs` ring buffer,
 * trimming to {@link MAX_RUN_HISTORY}, then persist.
 *
 * If the routine has no `tickState` entry yet (e.g. the very first fire
 * errors out before the success-path write-through, or the cap-skip path
 * fires before any successful run) we initialise a default entry rather
 * than silently dropping the run record. Previously the function bailed
 * out on missing tickState, which made first-time-ever errors and
 * cap-skipped fires invisible in `/routine-runs`.
 */
export function recordRun(
	runtime: RoutineRuntimeState,
	store: RoutineStore,
	run: RoutineRun,
): void {
	let ts = store.tickState[run.routineId];
	if (!ts) {
		ts = {
			tickCount: 0,
			lastFiredAt: 0,
			lastFiredDateLocal: "",
			userState: {},
		};
		store.tickState[run.routineId] = ts;
	}
	const runs = ts.runs ?? [];
	runs.push(run);
	while (runs.length > MAX_RUN_HISTORY) runs.shift();
	ts.runs = runs;
	// Fire-and-forget save — saveStore is best-effort and never throws.
	void saveStore(store, runtime.storeGeneration);
}

/** Record an automatic fire that was dropped before opening an LLM turn. */
export function recordSkippedFire(
	runtime: RoutineRuntimeState,
	store: RoutineStore,
	routine: Routine,
	origin: RoutineFireOrigin,
	reason: string,
	runId = nanoid(),
): void {
	const startedAt = Date.now();
	recordRun(runtime, store, {
		id: runId,
		routineId: routine.id,
		startedAt,
		endedAt: startedAt,
		durationMs: 0,
		status: "skipped",
		triggerIndex: origin.index,
		triggerKind: origin.kind,
		snippet: reason,
		skipReason: reason,
	});
}

/** Truncate a candidate snippet to {@link SNIPPET_MAX_CHARS}. */
export function truncateSnippet(text: string): string {
	const trimmed = text.replace(/\s+/g, " ").trim();
	return trimmed.length <= 200 ? trimmed : `${trimmed.slice(0, 199)}…`;
}

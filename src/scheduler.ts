/**
 * @file scheduler.ts — owns pulse-routine timers and the fire queue.
 *
 * Owns:
 *   - `setInterval` handles, one per pulse routine, stored in `runtime.timers`.
 *   - The FIFO fire queue (`runtime.queue`), with dedup + backpressure cap.
 *   - The idle-aware `drainQueue` loop that hands work to `executor.fireRoutine`.
 *
 * Does NOT own:
 *   - `pi.on(...)` subscriptions — `hooks.ts` (TP-006) listens for `agent_end`
 *     etc. and calls into `drainQueue` / `startScheduler` / etc.
 *   - Prompt building or message sending — that is `executor.ts`.
 *   - Hook-trigger ("once: daily/per_session") logic — that is `guard.ts`.
 *
 * Stale-context defence: a `getCtx()` returning null OR throwing the
 * "Extension context no longer active" error permanently halts the offending
 * timer (the runtime is being torn down anyway).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { nanoid } from "nanoid";
import { fireRoutine, recordSkippedFire } from "./executor.ts";
import { armGithubPoller } from "./github-poller.ts";
import * as guard from "./guard.ts";
import { nextCronFire, parseOneOff } from "./parser.ts";
import { saveStore } from "./store.ts";
import type { Routine, RoutineQueueEntry, RoutineRuntimeState, RoutineTrigger } from "./types.ts";
import { MAX_QUEUE_DEPTH, MULTI_TRIGGER_COLLAPSE_MS } from "./types.ts";

const STALE_CTX_MARKER = "Extension context no longer active";

/** True if the error/ctx indicates the extension runtime is gone. */
function isStaleCtxError(err: unknown): boolean {
	return err instanceof Error && err.message.includes(STALE_CTX_MARKER);
}

/** Start timers for every routine currently in the store. */
export function startScheduler(
	runtime: RoutineRuntimeState,
	pi: ExtensionAPI,
	getCtx: () => ExtensionContext | null,
): void {
	for (const routine of Object.values(runtime.store.routines)) {
		scheduleRoutine(routine, runtime, pi, getCtx);
	}
}

/** Map of routineId → epoch ms of last enqueue, for multi-trigger dedup. */
const lastEnqueueAt = new WeakMap<RoutineRuntimeState, Map<string, number>>();

function getEnqueueMap(runtime: RoutineRuntimeState): Map<string, number> {
	let m = lastEnqueueAt.get(runtime);
	if (!m) {
		m = new Map();
		lastEnqueueAt.set(runtime, m);
	}
	return m;
}

/** Clear every active timer and audit queued work that cannot survive teardown. */
export function stopScheduler(runtime: RoutineRuntimeState, reason?: string): void {
	for (const handles of runtime.timers.values()) {
		for (const h of handles) {
			if (h) clearTimeout(h as unknown as NodeJS.Timeout);
		}
	}
	runtime.timers.clear();
	if (reason) {
		while (runtime.queue.length > 0) dropOldestQueuedFire(runtime, reason);
	} else {
		runtime.queue.length = 0;
	}
	getEnqueueMap(runtime).clear();
}

export function queueEntryRoutineId(entry: RoutineQueueEntry): string {
	return entry.routineId;
}

export function queueHasRoutine(runtime: RoutineRuntimeState, routineId: string): boolean {
	return runtime.queue.some((entry) => queueEntryRoutineId(entry) === routineId);
}

function dropOldestQueuedFire(runtime: RoutineRuntimeState, reason: string): void {
	dropQueuedFireAt(runtime, 0, reason);
}

function dropQueuedFireAt(runtime: RoutineRuntimeState, index: number, reason: string): void {
	const [dropped] = runtime.queue.splice(index, 1);
	if (!dropped) return;
	const routine = runtime.store.routines[dropped.routineId];
	if (!routine) return;
	recordSkippedFire(runtime, runtime.store, routine, dropped.origin, reason, dropped.runId);
}

export interface QueueMetadata {
	runId?: string;
	apiArgs?: Record<string, unknown>;
	githubEvent?: Record<string, unknown>;
	contextNote?: string;
	hookOnceKey?: string;
	hookOnce?: RoutineQueueEntry["hookOnce"];
	deferredHookId?: string;
	autoDrain?: boolean;
	priority?: boolean;
}

/** Enqueue one fully-described fire, applying shared backpressure and drain handling. */
export function enqueueRoutineFire(
	routine: Routine,
	origin: RoutineQueueEntry["origin"],
	runtime: RoutineRuntimeState,
	pi: ExtensionAPI,
	getCtx: () => ExtensionContext | null,
	metadata: QueueMetadata = {},
): string {
	const { autoDrain = true, priority = false, runId = nanoid(), ...entryMetadata } = metadata;
	if (runtime.queue.length >= MAX_QUEUE_DEPTH) {
		let normalIndex = -1;
		if (priority) {
			for (let index = runtime.queue.length - 1; index >= 0; index--) {
				if (!runtime.queue[index]?.deferredHookId) {
					normalIndex = index;
					break;
				}
			}
		}
		dropQueuedFireAt(runtime, normalIndex >= 0 ? normalIndex : 0, "queue overflow");
	}
	const entry = { routineId: routine.id, runId, origin, ...entryMetadata };
	if (priority) {
		const firstNormal = runtime.queue.findIndex((queued) => !queued.deferredHookId);
		runtime.queue.splice(firstNormal >= 0 ? firstNormal : runtime.queue.length, 0, entry);
	} else {
		runtime.queue.push(entry);
	}
	if (autoDrain) {
		void drainQueue(runtime, pi, getCtx).catch((err) => {
			console.error(`[pi-routines] queue drain failed for '${routine.name}':`, err);
		});
	}
	return runId;
}

/**
 * Start (or restart) all time-based triggers for a single routine. Idempotent:
 * any existing timers for this id are cleared first. Hook triggers are
 * skipped — they are armed via `pi.on(...)` subscriptions in `hooks.ts`.
 */
export function scheduleRoutine(
	routine: Routine,
	runtime: RoutineRuntimeState,
	pi: ExtensionAPI,
	getCtx: () => ExtensionContext | null,
): void {
	unscheduleRoutine(routine.id, runtime);

	const handles: Array<ReturnType<typeof setInterval> | null> = [];
	routine.triggers.forEach((trigger, idx) => {
		const h = armTrigger(routine, idx, trigger, runtime, pi, getCtx);
		handles.push(h);
	});
	if (handles.some((h) => h !== null)) {
		runtime.timers.set(routine.id, handles);
	}
}

function armTrigger(
	routine: Routine,
	triggerIndex: number,
	trigger: RoutineTrigger,
	runtime: RoutineRuntimeState,
	pi: ExtensionAPI,
	getCtx: () => ExtensionContext | null,
): ReturnType<typeof setInterval> | null {
	const onFire = () => onTriggerFire(routine, triggerIndex, runtime, pi, getCtx);

	switch (trigger.kind) {
		case "pulse":
			return setInterval(onFire, trigger.intervalMs);
		case "cron": {
			const arm = () => {
				try {
					const next = nextCronFire(trigger.expr, trigger.timezone, new Date());
					const delay = Math.max(0, next.getTime() - Date.now());
					const h = setTimeout(() => {
						onFire();
						// Re-arm only if routine is still active.
						if (runtime.store.routines[routine.id]) arm();
					}, delay);
					const arr = runtime.timers.get(routine.id);
					if (arr) arr[triggerIndex] = h as unknown as ReturnType<typeof setInterval>;
				} catch (err) {
					console.error(
						`[pi-routines] cron arm failed for '${routine.name}' [${trigger.expr}]:`,
						err,
					);
				}
			};
			try {
				const next = nextCronFire(trigger.expr, trigger.timezone, new Date());
				const delay = Math.max(0, next.getTime() - Date.now());
				return setTimeout(() => {
					onFire();
					if (runtime.store.routines[routine.id]) arm();
				}, delay) as unknown as ReturnType<typeof setInterval>;
			} catch (err) {
				console.error(`[pi-routines] cron parse failed for '${routine.name}':`, err);
				return null;
			}
		}
		case "oneoff": {
			// Spent — silently skip. The post-fire callback below sets this.
			if (trigger.fired) return null;
			let at: Date;
			try {
				at = parseOneOff(trigger.fireAtIso, trigger.timezone);
			} catch (err) {
				// Past timestamp (e.g. a one-off that fired in a previous
				// session before we wrote `fired: true`, or one whose
				// schedule was set in the past to begin with). Mark it
				// spent so we don't log on every reload, and persist.
				const msg = err instanceof Error ? err.message : String(err);
				if (msg.includes("in the past")) {
					trigger.fired = true;
					void saveStore(runtime.store, runtime.storeGeneration);
				} else {
					console.warn(`[pi-routines] one-off arm failed for '${routine.name}':`, err);
				}
				return null;
			}
			const delay = Math.max(0, at.getTime() - Date.now());
			return setTimeout(() => {
				onFire();
				// Mark spent and persist so /reload doesn't re-arm.
				trigger.fired = true;
				void saveStore(runtime.store, runtime.storeGeneration);
				const arr = runtime.timers.get(routine.id);
				if (arr) arr[triggerIndex] = null;
			}, delay) as unknown as ReturnType<typeof setInterval>;
		}
		case "hook":
			return null; // armed by hooks.ts
		case "github":
			return armGithubPoller(routine, triggerIndex, runtime, pi, getCtx);
		case "api":
			return null; // armed by the HTTP server (src/server.ts)
	}
}

function onTriggerFire(
	routine: Routine,
	triggerIndex: number,
	runtime: RoutineRuntimeState,
	pi: ExtensionAPI,
	getCtx: () => ExtensionContext | null,
): void {
	try {
		enqueueTriggerFire(routine, triggerIndex, runtime, pi, getCtx);
	} catch (err) {
		if (isStaleCtxError(err)) {
			unscheduleRoutine(routine.id, runtime);
			console.warn(`[pi-routines] scheduler: stale ctx, stopping '${routine.name}'`);
			return;
		}
		console.error(`[pi-routines] scheduler tick '${routine.name}' failed:`, err);
	}
}

/**
 * Shared enqueue path. Used by the time-based scheduler and by the GitHub
 * poller (TP-011). Performs: existence check, multi-trigger collapse,
 * dedup-vs-queued, backpressure trim, triggerOrigin record, push, drain.
 *
 * Throws on stale ctx; callers should treat that as a teardown signal.
 */
export function enqueueTriggerFire(
	routine: Routine,
	triggerIndex: number,
	runtime: RoutineRuntimeState,
	pi: ExtensionAPI,
	getCtx: () => ExtensionContext | null,
): void {
	const live = runtime.store.routines[routine.id];
	if (!live) {
		unscheduleRoutine(routine.id, runtime);
		return;
	}

	// Paused routines silently drop scheduled / api / github fires. Manual
	// fires (/routine-run-now) bypass this path entirely. We still consume
	// the trigger origin marker so the next fire isn't tagged with stale
	// metadata.
	if (live.paused) {
		const trigger = live.triggers[triggerIndex];
		if (trigger) {
			recordSkippedFire(
				runtime,
				runtime.store,
				live,
				{ index: triggerIndex, kind: trigger.kind },
				"paused",
			);
		}
		runtime.triggerOrigin.delete(routine.id);
		return;
	}

	const now = Date.now();
	const enq = getEnqueueMap(runtime);
	const last = enq.get(routine.id) ?? 0;
	const trigger = live.triggers[triggerIndex];
	if (!trigger) return;
	if (now - last < MULTI_TRIGGER_COLLAPSE_MS) {
		recordSkippedFire(
			runtime,
			runtime.store,
			live,
			{ index: triggerIndex, kind: trigger.kind },
			"collapsed duplicate trigger",
		);
		return;
	}
	enq.set(routine.id, now);

	if (queueHasRoutine(runtime, routine.id)) {
		recordSkippedFire(
			runtime,
			runtime.store,
			live,
			{ index: triggerIndex, kind: trigger.kind },
			"routine already queued",
		);
		return;
	}

	enqueueRoutineFire(live, { index: triggerIndex, kind: trigger.kind }, runtime, pi, getCtx);
}

/**
 * Enqueue a specific fire with per-fire payload. Unlike `enqueueTriggerFire`,
 * this can queue multiple entries for the same routine, matching Claude-style
 * API/GitHub behavior where each matching event is its own run.
 */
export function enqueueFireRequest(
	routine: Routine,
	triggerIndex: number,
	runtime: RoutineRuntimeState,
	pi: ExtensionAPI,
	getCtx: () => ExtensionContext | null,
	payload: QueueMetadata = {},
): string | null {
	const live = runtime.store.routines[routine.id];
	if (!live) {
		unscheduleRoutine(routine.id, runtime);
		return null;
	}
	const trigger = live.triggers[triggerIndex];
	if (!trigger) return null;
	const origin = { index: triggerIndex, kind: trigger.kind };
	if (live.paused) {
		const runId = payload.runId ?? nanoid();
		recordSkippedFire(runtime, runtime.store, live, origin, "paused", runId);
		return runId;
	}
	return enqueueRoutineFire(live, origin, runtime, pi, getCtx, payload);
}

/** Clear all timers for a single routine. Safe to call if none exist. */
export function unscheduleRoutine(routineId: string, runtime: RoutineRuntimeState): void {
	const handles = runtime.timers.get(routineId);
	if (handles) {
		for (const h of handles) {
			if (h) {
				clearTimeout(h as unknown as NodeJS.Timeout);
				clearInterval(h);
			}
		}
	}
	runtime.timers.delete(routineId);
}

/**
 * Drain queued routine ids while the session is idle. Stops at the first
 * not-idle indicator (busy ctx, pending messages, in-flight routine turn).
 */
export async function drainQueue(
	runtime: RoutineRuntimeState,
	pi: ExtensionAPI,
	getCtx: () => ExtensionContext | null,
): Promise<void> {
	while (runtime.queue.length > 0) {
		let ctx: ExtensionContext | null;
		try {
			ctx = getCtx();
		} catch (err) {
			if (isStaleCtxError(err)) {
				console.warn(`[pi-routines] drainQueue: stale ctx; stopping all timers`);
				stopScheduler(runtime, "stale extension context");
				return;
			}
			throw err;
		}
		if (!ctx) return;
		if (guard.isRoutineTurnActive(runtime)) return;
		if (!ctx.isIdle()) return;
		if (ctx.hasPendingMessages()) return;

		const entry = runtime.queue.shift();
		if (!entry) return;
		const id = queueEntryRoutineId(entry);
		const routine = runtime.store.routines[id];
		if (!routine) {
			if (entry.deferredHookId) {
				runtime.store.deferredHooks = runtime.store.deferredHooks.filter(
					(item) => item.id !== entry.deferredHookId,
				);
				await saveStore(runtime.store, runtime.storeGeneration);
			}
			continue;
		}

		// Belt-and-braces pause gate. The primary gate is at enqueue
		// (`enqueueTriggerFire`) and at hook pick (`pickHookRoutines`), but a
		// routine may be paused AFTER it was queued: e.g. user pauses while
		// another routine is mid-turn. Manual fires (origin.kind === "manual")
		// are the explicit override path and ignore the flag.
		if (routine.paused) {
			if (entry.origin.kind !== "manual") {
				runtime.apiArgs?.delete(id);
				if (entry.deferredHookId) {
					runtime.store.deferredHooks = runtime.store.deferredHooks.filter(
						(item) => item.id !== entry.deferredHookId,
					);
				}
				recordSkippedFire(runtime, runtime.store, routine, entry.origin, "paused", entry.runId);
				continue;
			}
		}

		runtime.lastUiCtx = ctx;
		await fireRoutine(routine, runtime, runtime.store, pi, ctx, entry);
	}
}

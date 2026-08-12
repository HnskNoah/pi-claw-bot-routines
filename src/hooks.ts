/**
 * @file hooks.ts — pi lifecycle subscribers that drive the routine lifecycle.
 *
 * Owns:
 *   - `session_start` — load persisted store, schedule pulse routines, fire
 *     applicable `session_start` hook routines, refresh the widget.
 *   - `agent_end` — release the recursion guard if a routine turn just
 *     finished, drain any queued pulses, and (only on user-driven turns)
 *     fire AT MOST ONE applicable `agent_end` hook routine.
 *   - `session_shutdown` — stop timers, run shutdown hooks (only on `"quit"`,
 *     never on `"reload"`), persist the store, clear the widget.
 *   - `input` — belt-and-suspenders tracker for input events tagged
 *     `source: "extension"` while a routine turn is in flight, so reviewers
 *     can see the recursion-guard path in the log.
 *
 * Does NOT own:
 *   - Timer plumbing — that's `scheduler.ts`.
 *   - Prompt build / `sendUserMessage` — that's `executor.ts` (via
 *     `drainQueue`).
 *   - Silent-token suppression — that's `suppressor.ts` (TP-003).
 *   - Hot-reload `globalThis` cleanup — that's `extensions/index.ts` (TP-006).
 *
 * The guard contract: `fireRoutine` calls `acquireRoutineTurn` before
 * `sendUserMessage`. The very next `agent_end` releases it here. If
 * `agent_end` arrives with the flag clear, the turn was user-driven and
 * (subject to once-semantics) we may fire ONE hook routine.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { nanoid } from "nanoid";
import { recordRun, recordSkippedFire } from "./executor.ts";
import * as guard from "./guard.ts";
import { drainQueue, enqueueRoutineFire, scheduleRoutine, stopScheduler } from "./scheduler.ts";
import { restartServerIfConfigured } from "./server.ts";
import { loadStore, saveStore } from "./store.ts";
import type { HookTrigger, Routine, RoutineRuntimeState } from "./types.ts";
import {
	MAX_DEFERRED_AGE_MS,
	MAX_DEFERRED_HOOKS,
	MAX_DEFERRED_TRANSCRIPT_BYTES,
	MAX_QUEUE_DEPTH,
} from "./types.ts";
import { clearWidget, restartWidgetRefresh, stopWidgetRefresh, updateWidget } from "./widget.ts";

/**
 * Register the three lifecycle handlers (`session_start`, `agent_end`,
 * `session_shutdown`). Call exactly once per extension load.
 *
 * @param setCtx Called whenever a new `ExtensionContext` is observed
 * (`session_start`, `agent_end`). The extension entry point uses this to
 * update its `currentCtx` so `getCtx()` returns a live reference for the
 * scheduler / widget refresh interval.
 */
export function registerHooks(
	pi: ExtensionAPI,
	runtime: RoutineRuntimeState,
	getCtx: () => ExtensionContext | null,
	setCtx: (ctx: ExtensionContext) => void,
): void {
	pi.on("session_start", async (event, ctx) => {
		setCtx(ctx);
		runtime.lastUiCtx = ctx;

		// Reset guard state — a fresh session never inherits in-flight flags.
		guard.releaseRoutineTurn(runtime);
		if (event.reason !== "reload") {
			guard.resetSessionHookFires(runtime);
		}

		// Reload the persisted store. Any queue on this runtime cannot survive
		// the session transition and is recorded before being cleared.
		stopScheduler(runtime, event.reason === "reload" ? "reload" : "session restart");
		stopWidgetRefresh(runtime);
		runtime.store = await loadStore(runtime.storeGeneration);
		pruneExpiredDeferredHooks(runtime);
		runtime.triggerOrigin.clear();
		runtime.apiArgs?.clear();
		runtime.pendingRun = null;

		// Print mode: register-only path. No timers, no widget, no hook fires.
		if (!ctx.hasUI) return;
		try {
			await restartServerIfConfigured(runtime, { pi, getCtx });
		} catch (err) {
			console.error("[pi-routines] could not restart API server after reload:", err);
		}

		// Re-arm timers for every routine; scheduler decides per trigger.
		for (const routine of Object.values(runtime.store.routines)) {
			try {
				scheduleRoutine(routine, runtime, pi, getCtx);
			} catch (err) {
				console.error(`[pi-routines] could not schedule '${routine.name}':`, err);
			}
		}
		restartWidgetRefresh(runtime, getCtx);

		// Shutdown hooks cannot run during teardown, so real quits persist a
		// bounded snapshot and replay it at the next interactive session.
		if (event.reason !== "reload") {
			promoteDeferredHooks(runtime, pi, getCtx);
		}

		// Queue applicable session_start hook routines. They drain through the
		// normal FIFO path so multiple hooks do not fight the active-turn guard.
		const isReload = event.reason === "reload";
		for (const { routine, trigger, index } of pickHookRoutines(runtime, "session_start")) {
			// On reload, suppress per_session hooks — the session continues.
			if (isReload && trigger.once === "per_session") {
				continue;
			}
			enqueueHookFire(runtime, routine, trigger, index, pi, getCtx);
		}
		try {
			await drainQueue(runtime, pi, getCtx);
		} catch (err) {
			console.error(`[pi-routines] session_start hook drain failed:`, err);
		}

		updateWidget(runtime, ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		setCtx(ctx);
		runtime.lastUiCtx = ctx;

		// Snapshot BEFORE release: was this turn driven by a routine?
		const wasRoutineTurn = guard.isRoutineTurnActive(runtime);
		if (wasRoutineTurn) {
			guard.releaseRoutineTurn(runtime);
		}

		// Finalise pending run record from the routine turn that just ended.
		if (wasRoutineTurn && runtime.pendingRun) {
			const pr = runtime.pendingRun;
			const endedAt = Date.now();
			recordRun(runtime, runtime.store, {
				id: pr.runId,
				routineId: pr.routineId,
				startedAt: pr.startedAt,
				endedAt,
				durationMs: endedAt - pr.startedAt,
				status: pr.status,
				triggerIndex: pr.triggerIndex,
				triggerKind: pr.triggerKind,
				snippet: pr.snippet,
			});
			runtime.pendingRun = null;
		}

		// Fill any capacity left by the completed turn with persisted deferred
		// shutdown hooks before scheduled work.
		if (ctx.hasUI) promoteDeferredHooks(runtime, pi, getCtx);

		// Always drain — newly idle ctx may unblock queued pulse routines.
		try {
			await drainQueue(runtime, pi, getCtx);
		} catch (err) {
			console.error(`[pi-routines] drainQueue on agent_end failed:`, err);
		}

		// Fire AT MOST ONE agent_end hook — but ONLY on user-driven turns.
		// Routine-driven turns must never chain into another routine to avoid
		// runaway feedback loops.
		if (!wasRoutineTurn && ctx.hasUI && !guard.isRoutineTurnActive(runtime)) {
			for (const { routine, trigger, index } of pickHookRoutines(runtime, "agent_end")) {
				if (!enqueueHookFire(runtime, routine, trigger, index, pi, getCtx)) continue;
				await drainHookQueue(runtime, pi, getCtx, "agent_end");
				break; // hard cap: one per turn
			}
		}

		if (ctx.hasUI) updateWidget(runtime, ctx);
	});

	pi.on("session_shutdown", async (event) => {
		const ctx = getCtx();

		// No queued LLM turn can safely outlive this event: Pi disposes the
		// session immediately after handlers return.
		stopScheduler(runtime, `session shutdown: ${event.reason}`);
		stopWidgetRefresh(runtime);

		// Finalise a turn that is being interrupted by teardown. This prevents
		// stale pending records and a guard that can be misclassified later.
		if (runtime.pendingRun) {
			const pending = runtime.pendingRun;
			const endedAt = Date.now();
			recordRun(runtime, runtime.store, {
				id: pending.runId,
				routineId: pending.routineId,
				startedAt: pending.startedAt,
				endedAt,
				durationMs: endedAt - pending.startedAt,
				status: "error",
				triggerIndex: pending.triggerIndex,
				triggerKind: pending.triggerKind,
				snippet: `Interrupted by session shutdown (${event.reason})`,
			});
			runtime.pendingRun = null;
		}
		guard.releaseRoutineTurn(runtime);

		// A real interactive quit captures shutdown hooks for reliable replay.
		// Reload/session-replacement events are cleanup only.
		if (event.reason === "quit" && ctx?.hasUI) {
			captureDeferredShutdownHooks(runtime, ctx);
		}
		await saveStore(runtime.store, runtime.storeGeneration);

		if (ctx) clearWidget(ctx);
		if (event.reason === "quit") {
			guard.resetSessionHookFires(runtime);
		}
	});
}

/**
 * Belt-and-suspenders observer for `input` events. The recursion guard's
 * authoritative signal is `runtime.isRoutineTurnActive`; this handler exists
 * purely so the path is visible in logs when an `extension`-sourced input
 * arrives while a routine turn is in flight.
 *
 * Returns nothing (lets the input continue unchanged).
 */
export function registerInputTracker(pi: ExtensionAPI, runtime: RoutineRuntimeState): void {
	pi.on("input", (event) => {
		if (event.source === "extension" && guard.isRoutineTurnActive(runtime)) {
			console.error(
				`[pi-routines] extension input under active routine guard ('${runtime.activeRoutineName ?? "?"}')`,
			);
		}
		return { action: "continue" };
	});
}

// ─── internals ───────────────────────────────────────────────────────────────

function pickHookRoutines(
	runtime: RoutineRuntimeState,
	event: "session_start" | "agent_end" | "session_shutdown",
): Array<{ routine: Routine; trigger: HookTrigger; index: number }> {
	const out: Array<{ routine: Routine; trigger: HookTrigger; index: number }> = [];
	for (const routine of Object.values(runtime.store.routines)) {
		for (let i = 0; i < routine.triggers.length; i++) {
			const trigger = routine.triggers[i];
			if (trigger && trigger.kind === "hook" && trigger.event === event) {
				if (routine.paused) {
					recordSkippedFire(runtime, runtime.store, routine, { index: i, kind: "hook" }, "paused");
					break;
				}
				out.push({ routine, trigger, index: i });
				break; // one entry per routine per event
			}
		}
	}
	return out;
}

function prepareHookFire(
	runtime: RoutineRuntimeState,
	routine: Routine,
	trigger: HookTrigger,
	index: number,
): boolean {
	const key = guard.hookFireKey(routine.id, trigger.event, index);
	if (!guard.shouldFireHook(trigger, runtime.store.tickState[routine.id], runtime, key)) {
		return false;
	}
	return true;
}

function enqueueHookFire(
	runtime: RoutineRuntimeState,
	routine: Routine,
	trigger: HookTrigger,
	index: number,
	pi: ExtensionAPI,
	getCtx: () => ExtensionContext | null,
): boolean {
	if (!prepareHookFire(runtime, routine, trigger, index)) return false;
	const key = guard.hookFireKey(routine.id, trigger.event, index);
	if (runtime.queue.length >= MAX_QUEUE_DEPTH) {
		recordSkippedFire(runtime, runtime.store, routine, { index, kind: "hook" }, "queue overflow");
		return false;
	}
	enqueueRoutineFire(routine, { index, kind: "hook" }, runtime, pi, getCtx, {
		hookOnceKey: key,
		hookOnce: trigger.once,
		autoDrain: false,
	});
	return true;
}

function ensureTickState(runtime: RoutineRuntimeState, routineId: string) {
	let tickState = runtime.store.tickState[routineId];
	if (!tickState) {
		tickState = {
			tickCount: 0,
			lastFiredAt: 0,
			lastFiredDateLocal: "",
			userState: {},
		};
		runtime.store.tickState[routineId] = tickState;
	}
	return tickState;
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(block): block is { type: "text"; text: string } =>
				Boolean(block) &&
				typeof block === "object" &&
				(block as { type?: unknown }).type === "text" &&
				typeof (block as { text?: unknown }).text === "string",
		)
		.map((block) => block.text)
		.join("\n");
}

function captureTranscript(ctx: ExtensionContext): { text: string; truncated: boolean } {
	const lines: string[] = [];
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		const role = String(entry.message.role ?? "message");
		const text = textFromContent((entry.message as { content?: unknown }).content).trim();
		if (text) lines.push(`${role.toUpperCase()}:\n${text}`);
	}
	const encoded = Buffer.from(lines.join("\n\n"), "utf8");
	if (encoded.length <= MAX_DEFERRED_TRANSCRIPT_BYTES) {
		return { text: encoded.toString("utf8"), truncated: false };
	}
	let text = encoded.subarray(encoded.length - MAX_DEFERRED_TRANSCRIPT_BYTES).toString("utf8");
	if (text.startsWith("\uFFFD")) text = text.slice(1);
	return { text, truncated: true };
}

function captureDeferredShutdownHooks(runtime: RoutineRuntimeState, ctx: ExtensionContext): void {
	const endedSessionId = ctx.sessionManager.getSessionId();
	const now = new Date();
	const endedDateLocal = now.toLocaleDateString("en-CA");
	const endedTimeLocal = now.toLocaleTimeString();
	const transcript = captureTranscript(ctx);

	for (const { routine, trigger, index } of pickHookRoutines(runtime, "session_shutdown")) {
		if (!prepareHookFire(runtime, routine, trigger, index)) continue;
		const duplicate = runtime.store.deferredHooks.some(
			(item) =>
				item.endedSessionId === endedSessionId &&
				item.routineId === routine.id &&
				item.triggerIndex === index,
		);
		if (duplicate) continue;
		const superseded = runtime.store.deferredHooks.filter(
			(item) => item.routineId === routine.id && item.triggerIndex === index,
		);
		for (const _item of superseded) {
			recordSkippedFire(
				runtime,
				runtime.store,
				routine,
				{ index, kind: "hook" },
				"superseded deferred shutdown hook",
			);
		}
		if (superseded.length > 0) {
			const supersededIds = new Set(superseded.map((item) => item.id));
			runtime.store.deferredHooks = runtime.store.deferredHooks.filter(
				(item) => !supersededIds.has(item.id),
			);
		}

		while (runtime.store.deferredHooks.length >= MAX_DEFERRED_HOOKS) {
			const dropped = runtime.store.deferredHooks.shift();
			const droppedRoutine = dropped ? runtime.store.routines[dropped.routineId] : undefined;
			if (dropped && droppedRoutine) {
				recordSkippedFire(
					runtime,
					runtime.store,
					droppedRoutine,
					{ index: dropped.triggerIndex, kind: "hook" },
					"deferred hook overflow",
				);
			}
		}

		runtime.store.deferredHooks.push({
			id: nanoid(),
			routineId: routine.id,
			triggerIndex: index,
			endedSessionId,
			deferredAt: now.getTime(),
			endedSessionCwd: ctx.cwd,
			endedDateLocal,
			endedTimeLocal,
			transcript: transcript.text,
			...(transcript.truncated ? { transcriptTruncated: true } : {}),
		});
		const key = guard.hookFireKey(routine.id, trigger.event, index);
		guard.commitHookFire(
			trigger,
			ensureTickState(runtime, routine.id),
			runtime,
			key,
			endedDateLocal,
		);
	}
}

function deferredContextNote(item: RoutineRuntimeState["store"]["deferredHooks"][number]): string {
	const truncation = item.transcriptTruncated ? "\n[earlier transcript content truncated]" : "";
	return (
		`Deferred session-shutdown context: the previous session ended on ` +
		`${item.endedDateLocal} at ${item.endedTimeLocal} in ${item.endedSessionCwd}.` +
		`${truncation}\n\nPrevious session transcript:\n${item.transcript || "(no text messages captured)"}`
	);
}

function pruneExpiredDeferredHooks(runtime: RoutineRuntimeState): void {
	const cutoff = Date.now() - MAX_DEFERRED_AGE_MS;
	const expired = runtime.store.deferredHooks.filter((item) => item.deferredAt < cutoff);
	if (expired.length === 0) return;
	const expiredIds = new Set(expired.map((item) => item.id));
	runtime.store.deferredHooks = runtime.store.deferredHooks.filter(
		(item) => !expiredIds.has(item.id),
	);
	for (const item of expired) {
		const routine = runtime.store.routines[item.routineId];
		if (routine) {
			recordSkippedFire(
				runtime,
				runtime.store,
				routine,
				{ index: item.triggerIndex, kind: "hook" },
				"deferred shutdown hook expired",
			);
		}
	}
	void saveStore(runtime.store, runtime.storeGeneration);
}

function promoteDeferredHooks(
	runtime: RoutineRuntimeState,
	pi: ExtensionAPI,
	getCtx: () => ExtensionContext | null,
): void {
	let changed = false;
	const queued = new Set(
		runtime.queue.map((entry) => entry.deferredHookId).filter((id): id is string => Boolean(id)),
	);
	if (runtime.pendingRun?.deferredHookId) queued.add(runtime.pendingRun.deferredHookId);

	for (const item of [...runtime.store.deferredHooks]) {
		if (runtime.queue.length >= MAX_QUEUE_DEPTH) break;
		if (queued.has(item.id)) continue;
		const routine = runtime.store.routines[item.routineId];
		const trigger = routine?.triggers[item.triggerIndex];
		if (!routine || !trigger || trigger.kind !== "hook" || trigger.event !== "session_shutdown") {
			runtime.store.deferredHooks = runtime.store.deferredHooks.filter(
				(candidate) => candidate.id !== item.id,
			);
			if (routine) {
				recordSkippedFire(
					runtime,
					runtime.store,
					routine,
					{ index: item.triggerIndex, kind: "hook" },
					"stale deferred shutdown hook",
				);
			}
			changed = true;
			continue;
		}
		if (routine.paused) {
			runtime.store.deferredHooks = runtime.store.deferredHooks.filter(
				(candidate) => candidate.id !== item.id,
			);
			changed = true;
			recordSkippedFire(
				runtime,
				runtime.store,
				routine,
				{ index: item.triggerIndex, kind: "hook" },
				"paused deferred shutdown hook",
			);
			continue;
		}
		enqueueRoutineFire(routine, { index: item.triggerIndex, kind: "hook" }, runtime, pi, getCtx, {
			contextNote: deferredContextNote(item),
			deferredHookId: item.id,
			autoDrain: false,
			priority: true,
		});
		queued.add(item.id);
	}
	if (changed) void saveStore(runtime.store, runtime.storeGeneration);
}

async function drainHookQueue(
	runtime: RoutineRuntimeState,
	pi: ExtensionAPI,
	getCtx: () => ExtensionContext | null,
	event: HookTrigger["event"],
): Promise<void> {
	try {
		await drainQueue(runtime, pi, getCtx);
	} catch (err) {
		console.error(`[pi-routines] ${event} hook drain failed:`, err);
	}
}

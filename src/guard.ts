/**
 * @file guard.ts — recursion-prevention primitives for routine firing.
 *
 * Routines that respond to lifecycle events (notably `agent_end`) can form
 * feedback loops: a routine fires → sends a message → agent_end fires →
 * routine fires again. This module provides the pure helpers that
 * `hooks.ts` / `executor.ts` (downstream tasks) wire together to make a
 * three-level guard:
 *
 *   1. **Flag guard** — {@link acquireRoutineTurn} / {@link releaseRoutineTurn}
 *      / {@link isRoutineTurnActive} flip a single boolean on the runtime
 *      state. Hook handlers MUST consult {@link isRoutineTurnActive} and skip
 *      when it's true.
 *   2. **Input-source tagging** — `hooks.ts` tags `input` events whose source
 *      is `"extension"` while the flag is set, so subsequent `agent_end`
 *      handlers can recognize "this turn was our own routine" and not
 *      re-trigger.
 *   3. **Depth check** — {@link acquireRoutineTurn} throws if the flag is
 *      already true, surfacing programmer errors. A well-behaved sequential
 *      queue never trips this.
 *
 * This module owns NO event subscriptions and performs no I/O.
 */

import type { HookTrigger, RoutineRuntimeState, RoutineTickState } from "./types.ts";

/**
 * Mark the runtime as actively executing a routine turn.
 *
 * @throws Error if a routine turn is already active. The scheduler queue is
 * sequential by construction, so this should never fire in normal operation;
 * a throw indicates a bug in the executor or a missed release.
 */
export function acquireRoutineTurn(runtime: RoutineRuntimeState, routineName: string): void {
	if (runtime.isRoutineTurnActive) {
		throw new Error(
			`acquireRoutineTurn: turn already active for '${runtime.activeRoutineName ?? "?"}'`,
		);
	}
	runtime.isRoutineTurnActive = true;
	runtime.activeRoutineName = routineName;
}

/**
 * Release a previously-acquired routine turn. Idempotent: safe to call from
 * a `finally` block even if the turn was never acquired.
 */
export function releaseRoutineTurn(runtime: RoutineRuntimeState): void {
	runtime.isRoutineTurnActive = false;
	runtime.activeRoutineName = null;
}

/** True if a routine turn is currently in flight. */
export function isRoutineTurnActive(runtime: RoutineRuntimeState): boolean {
	return runtime.isRoutineTurnActive;
}

/** Stable key for a hook trigger's per-session fire marker. */
export function hookFireKey(
	routineId: string,
	event: HookTrigger["event"],
	triggerIndex: number,
): string {
	return `${routineId}:${event}:${triggerIndex}`;
}

/** Clear all per-session hook markers for a fresh pi session. */
export function resetSessionHookFires(runtime: RoutineRuntimeState): void {
	getSessionHookFires(runtime).clear();
}

/** Mark a per-session hook as successfully started in this session. */
export function markSessionHookFired(runtime: RoutineRuntimeState, key: string): void {
	getSessionHookFires(runtime).add(key);
}

/** Commit a hook's once-marker after a successful start (or durable deferral). */
export function commitHookFire(
	trigger: HookTrigger,
	tickState: RoutineTickState,
	runtime: RoutineRuntimeState,
	key: string,
	dateLocal = new Date().toLocaleDateString("en-CA"),
): void {
	if (trigger.once === "per_session") {
		markSessionHookFired(runtime, key);
	} else if (trigger.once === "daily") {
		tickState.hookOnceDaily ??= {};
		tickState.hookOnceDaily[key] = dateLocal;
	}
}

function getSessionHookFires(runtime: RoutineRuntimeState): Set<string> {
	if (!runtime.sessionHookFires) runtime.sessionHookFires = new Set();
	return runtime.sessionHookFires;
}

/**
 * Decide whether a hook routine should fire on the current event.
 *
 * Implements the {@link Routine.trigger.once} semantics:
 *   - `"daily"`       — fire at most once per local calendar day. Compares
 *                       today's `YYYY-MM-DD` (via `toLocaleDateString("en-CA")`,
 *                       which produces ISO-formatted local dates) against the
 *                       per-trigger `hookOnceDaily` marker.
 *   - `"per_session"` — fire at most once per pi session. This must use
 *                       in-memory runtime state because `tickState` is persisted
 *                       across sessions.
 *   - undefined       — always fire.
 *
 * Pulse routines should not call this — they're driven by setInterval.
 *
 * @param tickState The persisted tick state for this routine, or `undefined`
 *                  if it has never fired.
 * @param runtime   Runtime carrying per-session hook markers.
 * @param sessionKey Stable key for the hook trigger being considered.
 */
export function shouldFireHook(
	trigger: HookTrigger,
	tickState: RoutineTickState | undefined,
	runtime?: RoutineRuntimeState,
	sessionKey?: string,
): boolean {
	const once = trigger.once;
	if (!once) return true;

	if (once === "per_session") {
		if (!runtime || !sessionKey) return false;
		return !getSessionHookFires(runtime).has(sessionKey);
	}
	if (!tickState) return true;
	if (once === "daily") {
		if (!sessionKey) return false;
		const today = new Date().toLocaleDateString("en-CA");
		return tickState.hookOnceDaily?.[sessionKey] !== today;
	}
	return true;
}

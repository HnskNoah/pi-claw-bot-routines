/**
 * @file widget.ts — footer status line summarising active routines.
 *
 * Uses `ctx.ui.setStatus("routines", text)` so the line composes with other
 * extensions' status entries rather than clobbering the footer (which
 * `setFooter` would do). All functions are no-ops when `ctx.hasUI === false`,
 * so print-mode and headless sessions stay clean.
 *
 * Refresh strategy: `updateWidget` is fire-and-forget on each routine
 * lifecycle event. `startWidgetRefresh` adds a low-frequency interval
 * (default 10s) so "next fire in Xm" countdowns drift down smoothly without
 * waking on every second. If no timed routines are active we skip the
 * interval entirely.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Routine, RoutineRuntimeState } from "./types.ts";

const STATUS_KEY = "routines";
const DEFAULT_REFRESH_MS = 10_000;
const MAX_DISPLAYED = 3;
const NAME_MAX_LEN = 12;

/**
 * Recompute the footer status text from `runtime` and publish it via
 * `ctx.ui.setStatus`. No-op when `ctx.hasUI` is false. When no routines are
 * configured, clears the status entry.
 */
export function updateWidget(runtime: RoutineRuntimeState, ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	const routines = Object.values(runtime.store.routines);
	if (routines.length === 0) {
		clearWidget(ctx);
		return;
	}
	const text = formatStatus(routines, runtime);
	ctx.ui.setStatus(STATUS_KEY, text);
}

/**
 * Clear the routines status entry. Safe to call even if it was never set or
 * if there is no UI.
 */
export function clearWidget(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(STATUS_KEY, undefined);
}

/**
 * Start a periodic refresh that calls {@link updateWidget} every
 * `intervalMs` (default 10 000). Used to keep pulse countdowns accurate
 * between explicit lifecycle updates.
 *
 * Returns an idempotent stop function. If no timed routines exist at call
 * time the interval is not started and the returned stop is a no-op — call
 * `startWidgetRefresh` again after creating a pulse routine.
 */
export function startWidgetRefresh(
	runtime: RoutineRuntimeState,
	getCtx: () => ExtensionContext | null,
	intervalMs: number = DEFAULT_REFRESH_MS,
): () => void {
	const hasTimed = Object.values(runtime.store.routines).some((r) =>
		r.triggers.some((t) => t.kind === "pulse" || t.kind === "cron" || t.kind === "oneoff"),
	);
	if (!hasTimed) return () => {};

	const handle = setInterval(() => {
		const ctx = getCtx();
		if (!ctx) return;
		updateWidget(runtime, ctx);
	}, intervalMs);

	let stopped = false;
	return () => {
		if (stopped) return;
		stopped = true;
		clearInterval(handle);
	};
}

/** Restart the periodic refresh loop to match the current store contents. */
export function restartWidgetRefresh(
	runtime: RoutineRuntimeState,
	getCtx: () => ExtensionContext | null,
	intervalMs: number = DEFAULT_REFRESH_MS,
): void {
	stopWidgetRefresh(runtime);
	runtime.stopWidgetRefresh = startWidgetRefresh(runtime, getCtx, intervalMs);
}

/** Stop the periodic refresh loop, if one is active. */
export function stopWidgetRefresh(runtime: RoutineRuntimeState): void {
	if (!runtime.stopWidgetRefresh) return;
	const stop = runtime.stopWidgetRefresh;
	runtime.stopWidgetRefresh = undefined;
	stop();
}

// ─── internals ───────────────────────────────────────────────────────────────

function formatStatus(routines: Routine[], runtime: RoutineRuntimeState): string {
	const head = routines.slice(0, MAX_DISPLAYED);
	const rest = routines.length - head.length;
	const entries = head.map((r) => `${truncateName(r.name)}(${tag(r, runtime)})`);
	const tail = rest > 0 ? `  +${rest} more` : "";
	return `↺ ${routines.length} active  ${entries.join(" · ")}${tail}`;
}

function lastRunGlyph(runtime: RoutineRuntimeState, routineId: string): string {
	const runs = runtime.store.tickState[routineId]?.runs;
	if (!runs || runs.length === 0) return "";
	const last = runs[runs.length - 1];
	switch (last?.status) {
		case "success":
			return "✓";
		case "error":
			return "✗";
		case "silent":
			return "~";
		case "skipped":
			return "—";
		default:
			return "";
	}
}

function tag(routine: Routine, runtime: RoutineRuntimeState): string {
	const primary = routine.triggers[0];
	const glyph = lastRunGlyph(runtime, routine.id);
	const suffix = glyph ? ` ${glyph}` : "";
	if (routine.paused) return `paused${suffix}`;
	if (!primary) return `-${suffix}`;
	if (primary.kind === "hook") return `${primary.event}${suffix}`;
	if (primary.kind === "cron") return `cron${suffix}`;
	if (primary.kind === "oneoff") return `1x${suffix}`;
	if (primary.kind === "api") return `api${suffix}`;
	if (primary.kind === "github") return `gh${suffix}`;
	const tickState = runtime.store.tickState[routine.id];
	if (routine.quiet) {
		return `q·${tickState?.tickCount ?? 0}${suffix}`;
	}
	const minutes = minutesUntilNext(routine, tickState?.lastFiredAt);
	return `${minutes}m${suffix}`;
}

function minutesUntilNext(routine: Routine, lastFiredAt: number | undefined): number {
	const primary = routine.triggers[0];
	if (!primary || primary.kind !== "pulse") return 0;
	const interval = primary.intervalMs;
	const anchor = lastFiredAt ?? routine.createdAt;
	const elapsedInCycle = (Date.now() - anchor) % interval;
	const remainingMs = interval - elapsedInCycle;
	return Math.max(0, Math.ceil(remainingMs / 60_000));
}

function truncateName(name: string): string {
	if (name.length <= NAME_MAX_LEN) return name;
	return `${name.slice(0, NAME_MAX_LEN - 1)}…`;
}

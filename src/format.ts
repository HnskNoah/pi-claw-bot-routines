/**
 * @file format.ts — single source of truth for trigger/routine formatting.
 *
 * All UI surfaces (`/routines`, RoutineList tool, widget, run-history, etc.)
 * format triggers the same way. Previously each consumer carried its own
 * copy of `describeTrigger` / `relativeTime`; this file centralizes them so
 * the wording stays consistent and only one place changes when a new trigger
 * kind is added.
 *
 * Pure module — no I/O, no extension API imports.
 */

import type { RoutineTrigger } from "./types.ts";

/** Compact human description of a single trigger. */
export function describeTrigger(t: RoutineTrigger): string {
	switch (t.kind) {
		case "pulse":
			return `every ${t.intervalHuman}`;
		case "cron":
			return `cron '${t.expr}'${t.timezone ? ` ${t.timezone}` : ""}`;
		case "oneoff":
			return `at ${t.fireAtIso}`;
		case "github":
			return `on github ${t.repo} ${t.event}`;
		case "api":
			return t.allowArgs ? "api (allowArgs)" : "api";
		case "hook":
			return t.once ? `on ${t.event} (${t.once})` : `on ${t.event}`;
	}
}

/** Compact human description for a routine's full trigger set. */
export function describeTriggers(triggers: RoutineTrigger[]): string {
	if (triggers.length === 0) return "(no triggers)";
	return triggers.map(describeTrigger).join(" + ");
}

/**
 * Convert an epoch-ms timestamp to a coarse "N units ago" / "never" string.
 * Used by every list/table surface. `now` is injected to keep tests
 * deterministic.
 */
export function relativeTime(ms: number, now: number = Date.now()): string {
	if (!ms || ms <= 0) return "never";
	const diff = now - ms;
	if (diff < 0) return "in the future";
	const sec = Math.round(diff / 1000);
	if (sec < 60) return `${sec}s ago`;
	const min = Math.round(sec / 60);
	if (min < 60) return `${min} minute${min === 1 ? "" : "s"} ago`;
	const hr = Math.round(min / 60);
	if (hr < 24) return `${hr} hour${hr === 1 ? "" : "s"} ago`;
	const day = Math.round(hr / 24);
	if (day === 1) return "yesterday";
	if (day < 30) return `${day} days ago`;
	return new Date(ms).toISOString().slice(0, 10);
}

/** Short-form variant used inside narrow table cells (`5m ago` vs. `5 minutes ago`). */
export function relativeTimeShort(ms: number, now: number = Date.now()): string {
	if (!ms || ms <= 0) return "never";
	const diff = now - ms;
	if (diff < 0) return "in the future";
	const sec = Math.round(diff / 1000);
	if (sec < 60) return `${sec}s ago`;
	const min = Math.round(sec / 60);
	if (min < 60) return `${min}m ago`;
	const hr = Math.round(min / 60);
	if (hr < 24) return `${hr}h ago`;
	const day = Math.round(hr / 24);
	if (day < 30) return `${day}d ago`;
	return new Date(ms).toISOString().slice(0, 10);
}

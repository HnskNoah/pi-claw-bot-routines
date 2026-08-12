/**
 * @file routine-runs.ts — `/routine-runs <id|name> [--limit N]` slash command.
 *
 * Prints the most recent N run records for a routine as an aligned table:
 *
 *     TIME · TRIGGER · STATUS · DURATION · SNIPPET
 *
 * Default limit is 5; max is `MAX_RUN_HISTORY` (20). Status cells are coloured
 * via ANSI escapes (green=success, red=error, grey=silent/skipped). Empty
 * tickState or zero runs returns the "no runs yet" sentinel.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { listRoutineNames, resolveRoutine } from "../tools/_resolve.ts";
import type { RoutineRun, RoutineRuntimeState } from "../types.ts";
import { MAX_RUN_HISTORY } from "../types.ts";

const SYSTEM_MSG_TYPE = "pi-routines/system";
const DEFAULT_LIMIT = 5;

const ANSI = {
	reset: "\x1b[0m",
	green: "\x1b[32m",
	red: "\x1b[31m",
	grey: "\x1b[90m",
	yellow: "\x1b[33m",
};

function colourStatus(status: RoutineRun["status"]): string {
	switch (status) {
		case "success":
			return `${ANSI.green}\u2713 success${ANSI.reset}`;
		case "error":
			return `${ANSI.red}\u2717 error${ANSI.reset}`;
		case "silent":
			return `${ANSI.grey}~ silent${ANSI.reset}`;
		case "skipped":
			return `${ANSI.yellow}\u2014 skipped${ANSI.reset}`;
	}
}

/** Visible width of a cell, ignoring ANSI escape sequences. */
function visibleLen(s: string): number {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape stripping.
	return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function pad(s: string, width: number): string {
	const pad = width - visibleLen(s);
	return pad > 0 ? s + " ".repeat(pad) : s;
}

function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	const min = Math.floor(ms / 60_000);
	const sec = Math.round((ms % 60_000) / 1000);
	return `${min}m${sec}s`;
}

function formatTime(ms: number): string {
	return new Date(ms).toLocaleTimeString([], {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
}

function describeTrigger(run: RoutineRun): string {
	if (run.triggerKind === "manual") return "manual";
	return `${run.triggerKind}#${run.triggerIndex}`;
}

function parseLimit(args: string): { target: string; limit: number } {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	let limit = DEFAULT_LIMIT;
	const rest: string[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i];
		if (t === "--limit" && tokens[i + 1]) {
			const v = Number.parseInt(tokens[i + 1] ?? "", 10);
			if (Number.isFinite(v) && v > 0) limit = Math.min(v, MAX_RUN_HISTORY);
			i++;
		} else if (t?.startsWith("--limit=")) {
			const v = Number.parseInt(t.slice("--limit=".length), 10);
			if (Number.isFinite(v) && v > 0) limit = Math.min(v, MAX_RUN_HISTORY);
		} else if (t) {
			rest.push(t);
		}
	}
	return { target: rest.join(" "), limit };
}

function formatTable(runs: RoutineRun[]): string {
	const headers = ["TIME", "TRIGGER", "STATUS", "REASON", "DURATION", "SNIPPET"];
	const rows = runs.map((r) => [
		formatTime(r.startedAt),
		describeTrigger(r),
		colourStatus(r.status),
		r.skipReason ?? "",
		formatDuration(r.durationMs),
		r.snippet,
	]);
	const all = [headers, ...rows];
	const widths = headers.map((_, col) => Math.max(...all.map((row) => visibleLen(row[col] ?? ""))));
	const fmt = (row: string[]) =>
		row
			.map((cell, i) => pad(cell ?? "", widths[i] ?? 0))
			.join("  ")
			.trimEnd();
	const lines = [
		fmt(headers),
		fmt(headers.map((_, i) => "-".repeat(widths[i] ?? 0))),
		...rows.map(fmt),
	];
	return lines.join("\n");
}

/** Register `/routine-runs`. */
export function registerRoutineRunsCommand(pi: ExtensionAPI, runtime: RoutineRuntimeState): void {
	pi.registerCommand("routine-runs", {
		description: "Show recent runs of a routine: /routine-runs <id|name> [--limit N]",
		getArgumentCompletions(prefix: string): AutocompleteItem[] {
			const lower = (prefix ?? "").toLowerCase();
			return Object.values(runtime.store.routines)
				.map((r) => r.name)
				.filter((n) => n.toLowerCase().startsWith(lower))
				.sort()
				.map((name) => ({ value: name, label: name }));
		},
		async handler(args: string): Promise<void> {
			const { target, limit } = parseLimit(args);
			if (!target) {
				pi.sendMessage({
					customType: SYSTEM_MSG_TYPE,
					content: "Usage: /routine-runs <id|name> [--limit N]",
					display: true,
				});
				return;
			}
			const routine = resolveRoutine(runtime.store, target, target);
			if (!routine) {
				pi.sendMessage({
					customType: SYSTEM_MSG_TYPE,
					content: `Error: no routine matches '${target}'. Known: ${listRoutineNames(runtime.store)}`,
					display: true,
				});
				return;
			}
			const runs = runtime.store.tickState[routine.id]?.runs ?? [];
			if (runs.length === 0) {
				pi.sendMessage({
					customType: SYSTEM_MSG_TYPE,
					content: `'${routine.name}': no runs yet.`,
					display: true,
				});
				return;
			}
			// Newest last in storage → show newest first, capped at `limit`.
			const recent = runs.slice(-limit).reverse();
			pi.sendMessage({
				customType: SYSTEM_MSG_TYPE,
				content: `Recent runs of '${routine.name}' (showing ${recent.length} of ${runs.length}):\n\n${formatTable(recent)}`,
				display: true,
			});
		},
	});
}

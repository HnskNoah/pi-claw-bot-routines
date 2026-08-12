/**
 * @file routines.ts — `/routines` slash command (no arguments).
 *
 * Lists every active routine as an aligned text table: NAME · TRIGGER ·
 * TICKS · LAST · FLAGS. Empty state nudges the user toward
 * `/routine-install`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describeTriggers, relativeTimeShort } from "../format.ts";
import type { Routine, RoutineRuntimeState } from "../types.ts";

const SYSTEM_MSG_TYPE = "pi-routines/system";

function formatTable(routines: Routine[], runtime: RoutineRuntimeState): string {
	const headers = ["NAME", "TRIGGER", "TICKS", "LAST", "FLAGS"];
	const rows = routines.map((r) => {
		const tick = runtime.store.tickState[r.id];
		const flags = [
			r.paused ? "paused" : "",
			r.quiet ? "quiet" : "",
			r.maxTicks !== undefined ? `max=${r.maxTicks}` : "",
			r.maxRunsPerDay !== undefined ? `day=${r.maxRunsPerDay}` : "",
		]
			.filter(Boolean)
			.join(" ");
		return [
			r.name,
			describeTriggers(r.triggers),
			String(tick?.tickCount ?? 0),
			relativeTimeShort(tick?.lastFiredAt ?? 0),
			flags,
		];
	});
	const all = [headers, ...rows];
	const widths = headers.map((_, col) => Math.max(...all.map((row) => row[col]?.length ?? 0)));
	const fmt = (row: string[]) =>
		row
			.map((cell, i) => (cell ?? "").padEnd(widths[i] ?? 0))
			.join("  ")
			.trimEnd();
	const lines = [
		fmt(headers),
		fmt(headers.map((_, i) => "-".repeat(widths[i] ?? 0))),
		...rows.map(fmt),
	];
	return lines.join("\n");
}

/** Register `/routines` (list all). */
export function registerRoutinesCommand(pi: ExtensionAPI, runtime: RoutineRuntimeState): void {
	pi.registerCommand("routines", {
		description: "List all active routines.",
		async handler(): Promise<void> {
			const sorted = Object.values(runtime.store.routines).sort((a, b) =>
				a.name.localeCompare(b.name),
			);
			const text =
				sorted.length === 0
					? "No active routines. Try `/routine-install ci-watch`."
					: formatTable(sorted, runtime);
			pi.sendMessage({
				customType: SYSTEM_MSG_TYPE,
				content: text,
				display: true,
			});
		},
	});
}

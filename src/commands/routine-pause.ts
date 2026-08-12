/**
 * @file routine-pause.ts — `/routine-pause` and `/routine-resume` slash commands.
 *
 * Pause leaves the routine in the store and keeps its timers armed (so
 * `/reload` doesn't churn them), but every fire path
 * (scheduler.enqueueTriggerFire, hooks.pickHookRoutines, server.handleRequest)
 * short-circuits. `/routine-run-now` ignores the flag — manual override is
 * the whole point of that command.
 *
 * Both commands delegate to `_mutate.setPaused`, so the persistence + state
 * mutation logic stays in one place.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { setPaused } from "../tools/_mutate.ts";
import type { RoutineRuntimeState } from "../types.ts";

const SYSTEM_MSG_TYPE = "pi-routines/system";

function send(pi: ExtensionAPI, text: string): void {
	pi.sendMessage({ customType: SYSTEM_MSG_TYPE, content: text, display: true });
}

function nameCompletions(runtime: RoutineRuntimeState, prefix: string): AutocompleteItem[] {
	const lower = (prefix ?? "").toLowerCase();
	return Object.values(runtime.store.routines)
		.map((r) => r.name)
		.filter((n) => n.toLowerCase().startsWith(lower))
		.sort()
		.map((name) => ({ value: name, label: name }));
}

/** Register `/routine-pause`. */
export function registerRoutinePauseCommand(pi: ExtensionAPI, runtime: RoutineRuntimeState): void {
	pi.registerCommand("routine-pause", {
		description: "Pause a routine without deleting it: /routine-pause <id|name>",
		getArgumentCompletions(prefix: string): AutocompleteItem[] {
			return nameCompletions(runtime, prefix);
		},
		async handler(args: string): Promise<void> {
			const target = args.trim();
			if (!target) {
				send(pi, "Usage: /routine-pause <id|name>");
				return;
			}
			const result = await setPaused(target, true, runtime);
			if ("error" in result) {
				send(pi, `Error: ${result.error}`);
				return;
			}
			send(
				pi,
				result.changed
					? `Paused '${result.name}'. Resume with /routine-resume ${result.name}.`
					: `'${result.name}' was already paused.`,
			);
		},
	});
}

/** Register `/routine-resume`. */
export function registerRoutineResumeCommand(pi: ExtensionAPI, runtime: RoutineRuntimeState): void {
	pi.registerCommand("routine-resume", {
		description: "Resume a paused routine: /routine-resume <id|name>",
		getArgumentCompletions(prefix: string): AutocompleteItem[] {
			return nameCompletions(runtime, prefix);
		},
		async handler(args: string): Promise<void> {
			const target = args.trim();
			if (!target) {
				send(pi, "Usage: /routine-resume <id|name>");
				return;
			}
			const result = await setPaused(target, false, runtime);
			if ("error" in result) {
				send(pi, `Error: ${result.error}`);
				return;
			}
			send(pi, result.changed ? `Resumed '${result.name}'.` : `'${result.name}' was not paused.`);
		},
	});
}

/**
 * @file routine-stop.ts — `/routine-stop <id|name>` slash command.
 *
 * Delegates to `_mutate.deleteRoutine`. Offers tab-completion over the
 * current routine names matching the typed prefix (case-insensitive).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { deleteRoutine } from "../tools/_mutate.ts";
import type { RoutineRuntimeState } from "../types.ts";

const SYSTEM_MSG_TYPE = "pi-routines/system";

/** Register `/routine-stop`. */
export function registerRoutineStopCommand(pi: ExtensionAPI, runtime: RoutineRuntimeState): void {
	pi.registerCommand("routine-stop", {
		description: "Delete a routine by id or name: /routine-stop <id|name>",
		getArgumentCompletions(prefix: string): AutocompleteItem[] {
			const lower = (prefix ?? "").toLowerCase();
			return Object.values(runtime.store.routines)
				.map((r) => r.name)
				.filter((n) => n.toLowerCase().startsWith(lower))
				.sort()
				.map((name) => ({ value: name, label: name }));
		},
		async handler(args: string): Promise<void> {
			const target = args.trim();
			if (!target) {
				pi.sendMessage({
					customType: SYSTEM_MSG_TYPE,
					content: "Usage: /routine-stop <id|name>",
					display: true,
				});
				return;
			}
			const result = await deleteRoutine(target, runtime);
			const text =
				"error" in result ? `Error: ${result.error}` : `Deleted routine '${result.deletedName}'.`;
			pi.sendMessage({
				customType: SYSTEM_MSG_TYPE,
				content: text,
				display: true,
			});
		},
	});
}

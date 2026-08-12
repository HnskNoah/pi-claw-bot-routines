/**
 * @file routine-run-now.ts — `/routine-run-now <id|name>` slash command.
 *
 * Manual-fire path: resolve the routine, refuse if another routine turn is
 * in flight, otherwise tag the trigger origin as `{ index: -1, kind: "manual" }`
 * and enqueue + drain. The scheduler/drainQueue still gates on idle ctx, so
 * the command returns immediately even though firing happens asynchronously.
 *
 * Design choice: rather than extending the `RoutineTrigger` discriminated
 * union with a `"manual"` kind, we use `triggerIndex: -1` + a widened
 * `RoutineRun.triggerKind` literal (`"manual"`). Manual fires are not
 * persisted as routine triggers; they only show up in the run history.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import * as guard from "../guard.ts";
import { drainQueue, enqueueRoutineFire, queueHasRoutine } from "../scheduler.ts";
import { listRoutineNames, resolveRoutine } from "../tools/_resolve.ts";
import type { RoutineRuntimeState } from "../types.ts";

const SYSTEM_MSG_TYPE = "pi-routines/system";

/** Register `/routine-run-now`. */
export function registerRoutineRunNowCommand(
	pi: ExtensionAPI,
	runtime: RoutineRuntimeState,
	getCtx: () => ExtensionContext | null,
): void {
	pi.registerCommand("routine-run-now", {
		description: "Fire a routine immediately: /routine-run-now <id|name>",
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
					content: "Usage: /routine-run-now <id|name>",
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

			if (guard.isRoutineTurnActive(runtime)) {
				pi.sendMessage({
					customType: SYSTEM_MSG_TYPE,
					content: `Error: another routine is running ('${runtime.activeRoutineName ?? "?"}'). Try again in a moment.`,
					display: true,
				});
				return;
			}

			// Dedup: already queued.
			if (queueHasRoutine(runtime, routine.id)) {
				pi.sendMessage({
					customType: SYSTEM_MSG_TYPE,
					content: `'${routine.name}' is already queued; will fire shortly.`,
					display: true,
				});
				return;
			}

			enqueueRoutineFire(routine, { index: -1, kind: "manual" }, runtime, pi, getCtx, {
				autoDrain: false,
			});

			// Manual fires intentionally bypass `routine.paused` — pause is for
			// the automated paths. Inform the user so the behaviour isn't surprising.
			const note = routine.paused ? " (routine is paused; manual fire bypasses the pause)" : "";
			pi.sendMessage({
				customType: SYSTEM_MSG_TYPE,
				content: `Firing '${routine.name}' now…${note}`,
				display: true,
			});

			// Best-effort kickoff. drainQueue gates on idle ctx; we don't await
			// the resulting LLM turn here.
			try {
				await drainQueue(runtime, pi, getCtx);
			} catch (err) {
				console.error(`[pi-routines] manual-fire drain failed for '${routine.name}':`, err);
			}
		},
	});
}

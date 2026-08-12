/**
 * @file schedule.ts — `/schedule <natural language>` slash command (TP-011).
 *
 * Thin wrapper: builds a meta-prompt (see `schedule-nl.ts`), echoes a
 * "parsing..." line, and submits the prompt via `pi.sendUserMessage` so the
 * active session's LLM handles it in-band with `RoutineCreate` available
 * as the relevant tool. The confirmation message comes from `RoutineCreate`
 * itself; cancellation is handled by the existing `/routine-stop` command.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildSchedulePrompt, SCHEDULE_HELP } from "../schedule-nl.ts";

const SYSTEM_MSG_TYPE = "pi-routines/system";

/** Register `/schedule`. */
export function registerScheduleCommand(pi: ExtensionAPI): void {
	pi.registerCommand("schedule", {
		description:
			"Create a routine from a natural-language request — e.g. /schedule every 10m check CI.",
		async handler(args: string): Promise<void> {
			const trimmed = (args ?? "").trim();
			if (!trimmed) {
				pi.sendMessage({
					customType: SYSTEM_MSG_TYPE,
					content: SCHEDULE_HELP,
					display: true,
				});
				return;
			}

			pi.sendMessage({
				customType: SYSTEM_MSG_TYPE,
				content: `Asking the assistant to schedule: "${trimmed}"\n(Use /routine-stop <name> to cancel.)`,
				display: true,
			});

			const prompt = buildSchedulePrompt({ userRequest: trimmed });
			try {
				await pi.sendUserMessage(prompt);
			} catch (err) {
				pi.sendMessage({
					customType: SYSTEM_MSG_TYPE,
					content: `Error: could not submit /schedule request: ${(err as Error).message}`,
					display: true,
				});
			}
		},
	});
}

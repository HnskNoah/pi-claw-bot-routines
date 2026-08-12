/**
 * @file routine-on.ts — `/routine-on <event> <prompt>` slash command.
 *
 * Hook-shorthand: first token is the event (with short aliases
 * start→session_start, end→agent_end, stop→session_shutdown), rest is the
 * prompt. Auto-names from the first three prompt words. Surfaces the
 * agent_end uniqueness error from `_mutate.createRoutine` verbatim.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createRoutine } from "../tools/_mutate.ts";
import type { HookEvent, RoutineRuntimeState } from "../types.ts";

const SYSTEM_MSG_TYPE = "pi-routines/system";

function send(pi: ExtensionAPI, text: string): void {
	pi.sendMessage({
		customType: SYSTEM_MSG_TYPE,
		content: text,
		display: true,
	});
}

const EVENT_ALIASES: Record<string, HookEvent> = {
	start: "session_start",
	session_start: "session_start",
	end: "agent_end",
	agent_end: "agent_end",
	stop: "session_shutdown",
	shutdown: "session_shutdown",
	session_shutdown: "session_shutdown",
};

function autoName(prompt: string, runtime: RoutineRuntimeState): string {
	const words = prompt.trim().split(/\s+/).slice(0, 3).join(" ");
	let base = words
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 32);
	if (base.length === 0) base = "hook";
	const existing = new Set(Object.values(runtime.store.routines).map((r) => r.name));
	if (!existing.has(base)) return base;
	for (let n = 2; n < 1000; n++) {
		const suffix = `-${n}`;
		const candidate = base.slice(0, 32 - suffix.length) + suffix;
		if (!existing.has(candidate)) return candidate;
	}
	return `${base.slice(0, 28)}-${Date.now() % 10000}`;
}

/** Register `/routine-on` (hook-shorthand). */
export function registerRoutineOnCommand(
	pi: ExtensionAPI,
	runtime: RoutineRuntimeState,
	getCtx: () => ExtensionContext | null,
): void {
	pi.registerCommand("routine-on", {
		description: "Create a hook routine: /routine-on <event> <prompt>",
		async handler(args: string): Promise<void> {
			const trimmed = args.trim();
			if (!trimmed) {
				send(
					pi,
					"Usage: /routine-on <event> <prompt>\n" +
						"Events: start (session_start), end (agent_end), stop (session_shutdown)\n" +
						"Example: /routine-on end summarize what I just did",
				);
				return;
			}
			const [first, ...rest] = trimmed.split(/\s+/);
			const event = first ? EVENT_ALIASES[first.toLowerCase()] : undefined;
			if (!event) {
				send(
					pi,
					`Unknown event '${first}'. Use: start, end, stop ` +
						"(aliases for session_start, agent_end, session_shutdown).",
				);
				return;
			}
			const prompt = rest.join(" ").trim();
			if (!prompt) {
				send(
					pi,
					`Provide a prompt after the event. Example: /routine-on ${first} summarize the session.`,
				);
				return;
			}
			const name = autoName(prompt, runtime);
			const result = await createRoutine(
				{
					name,
					prompt,
					trigger: { kind: "hook", event },
					quiet: false,
				},
				runtime,
				pi,
				getCtx,
			);
			if ("error" in result) {
				send(pi, `Error: ${result.error}`);
				return;
			}
			send(pi, `Created hook routine '${result.name}' — fires ${result.triggerDescription}.`);
		},
	});
}

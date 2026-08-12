/**
 * @file routine.ts — `/routine <interval> <prompt>` slash command.
 *
 * Pulse-shorthand: greedily consumes leading tokens until they parse as
 * an interval, then treats the rest as the prompt. Auto-names the routine
 * from the first three prompt words (kebab-cased, max 32 chars), appending
 * `-2`, `-3`, ... on collision. Delegates the actual create to
 * `_mutate.createRoutine`.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseInterval } from "../parser.ts";
import { createRoutine } from "../tools/_mutate.ts";
import type { RoutineRuntimeState } from "../types.ts";

const SYSTEM_MSG_TYPE = "pi-routines/system";

function send(pi: ExtensionAPI, text: string): void {
	pi.sendMessage({
		customType: SYSTEM_MSG_TYPE,
		content: text,
		display: true,
	});
}

/**
 * Slug-ify the first 3 words of `prompt` into a routine name. Lowercase,
 * non-alphanum → '-', collapsed, trimmed, capped at 32 chars. Appends
 * `-N` while colliding with an existing routine name.
 */
function autoName(prompt: string, runtime: RoutineRuntimeState): string {
	const words = prompt.trim().split(/\s+/).slice(0, 3).join(" ");
	let base = words
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 32);
	if (base.length === 0) base = "routine";
	const existing = new Set(Object.values(runtime.store.routines).map((r) => r.name));
	if (!existing.has(base)) return base;
	for (let n = 2; n < 1000; n++) {
		const suffix = `-${n}`;
		const candidate = base.slice(0, 32 - suffix.length) + suffix;
		if (!existing.has(candidate)) return candidate;
	}
	return `${base.slice(0, 28)}-${Date.now() % 10000}`;
}

/**
 * Greedy left-to-right interval split. Returns `{ interval, rest }` where
 * `interval` is the joined prefix that parses, and `rest` is everything
 * after. `null` if no leading token-set parses.
 */
function splitIntervalAndPrompt(args: string): { interval: string; rest: string } | null {
	const tokens = args.trim().split(/\s+/);
	for (let n = 1; n <= tokens.length; n++) {
		const candidate = tokens.slice(0, n).join(" ");
		try {
			parseInterval(candidate);
			return {
				interval: candidate,
				rest: tokens.slice(n).join(" ").trim(),
			};
		} catch {
			// keep extending
		}
	}
	return null;
}

/** Register `/routine` (pulse-shorthand). */
export function registerRoutineCommand(
	pi: ExtensionAPI,
	runtime: RoutineRuntimeState,
	getCtx: () => ExtensionContext | null,
): void {
	pi.registerCommand("routine", {
		description: "Create a pulse routine: /routine <interval> <prompt>",
		async handler(args: string): Promise<void> {
			const trimmed = args.trim();
			if (!trimmed) {
				send(
					pi,
					"Usage: /routine <interval> <prompt>\n" +
						"Example: /routine 5m check CI status and report if it changed",
				);
				return;
			}
			const split = splitIntervalAndPrompt(trimmed);
			if (!split?.rest) {
				send(
					pi,
					"Could not parse an interval from the start of your command.\n" +
						"Usage: /routine <interval> <prompt>\n" +
						"Examples: /routine 5m check CI · /routine 1h30m run tests · /routine 90s ping API",
				);
				return;
			}
			const name = autoName(split.rest, runtime);
			const result = await createRoutine(
				{
					name,
					prompt: split.rest,
					trigger: { kind: "pulse", interval: split.interval },
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
			send(
				pi,
				`Created pulse routine '${result.name}' — fires ${result.triggerDescription}.` +
					(result.nextFireIn ? ` Next fire in ~${result.nextFireIn}.` : ""),
			);
		},
	});
}

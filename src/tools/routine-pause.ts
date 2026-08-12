/**
 * @file routine-pause.ts — LLM-callable `RoutinePause` / `RoutineResume` tools.
 *
 * Both delegate to `_mutate.setPaused`. The LLM uses these from inside a
 * routine prompt when it wants to suspend itself ("CI is red — pause me
 * until I'm told to resume") or pause a sibling routine ("during deploy,
 * pause the pomodoro").
 *
 * Schema mirrors the existing `RoutineDelete` tool: provide either `id` or
 * `name`. Returns the post-call state so the LLM can confirm the flip.
 */

import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type { RoutineRuntimeState } from "../types.ts";
import { setPaused } from "./_mutate.ts";

const ParamsSchema = Type.Object({
	id: Type.Optional(Type.String({ description: "Routine id (nanoid)." })),
	name: Type.Optional(Type.String({ description: "Routine name." })),
});

type Params = Static<typeof ParamsSchema>;

interface Details {
	id: string;
	name: string;
	paused: boolean;
	changed: boolean;
}

function errorResult(message: string): AgentToolResult<Details | null> {
	return { content: [{ type: "text", text: `Error: ${message}` }], details: null };
}

function targetFromParams(params: Params): string | null {
	const t = params.id ?? params.name ?? "";
	return t.trim() || null;
}

/** Register the `RoutinePause` tool. */
export function registerRoutinePauseTool(pi: ExtensionAPI, runtime: RoutineRuntimeState): void {
	pi.registerTool({
		name: "RoutinePause",
		label: "Routine: Pause",
		description:
			"Pause a routine by id or name. Keeps the routine in the store with its " +
			"tickState and run history intact; scheduler / hooks / api fires are all " +
			"silenced. Use this when a routine wants to suspend itself (e.g. after a " +
			"terminal condition) or when the user asks to pause a sibling routine. " +
			"To resume, call RoutineResume.",
		parameters: ParamsSchema,
		async execute(_id, params: Params): Promise<AgentToolResult<Details | null>> {
			const target = targetFromParams(params);
			if (!target) return errorResult("Provide either id or name.");
			const result = await setPaused(target, true, runtime);
			if ("error" in result) return errorResult(result.error);
			const msg = result.changed
				? `Paused '${result.name}'. Call RoutineResume to re-enable.`
				: `'${result.name}' was already paused.`;
			return { content: [{ type: "text", text: msg }], details: result };
		},
		renderCall(args) {
			return new Text(`RoutinePause ${args.name ?? args.id ?? "(unspecified)"}`, 0, 0);
		},
		renderResult(result) {
			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "", 0, 0);
		},
	});
}

/** Register the `RoutineResume` tool. */
export function registerRoutineResumeTool(pi: ExtensionAPI, runtime: RoutineRuntimeState): void {
	pi.registerTool({
		name: "RoutineResume",
		label: "Routine: Resume",
		description:
			"Resume a paused routine by id or name. Re-enables every fire path. " +
			"No-op (no error) when the routine wasn't paused.",
		parameters: ParamsSchema,
		async execute(_id, params: Params): Promise<AgentToolResult<Details | null>> {
			const target = targetFromParams(params);
			if (!target) return errorResult("Provide either id or name.");
			const result = await setPaused(target, false, runtime);
			if ("error" in result) return errorResult(result.error);
			const msg = result.changed ? `Resumed '${result.name}'.` : `'${result.name}' was not paused.`;
			return { content: [{ type: "text", text: msg }], details: result };
		},
		renderCall(args) {
			return new Text(`RoutineResume ${args.name ?? args.id ?? "(unspecified)"}`, 0, 0);
		},
		renderResult(result) {
			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "", 0, 0);
		},
	});
}

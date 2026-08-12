/**
 * @file routine-delete.ts — LLM-callable `RoutineDelete` tool.
 *
 * Thin schema-validation wrapper around {@link deleteRoutine} in
 * `_mutate.ts`. Returns a helpful error listing current routine names
 * when the lookup fails so the LLM can self-correct.
 */

import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type { RoutineRuntimeState } from "../types.ts";
import { deleteRoutine } from "./_mutate.ts";

const ParamsSchema = Type.Object({
	id: Type.Optional(Type.String({ description: "Routine id (nanoid)." })),
	name: Type.Optional(Type.String({ description: "Routine name." })),
});

type Params = Static<typeof ParamsSchema>;

interface Details {
	deletedId: string;
	deletedName: string;
}

function errorResult(message: string): AgentToolResult<Details | null> {
	return {
		content: [{ type: "text", text: `Error: ${message}` }],
		details: null,
	};
}

/**
 * Register the `RoutineDelete` tool.
 *
 * The LLM calls this to stop and remove a routine — either at the user's
 * request, when a routine's job is done (e.g. deploy-watch saw a final
 * state), or when `maxTicks` should be enforced from inside the prompt.
 */
export function registerRoutineDeleteTool(pi: ExtensionAPI, runtime: RoutineRuntimeState): void {
	pi.registerTool({
		name: "RoutineDelete",
		label: "Routine: Delete",
		description:
			"Delete a routine by id or name (case-insensitive). Unschedules " +
			"any pulse timer and removes it from the store. Provide at least " +
			"one of id or name.",
		parameters: ParamsSchema,

		async execute(_id, params: Params): Promise<AgentToolResult<Details | null>> {
			const { id, name } = params;
			if (!id && !name) {
				return errorResult("Provide either id or name.");
			}
			const result = await deleteRoutine(id ?? name ?? "", runtime);
			if ("error" in result) return errorResult(result.error);
			return {
				content: [{ type: "text", text: `Deleted routine '${result.deletedName}'.` }],
				details: {
					deletedId: result.deletedId,
					deletedName: result.deletedName,
				},
			};
		},

		renderCall(args) {
			return new Text(`RoutineDelete ${args.name ?? args.id ?? "(unspecified)"}`, 0, 0);
		},

		renderResult(result) {
			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "", 0, 0);
		},
	});
}

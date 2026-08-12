/**
 * @file routine-set-state.ts — LLM-callable `RoutineSetState` tool.
 *
 * Deep-merges arbitrary JSON into a routine's `tickState.userState`,
 * enforcing the {@link MAX_USER_STATE_BYTES} cap. Used so routines can
 * persist memory across ticks (e.g. "lastStatus", "knownErrors").
 */

import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { saveStore } from "../store.ts";
import { MAX_USER_STATE_BYTES, type RoutineRuntimeState } from "../types.ts";
import { listRoutineNames, resolveRoutine } from "./_resolve.ts";

const ParamsSchema = Type.Object({
	id: Type.Optional(Type.String({ description: "Routine id." })),
	name: Type.Optional(Type.String({ description: "Routine name." })),
	state: Type.Record(Type.String(), Type.Unknown(), {
		description:
			"Arbitrary JSON object. Deep-merged into existing userState (objects merge by key; arrays and primitives replace).",
	}),
});

type Params = Static<typeof ParamsSchema>;

interface Details {
	id: string;
	name: string;
	stateSize: number;
}

function errorResult(message: string): AgentToolResult<Details | null> {
	return {
		content: [{ type: "text", text: `Error: ${message}` }],
		details: null,
	};
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return (
		typeof v === "object" &&
		v !== null &&
		!Array.isArray(v) &&
		Object.getPrototypeOf(v) === Object.prototype
	);
}

/** Recursive deep merge: objects merge by key; arrays + primitives replace. */
function deepMerge(
	target: Record<string, unknown>,
	source: Record<string, unknown>,
): Record<string, unknown> {
	const out: Record<string, unknown> = { ...target };
	for (const [key, value] of Object.entries(source)) {
		const existing = out[key];
		if (isPlainObject(existing) && isPlainObject(value)) {
			out[key] = deepMerge(existing, value);
		} else {
			out[key] = value;
		}
	}
	return out;
}

/**
 * Register the `RoutineSetState` tool.
 *
 * The LLM calls this from inside a routine's prompt to remember things
 * across ticks (deploy status, last error, PR cursors, …). State is
 * deep-merged into the existing `userState` and capped at 2KB serialized.
 */
export function registerRoutineSetStateTool(pi: ExtensionAPI, runtime: RoutineRuntimeState): void {
	pi.registerTool({
		name: "RoutineSetState",
		label: "Routine: Set State",
		description:
			"Persist arbitrary JSON state for a routine across ticks. Deep-merges " +
			"into the existing userState (objects merge by key; arrays/primitives " +
			"replace). Capped at 2KB serialized. Provide id or name to identify " +
			"the routine.",
		parameters: ParamsSchema,

		async execute(_id, params: Params): Promise<AgentToolResult<Details | null>> {
			const { id, name, state } = params;
			if (!id && !name) {
				return errorResult("Provide either id or name.");
			}

			const routine = resolveRoutine(runtime.store, id, name);
			if (!routine) {
				return errorResult(
					`No routine matched id='${id ?? ""}' name='${name ?? ""}'. ` +
						`Current routines: ${listRoutineNames(runtime.store)}.`,
				);
			}

			const tick = runtime.store.tickState[routine.id] ?? {
				tickCount: 0,
				lastFiredAt: 0,
				lastFiredDateLocal: "",
				userState: {},
			};
			const merged = deepMerge(tick.userState ?? {}, state);
			const serialized = JSON.stringify(merged);
			if (serialized.length > MAX_USER_STATE_BYTES) {
				return errorResult(
					`Merged state size ${serialized.length} bytes exceeds limit ${MAX_USER_STATE_BYTES} bytes. ` +
						"Prune state before retrying; no mutation was performed.",
				);
			}

			tick.userState = merged;
			runtime.store.tickState[routine.id] = tick;
			await saveStore(runtime.store, runtime.storeGeneration);

			return {
				content: [
					{
						type: "text",
						text: `Updated state for '${routine.name}' (${serialized.length} bytes).`,
					},
				],
				details: {
					id: routine.id,
					name: routine.name,
					stateSize: serialized.length,
				},
			};
		},

		renderCall(args) {
			return new Text(`RoutineSetState ${args.name ?? args.id ?? "(unspecified)"}`, 0, 0);
		},

		renderResult(result) {
			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "", 0, 0);
		},
	});
}

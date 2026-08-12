/**
 * @file routine-create.ts — LLM-callable `RoutineCreate` tool.
 *
 * Thin schema-validation wrapper around {@link createRoutine} in
 * `_mutate.ts`. Upserts by name — calling with an existing name updates
 * the routine in place (preserving `id`, `createdAt`, `tickState`).
 */

import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type { RoutineRuntimeState } from "../types.ts";
import { createRoutine } from "./_mutate.ts";

// ─── Trigger sub-schemas ─────────────────────────────────────────────────────
//
// Defined separately so the tool description can reference them and so future
// trigger kinds (Slack? Calendar?) can be added without re-walking the union.

const PulseTrigger = Type.Object({
	kind: Type.Literal("pulse"),
	interval: Type.String({
		description: "Interval like '5m', '1h', '30s', '1h30m'. Minimum 30s, maximum 24h.",
	}),
});

const CronTrigger = Type.Object({
	kind: Type.Literal("cron"),
	expr: Type.String({
		description:
			"5-field POSIX cron expression: 'min hour dom month dow'. Supports *, */N, a-b, a,b,c. " +
			"Example: '0 9 * * 1-5' (9am weekdays). DOW 0=Sun, 7 normalised to Sun.",
	}),
	timezone: Type.Optional(
		Type.String({
			description: "IANA timezone (e.g. 'America/Los_Angeles'). Defaults to system local.",
		}),
	),
});

const OneOffTrigger = Type.Object({
	kind: Type.Literal("oneoff"),
	fireAtIso: Type.String({
		description:
			"ISO-8601 timestamp. Use Z/offset for UTC ('2026-06-01T17:00:00Z') or omit offset and " +
			"pass `timezone` to interpret the wall-clock locally. Past timestamps (>30s ago) are rejected.",
	}),
	timezone: Type.Optional(
		Type.String({ description: "IANA timezone used when `fireAtIso` has no offset." }),
	),
});

const HookTrigger = Type.Object({
	kind: Type.Literal("hook"),
	event: Type.Union([
		Type.Literal("session_start"),
		Type.Literal("agent_end"),
		Type.Literal("session_shutdown"),
	]),
	once: Type.Optional(Type.Union([Type.Literal("daily"), Type.Literal("per_session")])),
});

const ApiTrigger = Type.Object({
	kind: Type.Literal("api"),
	allowArgs: Type.Optional(
		Type.Boolean({
			description:
				"Accept caller-supplied JSON args via POST body, available to the prompt as {apiArgs}. Default: false.",
		}),
	),
});

const GithubTrigger = Type.Object({
	kind: Type.Literal("github"),
	repo: Type.String({
		description: "GitHub 'owner/name'. Polled via the local `gh` CLI; gh must be authenticated.",
		pattern: "^[^/?#\\s]+/[^/?#\\s]+$",
	}),
	event: Type.Union([
		Type.Literal("pull_request.opened"),
		Type.Literal("pull_request.closed"),
		Type.Literal("issues.opened"),
		// patched by pi: extra events
		Type.Literal("issues.closed"),
		Type.Literal("issues.events"),
		Type.Literal("discussion"),
		Type.Literal("issue.comment"),
		Type.Literal("discussion.comment"),
		Type.Literal("push"),
	]),
	pollInterval: Type.Optional(
		Type.String({ description: "Human interval like '2m', '5m'. Clamped to ≥60s." }),
	),
	filter: Type.Optional(
		Type.Object({
			labels: Type.Optional(Type.Array(Type.String())),
			branches: Type.Optional(Type.Array(Type.String())),
			mergedOnly: Type.Optional(Type.Boolean()),
		}),
	),
});

const TriggerSchema = Type.Union([
	PulseTrigger,
	CronTrigger,
	OneOffTrigger,
	HookTrigger,
	ApiTrigger,
	GithubTrigger,
]);

const ParamsSchema = Type.Object({
	name: Type.String({
		description: "Short identifier, lowercase letters/digits/hyphens, max 32 chars.",
	}),
	prompt: Type.String({
		minLength: 1,
		pattern: "\\S",
		description:
			"What to ask Pi on each tick. May reference placeholders: {cwd}, {date}, {time}, " +
			"{state}, {tickCount}, {apiArgs} (api triggers only), {githubEvent} (github triggers only). " +
			"For quiet routines, end with instructions to output [~] if nothing changed.",
	}),
	trigger: Type.Optional(TriggerSchema),
	triggers: Type.Optional(
		Type.Array(TriggerSchema, {
			description:
				"Multiple triggers on the same routine (e.g. pulse + api). ANY trigger firing enqueues the routine once. Max 4.",
		}),
	),
	quiet: Type.Optional(
		Type.Boolean({
			description: "Suppress [~] responses from chat (show only in footer). Default: false.",
		}),
	),
	maxTicks: Type.Optional(
		Type.Integer({
			minimum: 1,
			description: "Auto-delete after N fires. Omit for unlimited.",
		}),
	),
	maxRunsPerDay: Type.Optional(
		Type.Integer({
			minimum: 1,
			description: "Soft cap: stop firing once N runs have been recorded today (local time).",
		}),
	),
});

type Params = Static<typeof ParamsSchema>;

interface Details {
	id: string;
	name: string;
	triggerDescription: string;
	nextFireIn?: string;
}

function errorResult(message: string): AgentToolResult<Details | null> {
	return {
		content: [{ type: "text", text: `Error: ${message}` }],
		details: null,
	};
}

/**
 * Register the `RoutineCreate` tool.
 *
 * The LLM calls this to schedule a new pulse or hook routine. Use it when
 * the user asks Pi to "check every N minutes", "run on session start",
 * or otherwise wants Pi to act autonomously on a schedule or event.
 */
export function registerRoutineCreateTool(
	pi: ExtensionAPI,
	runtime: RoutineRuntimeState,
	getCtx: () => ExtensionContext | null,
): void {
	pi.registerTool({
		name: "RoutineCreate",
		label: "Routine: Create",
		description:
			"Create or update a routine. Triggers can be any combination of:\n" +
			"  • pulse   — fixed interval (e.g. every 5m)\n" +
			"  • cron    — POSIX cron expression (e.g. '0 9 * * 1-5')\n" +
			"  • oneoff  — fire once at an ISO-8601 timestamp\n" +
			"  • hook    — pi lifecycle event (session_start, agent_end, session_shutdown)\n" +
			"  • api     — POST 127.0.0.1/routines/<id>/trigger (requires running /routine-server)\n" +
			"  • github  — polled gh events (PR opened/closed, issues, push)\n" +
			"Pass a single `trigger` or a `triggers` array (max 4). Call with an existing name " +
			"to update in place. Use {apiArgs} / {githubEvent} placeholders in the prompt to " +
			"read the caller payload.",
		parameters: ParamsSchema,

		async execute(_id, params: Params): Promise<AgentToolResult<Details | null>> {
			const result = await createRoutine(
				{
					name: params.name,
					prompt: params.prompt,
					...(params.trigger ? { trigger: params.trigger } : {}),
					...(params.triggers ? { triggers: params.triggers } : {}),
					...(params.quiet !== undefined ? { quiet: params.quiet } : {}),
					...(params.maxTicks !== undefined ? { maxTicks: params.maxTicks } : {}),
					...(params.maxRunsPerDay !== undefined ? { maxRunsPerDay: params.maxRunsPerDay } : {}),
				},
				runtime,
				pi,
				getCtx,
			);

			if ("error" in result) return errorResult(result.error);

			const details: Details = {
				id: result.id,
				name: result.name,
				triggerDescription: result.triggerDescription,
			};
			if (result.nextFireIn) details.nextFireIn = result.nextFireIn;

			const verb = result.updated ? "Updated" : "Created";
			const msg = result.nextFireIn
				? `${verb} routine '${result.name}' — fires ${result.triggerDescription}. Next fire in ~${result.nextFireIn}.`
				: `${verb} routine '${result.name}' — fires ${result.triggerDescription}.`;

			return { content: [{ type: "text", text: msg }], details };
		},

		renderCall(args) {
			const triggers = args.triggers ?? (args.trigger ? [args.trigger] : []);
			const trig = triggers
				.map((t) => {
					if (t.kind === "pulse") return `every ${t.interval}`;
					if (t.kind === "cron") return `cron '${t.expr}'`;
					if (t.kind === "oneoff") return `at ${t.fireAtIso}`;
					if (t.kind === "hook") return `on ${t.event}`;
					if (t.kind === "api") return "api";
					return `gh ${t.repo} ${t.event}`;
				})
				.join(" + ");
			return new Text(`RoutineCreate ${args.name} — ${trig || "(no trigger)"}`, 0, 0);
		},

		renderResult(result) {
			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "", 0, 0);
		},
	});
}

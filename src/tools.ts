/**
 * @file tools.ts — 6 个 LLM 工具(自研重构版)。
 *
 * RoutineCreate / RoutineList / RoutineDelete / RoutineSetState /
 * RoutinePause / RoutineResume。接口与上游同名工具保持兼容(LLM 已会调),
 * 但实现只服务 github 触发;修改一律立即保存 + arm/stop 对应 timer。
 */
import { nanoid } from "nanoid";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ghLogger } from "./log.ts";
import { armRoutine, stopRoutine } from "./poller.ts";
import { saveStore } from "./store.ts";
import { getDb } from "./db.ts";
import { MIN_GITHUB_POLL_MS, type Routine, type RoutineRuntime } from "./types.ts";

const IdOrName = Type.Object({
	id: Type.Optional(Type.String({ description: "Routine id (pass either id or name)" })),
	name: Type.Optional(Type.String({ description: "Routine name (pass either id or name)" })),
});

/** 按 id 或 name 解析 routine;找不到返回 null。 */
function resolveRoutine(
	store: RoutineRuntime["store"],
	params: { id?: string; name?: string },
): Routine | null {
	if (params.id) return store.routines[params.id] ?? null;
	if (params.name) {
		const name = params.name;
		return (
			Object.values(store.routines).find((r) => r.name === name) ??
			Object.values(store.routines).find((r) => r.name.toLowerCase() === name.toLowerCase()) ??
			null
		);
	}
	return null;
}

function idOrNameError(): string {
	return "Must pass either id or name.";
}

function describeTrigger(t: Routine["triggers"][number]): string {
	return `github:${t.event} on ${t.repo} (every ${Math.round(t.pollIntervalMs / 1000)}s)`;
}

// ─── RoutineCreate ───────────────────────────────────────────────────────────

const GithubTriggerSchema = Type.Object({
	kind: Type.Literal("github", {
		description: "Trigger kind (github is the only supported kind)",
	}),
	repo: Type.String({ description: "GitHub 'owner/name', e.g. 'HnskNoah/pi-claw'" }),
	event: Type.String({
		description:
			"GitHub event: issues.opened / issues.closed / issue.comment / discussion.comment / discussion",
	}),
	pollIntervalMs: Type.Number({
		description: `Poll interval in ms, clamped up to MIN ${MIN_GITHUB_POLL_MS / 1000}s`,
	}),
});

const CreateParams = Type.Object({
	name: Type.String({
		description: "Short identifier, lowercase letters/digits/hyphens, max 32 chars",
	}),
	prompt: Type.String({
		description:
			"Message template injected into pi when fired. Placeholders: {githubMessage} latest GitHub message, {state} previous state JSON, {cwd} {date} {time} {tickCount}",
	}),
	triggers: Type.Array(GithubTriggerSchema, { minItems: 1 }),
	quiet: Type.Optional(Type.Boolean({ description: "Reply with [~] when nothing changed" })),
	maxTicks: Type.Optional(Type.Number({ description: "Auto-delete after N fires" })),
	maxRunsPerDay: Type.Optional(Type.Number({ description: "Soft daily cap" })),
	paused: Type.Optional(Type.Boolean({ description: "Create already paused" })),
});

// ─── RoutineSetState ─────────────────────────────────────────────────────────

const SetStateParams = Type.Object({
	id: Type.Optional(Type.String()),
	name: Type.Optional(Type.String()),
	state: Type.Object(
		{},
		{
			additionalProperties: true,
			description: "Arbitrary JSON, deep-merged into the routine's userState",
		},
	),
});

// ─── 注册 ────────────────────────────────────────────────────────────────────

export function registerTools(pi: ExtensionAPI, runtime: RoutineRuntime): void {
	pi.registerTool({
		name: "RoutineCreate",
		label: "Routine: Create",
		description:
			"Create a GitHub polling routine. When a new event arrives on the repo/event, a " +
			"chat-style message is injected into pi (one turn per message). Cursor is seeded " +
			"on the first successful poll without firing.",
		parameters: CreateParams,
		async execute(_toolCallId: string, params: {
			name: string;
			prompt: string;
			triggers: Array<{ kind: "github"; repo: string; event: string; pollIntervalMs: number }>;
			quiet?: boolean;
			maxTicks?: number;
			maxRunsPerDay?: number;
			paused?: boolean;
		}) {
			const existing = Object.values(runtime.store.routines).find(
				(r) => r.name.toLowerCase() === params.name.toLowerCase(),
			);
			if (existing) {
				return {
					details: {},
					content: [
						{
							type: "text",
							text: `Routine '${params.name}' already exists (id ${existing.id}). Use RoutineDelete first or pick another name.`,
						},
					],
				};
			}
			const id = nanoid();
			const routine: Routine = {
				id,
				name: params.name,
				prompt: params.prompt,
				triggers: params.triggers.map((t) => ({
					kind: "github",
					repo: t.repo,
					event: t.event,
					pollIntervalMs: Math.max(MIN_GITHUB_POLL_MS, t.pollIntervalMs),
				})),
				quiet: params.quiet,
				maxTicks: params.maxTicks,
				maxRunsPerDay: params.maxRunsPerDay,
				paused: params.paused,
				createdAt: Date.now(),
			};
			runtime.store.routines[id] = routine;
			runtime.store.tickState[id] = { tickCount: 0, userState: {} };
			runtime.timers.set(id, routine.triggers.map(() => null));
			await saveStore(runtime.store);
			armRoutine(runtime, pi, id, () => null);
			ghLogger.info(
				{ routine: id, event: routine.triggers.map((t) => t.event).join(",") },
				"created",
			);
			return {
				details: {},
				content: [
					{
						type: "text",
						text: `Created routine '${params.name}' (${id})\nTriggers: ${routine.triggers
							.map(describeTrigger)
							.join("; ")}\n\nIt will poll immediately (first tick seeds the cursor without firing).`,
					},
				],
			};
		},
	});

	pi.registerTool({
		name: "RoutineList",
		label: "Routine: List",
		description:
			"List all active GitHub polling routines with trigger, tick count, and paused flag. Takes no parameters.",
		parameters: Type.Object({}),
		async execute() {
			const rows = Object.values(runtime.store.routines)
				.sort((a, b) => a.name.localeCompare(b.name))
				.map((r) => {
					const tick = runtime.store.tickState[r.id];
					return {
						id: r.id,
						name: r.name,
						triggerDescription: r.triggers.map(describeTrigger).join("; "),
						tickCount: tick?.tickCount ?? 0,
						paused: r.paused === true,
						...(r.maxTicks !== undefined ? { maxTicks: r.maxTicks } : {}),
						...(r.maxRunsPerDay !== undefined ? { maxRunsPerDay: r.maxRunsPerDay } : {}),
					};
				});
			const text =
				rows.length === 0
					? "No routines."
					: rows
							.map(
								(r) =>
									`• ${r.name} (${r.id}) — ${r.triggerDescription} — ticks: ${r.tickCount}${r.paused ? " [paused]" : ""}`,
							)
							.join("\n");
			return { details: {}, content: [{ type: "text", text }] };
		},
	});

	pi.registerTool({
		name: "RoutineDelete",
		label: "Routine: Delete",
		description: "Delete a routine by id or name. Stops its poller immediately.",
		parameters: IdOrName,
		async execute(_toolCallId: string, params: {
			id?: string;
			name?: string;
		}) {
			const routine = resolveRoutine(runtime.store, params);
			if (!routine) {
				return {
					details: {},
					content: [
						{
							type: "text",
							text:
								params.id || params.name ? `No routine found.` : idOrNameError(),
						},
					],
				};
			}
			stopRoutine(runtime, routine.id);
			delete runtime.store.routines[routine.id];
			delete runtime.store.tickState[routine.id];
			await saveStore(runtime.store);
			ghLogger.info({ routine: routine.id }, "deleted");
			return {
				details: {},
				content: [{ type: "text", text: `Deleted routine '${routine.name}' (${routine.id}).` }],
			};
		},
	});

	pi.registerTool({
		name: "RoutineSetState",
		label: "Routine: Set State",
		description:
			"Deep-merge arbitrary JSON into a routine's persistent userState (available in its next prompt as {state}). " +
			"Use it to keep a rolling summary across fires.",
		parameters: SetStateParams,
		async execute(_toolCallId: string, params: {
			id?: string;
			name?: string;
			state: Record<string, unknown>;
		}) {
			const routine = resolveRoutine(runtime.store, params);
			if (!routine) {
				return {
					details: {},
					content: [
						{
							type: "text",
							text:
								params.id || params.name ? `No routine found.` : idOrNameError(),
						},
					],
				};
			}
			const tick = (runtime.store.tickState[routine.id] ??= { tickCount: 0, userState: {} });
			tick.userState = { ...tick.userState, ...params.state };
			await saveStore(runtime.store);
			return {
				details: {},
				content: [
					{
						type: "text",
						text: `Updated state for '${routine.name}': ${JSON.stringify(tick.userState)}`,
					},
				],
			};
		},
	});

	pi.registerTool({
		name: "RoutinePause",
		label: "Routine: Pause",
		description:
			"Pause a routine by id or name. It keeps polling-skipping (no gh calls, no fires) until resumed.",
		parameters: IdOrName,
		async execute(_toolCallId: string, params: {
			id?: string;
			name?: string;
		}) {
			const routine = resolveRoutine(runtime.store, params);
			if (!routine) {
				return {
					details: {},
					content: [
						{
							type: "text",
							text:
								params.id || params.name ? `No routine found.` : idOrNameError(),
						},
					],
				};
			}
			routine.paused = true;
			await saveStore(runtime.store);
			return { details: {}, content: [{ type: "text", text: `Paused '${routine.name}'.` }] };
		},
	});

	pi.registerTool({
		name: "RoutineResume",
		label: "Routine: Resume",
		description: "Resume a paused routine by id or name.",
		parameters: IdOrName,
		async execute(_toolCallId: string, params: {
			id?: string;
			name?: string;
		}) {
			const routine = resolveRoutine(runtime.store, params);
			if (!routine) {
				return {
					details: {},
					content: [
						{
							type: "text",
							text:
								params.id || params.name ? `No routine found.` : idOrNameError(),
						},
					],
				};
			}
			routine.paused = false;
			await saveStore(runtime.store);
			return { details: {}, content: [{ type: "text", text: `Resumed '${routine.name}'.` }] };
		},
	});

	pi.registerTool({
		name: "RoutineMessages",
		label: "Routine: Messages",
		description:
			"Query the local SQLite GH message store (read-only). Optional SELECT/WITH query; defaults to the 20 most recent messages. Write statements are rejected.",
		parameters: Type.Object({
			query: Type.Optional(
				Type.String({
					description:
						"Optional SELECT SQL against the messages table. Must start with SELECT or WITH. Write statements and multi-statement strings are rejected.",
				}),
			),
		}),
		async execute(_toolCallId: string, params: { query?: string }) {
			const db = getDb();
			if (!db)
				return {
					details: { error: "sqlite unavailable" },
					content: [{ type: "text", text: "SQLite message store unavailable." }],
				};
			const q = (params.query ?? "").trim();
			if (q && !/^\s*(SELECT|WITH)\b/i.test(q)) {
				return {
					details: { rejected: q },
					content: [{ type: "text", text: "Read-only tool: only SELECT/WITH queries are allowed." }],
				};
			}
			if (q && q.includes(";")) {
				return {
					details: { rejected: q },
					content: [{ type: "text", text: "Multi-statement queries are not allowed." }],
				};
			}
			const sql =
				q ||
				"SELECT id, routine, event, author, body, gh_time, seen_at FROM messages ORDER BY gh_time DESC LIMIT 20";
			try {
				const rows = db.prepare(sql).all();
				const text =
					rows.length === 0
						? "No messages in store."
						: JSON.stringify(rows, null, 2);
				return { details: { rows: rows.length }, content: [{ type: "text", text }] };
			} catch (err) {
				return {
					details: { error: String(err) },
					content: [{ type: "text", text: "Query failed: " + String(err) }],
				};
			}
		},
	});
}
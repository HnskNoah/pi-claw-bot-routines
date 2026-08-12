/**
 * @file poller.ts — GitHub 消息桥(自研重构版,逻辑继承已实战验证的轮询核心)。
 *
 * 每个 github trigger 周期跑 `gh api`,发现未见过的事件就把聊天式消息直接
 * 注入 pi 自己的消息队列:`pi.sendUserMessage(prompt, {deliverAs:"followUp"})`
 * (pi 的 `_followUpMessages` FIFO 即队列——无界、有序、零丢失,一消息一轮,
 * 与 TUI 消息同构)。不经过 routine fire 记账(队列/守卫/次数上限都无意义)。
 *
 * 唯一持久化状态是 trigger.cursor;{state} 摘要由注入轮次自己经
 * RoutineSetState 刷新。可观测性 = pino 行(poll / fire / inject failed)。
 *
 * 设计规则:
 *   - 首轮成功只 seed cursor,不触发 —— 只对 seed 之后的事件 fire。
 *   - 连续 gh 失败退避 2× pollIntervalMs,上限 MAX_GITHUB_BACKOFF_MS;成功复位。
 *   - gh 缺失(ENOENT)→ 记一次日志,停 poller,其他 routine 不受影响。
 *   - paused 的 routine 跳过 gh 调用(不烧配额),但保持正常节奏 re-arm,
 *     恢复即时。
 *   - [bot] 作者的评论直接跳过(含我们自己的回复,防自触发环)。
 *   - discussion 游标是 number:updated_at —— 对象更新(新评论)会改 updated_at,
 *     旧游标必然从页面消失,此时按 ISO 时间戳比较而不是静默前进
 *     (那是 discussion 从不 fire 的根因,commit 15c1c98 的修复,此处保留)。
 *   - 先注入后存游标:崩溃最多重放,不会永久丢事件。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ghLogger } from "./log.ts";
import { saveStore } from "./store.ts";
import { recordMessage } from "./db.ts";
import {
	MAX_GITHUB_BACKOFF_MS,
	MAX_USER_STATE_BYTES,
	MIN_GITHUB_POLL_MS,
	type GithubTrigger,
	type Routine,
	type RoutineRuntime,
	type RoutineTickState,
} from "./types.ts";

// ─── gh 子进程 runner ────────────────────────────────────────────────────────

export interface GhResult {
	ok: boolean;
	json?: unknown;
	/** 错误码/信息;"ENOENT" 表示 gh 未安装。 */
	error?: string;
}

const GH_TIMEOUT_MS = 30_000;
const GH_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

function runGhProcess(args: string[]): Promise<GhResult> {
	return new Promise((resolve) => {
		let proc: ReturnType<typeof spawn>;
		try {
			proc = spawn("gh", args, { stdio: ["ignore", "pipe", "pipe"] });
		} catch (err) {
			resolve({ ok: false, error: (err as NodeJS.ErrnoException).code ?? "ESPAWN" });
			return;
		}
		let out = "";
		let errBuf = "";
		let outputBytes = 0;
		let settled = false;
		const finish = (result: GhResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			resolve(result);
		};
		const timeout = setTimeout(() => {
			proc.kill("SIGTERM");
			finish({ ok: false, error: `gh timed out after ${GH_TIMEOUT_MS}ms` });
		}, GH_TIMEOUT_MS);
		proc.stdout?.on("data", (b: Buffer) => {
			outputBytes += b.length;
			if (outputBytes > GH_MAX_OUTPUT_BYTES) {
				proc.kill("SIGTERM");
				finish({ ok: false, error: `gh output exceeded ${GH_MAX_OUTPUT_BYTES} bytes` });
				return;
			}
			out += b.toString("utf8");
		});
		proc.stderr?.on("data", (b: Buffer) => {
			errBuf += b.toString("utf8");
		});
		proc.on("error", (err) => {
			finish({ ok: false, error: (err as NodeJS.ErrnoException).code ?? "ESPAWN" });
		});
		proc.on("close", (code) => {
			if (settled) return;
			if (code !== 0) {
				finish({ ok: false, error: errBuf.trim() || `gh exit ${code}` });
				return;
			}
			try {
				finish({ ok: true, json: JSON.parse(out) });
			} catch (e) {
				finish({ ok: false, error: `parse: ${(e as Error).message}` });
			}
		});
	});
}

// ─── installation token 401 刷新 ─────────────────────────────────────────────

/** 频率退化档位: 空闲时 10s → 30s → 60s(相对各自 base interval 的倍数)。 */
export function isBotAuthored(comments: Array<{ user?: { login?: string } }>): boolean {
	const last = comments.length > 0 ? comments[comments.length - 1] : undefined;
	return typeof last?.user?.login === "string" && last.user.login.endsWith("[bot]");
}

/**
 * discussion 自触发剔除(数据层): 候选事件逐个查该讨论的最新评论,
 * 尾部作者是 [bot](我们自己回复 bump 了 updated_at) → 丢弃事件, 游标照常推进。
 * 空闲时零额外查询(只对有 fresh 的讨论查); 查询失败保守保留(轮次规则 2 兜底)。
 */
async function pruneBotDiscussionEvents(
	trig: GithubTrigger,
	fresh: NormalisedEvent[],
): Promise<NormalisedEvent[]> {
	const kept: NormalisedEvent[] = [];
	for (const ev of fresh) {
		const n = ev.payload.number;
		if (typeof n !== "number") {
			kept.push(ev);
			continue;
		}
		try {
			const res = await runGhProcess(["api", `repos/${trig.repo}/discussions/${n}/comments?per_page=30`]);
			if (!res.ok || !Array.isArray(res.json)) {
				kept.push(ev);
				continue;
			}
			const comments = res.json as Array<{ user?: { login?: string }; body?: string }>;
			if (isBotAuthored(comments)) {
				ghLogger.info({ event: trig.event, discussion: n }, "discussion self-reply pruned");
				continue;
			}
			// 已查过最新评论: 用真实评论重写 message(带 repo + 用户引文), 替换占位
			const last = comments[comments.length - 1];
			if (last && typeof last.body === "string") {
				ev.payload = {
					...ev.payload,
					user: last.user?.login ?? ev.payload.user,
					body: last.body,
					message: `[RoutineReply:discussion][${trig.repo}][github-discussion#${n}] ${last.user?.login ?? "?"}: "${last.body}"`,
				};
			}
			kept.push(ev);
		} catch {
			kept.push(ev);
		}
	}
	return kept;
}

const IDLE_TIERS = [1, 3, 6];

/**
 * 频率退化决策(纯函数, 可测): 有 fresh 回 base, 无 fresh 升档封顶最高档。
 * base=10s 时档位为 10s → 30s → 60s。
 */
export function nextIdleDelay(
	freshCount: number,
	idleLevel: number,
	interval: number,
): { delay: number; level: number } {
	if (freshCount > 0) return { delay: interval, level: 0 };
	const level = Math.min(idleLevel + 1, IDLE_TIERS.length - 1);
	return { delay: interval * IDLE_TIERS[level], level };
}


const REFRESH_SCRIPT =
	process.env.PI_GH_REFRESH_SCRIPT ??
	(() => {
		const candidates = [
			path.join(os.homedir(), "Dev", "pi-agent", "refresh-bot-token.js"),
			path.join(os.homedir(), "pi-agent", "refresh-bot-token.js"),
		];
		return candidates.find((c) => existsSync(c));
	})();

function isUnauthorized(error: string | undefined): boolean {
	return typeof error === "string" && /401|unauthori[sz]ed|bad credentials/i.test(error);
}

async function refreshInstallationToken(): Promise<boolean> {
	if (!REFRESH_SCRIPT) {
		console.warn("[pi-claw] github: 401 but no refresh script found (set PI_GH_REFRESH_SCRIPT)");
		return false;
	}
	try {
		await new Promise<void>((resolve) => {
			const child = spawn("node", [REFRESH_SCRIPT], { stdio: "ignore" });
			const timer = setTimeout(() => {
				child.kill();
				resolve();
			}, 15_000);
			child.on("close", () => {
				clearTimeout(timer);
				resolve();
			});
		});
		return true;
	} catch {
		return false;
	}
}

// ─── endpoint 映射 + 事件规范化 ─────────────────────────────────────────────

/** 按事件类型构建 `gh api` 路径。 */
export function endpointFor(trigger: GithubTrigger, branch?: string): string {
	switch (trigger.event) {
		case "pull_request.opened":
			return `repos/${trigger.repo}/pulls?state=open&sort=created&direction=desc&per_page=30`;
		case "pull_request.closed":
			return `repos/${trigger.repo}/pulls?state=closed&sort=updated&direction=desc&per_page=30`;
		case "issues.opened":
			return `repos/${trigger.repo}/issues?state=open&sort=created&direction=desc&per_page=30`;
		case "issues.closed":
			return `repos/${trigger.repo}/issues?state=closed&sort=updated&direction=desc&per_page=30`;
		case "issues.events":
			return `repos/${trigger.repo}/issues/events?per_page=30`;
		case "discussion":
			return `repos/${trigger.repo}/discussions?per_page=30`;
		case "issue.comment":
			// 全部 issue 评论,新的在前;游标 = comment id(单调数字)
			return `repos/${trigger.repo}/issues/comments?sort=created&direction=desc&per_page=30`;
		case "discussion.comment":
			// REST /discussions/comments 列表对此 App token 404 —— 轮 discussions 列表,
			// 游标 = number:updated_at(新评论 bump updated_at 故会重新 fire)
			return `repos/${trigger.repo}/discussions?sort=updated&direction=desc&per_page=30`;
		case "push":
			return `repos/${trigger.repo}/commits?${branch ? `sha=${encodeURIComponent(branch)}&` : ""}per_page=30`;
		default:
			return "";
	}
}

/** 规范化事件:单调可比的 id + 聊天式 message 的裁剪 payload。 */
export interface NormalisedEvent {
	id: string;
	event?: string;
	payload: Record<string, unknown>;
}

function asArray(json: unknown): Record<string, unknown>[] {
	return Array.isArray(json) ? (json as Record<string, unknown>[]) : [];
}

export function normaliseEvents(trigger: GithubTrigger, json: unknown): NormalisedEvent[] {
	const out: NormalisedEvent[] = [];
	for (const rawIt of asArray(json)) {
		const it = rawIt as Record<string, any>;
		// issues 列表会混入 PR;PR 有 pull_request 字段
		if ((trigger.event === "issues.opened" || trigger.event === "issues.closed") && "pull_request" in it)
			continue;
		let id: string | undefined;
		let payload: Record<string, unknown> = it;
		if (trigger.event === "push") {
			if (typeof it.sha === "string") id = it.sha;
		} else if (trigger.event === "issues.events") {
			if (typeof it.id === "number") id = String(it.id);
			const uname: string = it.actor?.login ?? "?";
			payload = {
				event: it.event,
				actor: uname,
				issue_number: it.issue?.number,
				created_at: it.created_at,
				message: `[RoutineReply:issue][${trigger.repo}][github-issue#${it.issue?.number}] ${uname}: 触发了「${it.event}」事件`,
			};
		} else if (trigger.event === "discussion") {
			if (typeof it.number === "number" && typeof it.updated_at === "string")
				id = `${it.number}:${it.updated_at}`;
			const uname: string = it.user?.login ?? "?";
			payload = {
				number: it.number,
				title: it.title,
				user: uname,
				body: it.body,
				updated_at: it.updated_at,
				message: `[RoutineReply:discussion][${trigger.repo}][github-discussion#${it.number}] ${uname}: "${it.body}"`,
			};
		} else if (trigger.event === "issue.comment") {
			// 跳过 bot 作者(含我们自己),防自触发环
			const login = it.user?.login;
			if (typeof login === "string" && login.endsWith("[bot]")) continue;
			if (typeof it.id === "number") id = String(it.id);
			const uname: string = login ?? "?";
			// GitHub API 的 issue.comment 条目里 issue.number 是 null(已知 quirk) ——
			// 从 html_url(https://github.com/owner/repo/issues/N#issuecomment-...) 解析真实号,
			// 否则注入消息会显示 #undefined(曾导致 bot 猜错 issue 回错帖)。
			const htmlUrl = typeof it.html_url === "string" ? it.html_url : "";
			const urlMatch = /\/issues\/(\d+)/.exec(htmlUrl);
			const issueNum =
				it.issue?.number ?? it.issue_number ?? (urlMatch ? Number(urlMatch[1]) : undefined);
			payload = {
				body: it.body,
				user: it.user?.login,
				created_at: it.created_at,
				issue_number: issueNum,
				discussion_number: it.discussion_number,
				message:
					issueNum !== undefined
						? `[RoutineReply:issue][${trigger.repo}][github-issue#${issueNum}] ${uname}: "${it.body}"`
						: `[RoutineReply:issue][${trigger.repo}][github] ${uname}: "${it.body}"`,
			};
		} else if (trigger.event === "discussion.comment") {
			if (typeof it.number === "number" && typeof it.updated_at === "string")
				id = `${it.number}:${it.updated_at}`;
			const uname: string = it.user?.login ?? "?";
			payload = {
				number: it.number,
				title: it.title,
				user: uname,
				comments: it.comments,
				updated_at: it.updated_at,
				message: id
					? `[RoutineReply:discussion][${trigger.repo}][github-discussion#${it.number}] ${uname}: "有新动态(评论数 ${it.comments})"`
					: `[RoutineReply:discussion][${trigger.repo}][github-discussion#${it.number}] ${uname}`,
			};
		} else {
			if (typeof it.number === "number") id = String(it.number);
			const uname: string = it.user?.login ?? "?";
			payload = {
				number: it.number,
				title: it.title,
				user: uname,
				state: it.state,
				created_at: it.created_at,
				body: it.body,
				message: `[RoutineReply:issue][${trigger.repo}][github-issue#${it.number}] ${uname}: ${trigger.event === "issues.closed" ? "关闭了" : "打开了"}「${it.title}」: ${it.body}`,
			};
		}
		if (id) out.push({ id, event: trigger.event, payload });
	}
	return out;
}

/** 应用 trigger.filter(mergedOnly / labels / branches)。 */
function filterEvents(trigger: GithubTrigger, events: NormalisedEvent[]): NormalisedEvent[] {
	const f = trigger.filter;
	if (!f) return events;
	return events.filter((ev) => {
		if (trigger.event === "pull_request.closed" && f.mergedOnly) {
			if (!ev.payload.merged_at) return false;
		}
		if (
			(trigger.event === "pull_request.opened" || trigger.event === "pull_request.closed") &&
			f.labels &&
			f.labels.length > 0
		) {
			const labels = Array.isArray(ev.payload.labels)
				? (ev.payload.labels as Array<{ name?: string }>).map((l) => l?.name ?? "")
				: [];
			for (const want of f.labels) {
				if (!labels.includes(want)) return false;
			}
		}
		if (trigger.event === "push" && f.branches && f.branches.length > 0) {
			if (!f.branches.includes(String(ev.payload.__branch ?? ""))) return false;
		}
		return true;
	});
}

/**
 * 游标比较。nextCursor = 页面最新 id。
 *  - 无游标 → seed(只记录,不 fire)
 *  - 游标在页内 → 游标之前的都是新事件
 *  - 游标不在页内 → 对 number:updated_at 型游标按时间戳比较(对象被更新,
 *    updated_at 变了,旧游标合法消失);纯数字游标则视为页面滚动,静默前进
 */
export function eventsAfterCursor(
	events: NormalisedEvent[],
	cursor: string | undefined,
): { nextCursor?: string; fresh: NormalisedEvent[] } {
	const nextCursor = events[0]?.id;
	if (!nextCursor) return { fresh: [] };
	if (cursor === undefined) return { nextCursor, fresh: [] };
	const cursorIndex = events.findIndex((event) => event.id === cursor);
	if (cursorIndex < 0) {
		const oldTs = cursor.split(":").slice(1).join(":");
		if (oldTs) {
			const newer = events.filter((ev) => {
				const eTs = ev.id.split(":").slice(1).join(":");
				return eTs && eTs > oldTs; // ISO 字符串可字典序比较
			});
			if (newer.length > 0) return { nextCursor, fresh: newer };
		}
		return { nextCursor, fresh: [] };
	}
	return { nextCursor, fresh: events.slice(0, cursorIndex) };
}

function eventTime(event: NormalisedEvent): number {
	const direct = event.payload.created_at ?? event.payload.updated_at;
	if (typeof direct === "string") return Date.parse(direct) || 0;
	const commit = event.payload.commit;
	if (commit && typeof commit === "object") {
		const author = (commit as { author?: unknown }).author;
		if (author && typeof author === "object") {
			const date = (author as { date?: unknown }).date;
			if (typeof date === "string") return Date.parse(date) || 0;
		}
	}
	return 0;
}

// ─── prompt 组装(消息化) ─────────────────────────────────────────────────────

/** 把 routine.prompt 的占位符替换成注入消息。githubEvent 优先取 message 字段。 */
export function buildPrompt(
	routine: Routine,
	tickState: RoutineTickState,
	cwd: string,
	githubEvent?: Record<string, unknown> | null,
): string {
	const now = new Date();
	const time = now.toLocaleTimeString();
	const date = now.toLocaleDateString();
	const hhmm = time.replace(/:\d{2}(?:\s?[AP]M)?$/i, (m) => {
		const ampm = /[AP]M/i.exec(m)?.[0] ?? "";
		return ampm ? ` ${ampm}` : "";
	});
	const nextTick = tickState.tickCount + 1;

	let userStateJson = JSON.stringify(tickState.userState ?? {});
	let truncated = false;
	if (userStateJson.length > MAX_USER_STATE_BYTES) {
		userStateJson = "{}";
		truncated = true;
	}

	const isObj = githubEvent !== null && typeof githubEvent === "object";
	const msg =
		isObj && typeof (githubEvent as Record<string, unknown>).message === "string"
			? ((githubEvent as Record<string, unknown>).message as string)
			: githubEvent
				? JSON.stringify(githubEvent)
				: "{}";
	const substituted = routine.prompt
		.replaceAll("{cwd}", cwd)
		.replaceAll("{date}", date)
		.replaceAll("{time}", time)
		.replaceAll("{state}", userStateJson)
		.replaceAll("{tickCount}", String(nextTick))
		.replaceAll("{githubEvent}", msg)
		.replaceAll("{githubMessage}", msg);

	// 消息注入同会话, 上下文由 pi 管理(历史+compaction)——不再注入 Previous state 段。
	// userState 计算保留(向后兼容 {state} 占位符), 但 header 不含。
	const header = `[↺ routine: ${routine.name} · tick ${nextTick} · ${hhmm}]\n\n`;
	const truncNote = truncated ? "\n\n[state truncated]" : "";
	const quietFooter = routine.quiet
		? "\n\n---\n" +
			"If nothing changed and there is nothing to report, respond with exactly: [~]\n" +
			"Do not explain that you are responding with [~]. Just output [~] and nothing else."
		: "";

	return (
		header + (routine.context ? `${routine.context}\n\n` : "") + substituted + truncNote + quietFooter
	);
}

// ─── tick + arm ──────────────────────────────────────────────────────────────

interface TickerState {
	backoffMs: number;
	ghMissingLogged: boolean;
	/** 频率退化档(0=base,1=3x,2=6x): 连续空转升档, 有 fresh 回 0。 */
	idleLevel: number;
}

/** 一个 trigger 的轮询循环。返回下次 tick 的延迟 ms(成功=interval,失败=退避)。 */
async function tick(
	runtime: RoutineRuntime,
	pi: ExtensionAPI,
	routine: Routine,
	triggerIndex: number,
	getCtx: () => ExtensionContext | null,
	tstate: TickerState,
): Promise<number> {
	const live = runtime.store.routines[routine.id];
	const trig = live?.triggers[triggerIndex];
	if (!live || !trig || trig.kind !== "github") return MAX_GITHUB_BACKOFF_MS;

	const interval = Math.max(MIN_GITHUB_POLL_MS, trig.pollIntervalMs);

	// paused:跳过 gh 调用(不烧配额),按正常节奏 re-arm,恢复即时
	if (live.paused) return interval;

	const branches =
		trig.event === "push"
			? [...new Set((trig.filter?.branches ?? []).map((b) => b.trim()).filter(Boolean))]
			: [];
	const runPoll = (branch?: string) => runGhProcess(["api", endpointFor(trig, branch)]);

	let polls =
		branches.length > 0
			? await Promise.all(branches.map(async (b) => ({ branch: b, result: await runPoll(b) })))
			: [{ branch: undefined as string | undefined, result: await runPoll() }];

	// installation token 每小时过期 —— 401 刷新一次再试
	if (polls.some(({ result }) => !result.ok && isUnauthorized(result.error))) {
		ghLogger.warn({ routine: live.name }, "token unauthorized — refreshing installation token, retry once");
		await refreshInstallationToken();
		polls =
			branches.length > 0
				? await Promise.all(branches.map(async (b) => ({ branch: b, result: await runPoll(b) })))
				: [{ branch: undefined as string | undefined, result: await runPoll() }];
	}

	const failures = polls.filter(({ result }) => !result.ok);
	const successes = polls.filter(({ result }) => result.ok);
	let nextDelay = interval;

	if (failures.length > 0) {
		const missingCli = failures.some(({ result }) => result.error === "ENOENT");
		if (missingCli) {
			if (!tstate.ghMissingLogged) {
				console.warn(
					`[pi-claw] github: 'gh' CLI not found — disabling poller for '${live.name}'. Install gh and reload.`,
				);
				tstate.ghMissingLogged = true;
			}
			nextDelay = MAX_GITHUB_BACKOFF_MS;
		} else {
			nextDelay = Math.min(tstate.backoffMs * 2, MAX_GITHUB_BACKOFF_MS);
			tstate.backoffMs = nextDelay;
			ghLogger.error(
				{
					routine: live.name,
					errors: failures.map((f) => f.result.error),
					nextTryS: Math.round(nextDelay / 1000),
				},
				"poll failed",
			);
		}
		if (successes.length === 0) return nextDelay;
	} else {
		tstate.backoffMs = interval;
	}

	// 收集 fresh 事件 + 推进游标
	const fresh: NormalisedEvent[] = [];
	let cursorChanged = false;
	let seeded = false;

	if (branches.length > 0) {
		const cursors = { ...(trig.branchCursors ?? {}) };
		for (const poll of successes) {
			const branch = poll.branch as string;
			const events = normaliseEvents(trig, poll.result.json);
			const previous = cursors[branch];
			const batch = eventsAfterCursor(events, previous);
			if (batch.nextCursor && batch.nextCursor !== previous) {
				cursors[branch] = batch.nextCursor;
				cursorChanged = true;
			}
			if (previous === undefined && batch.nextCursor) seeded = true;
			fresh.push(...filterEvents(trig, batch.fresh));
		}
		trig.branchCursors = cursors;
	} else {
		const events = normaliseEvents(trig, successes[0]?.result.json);
		const previous = trig.cursor;
		const batch = eventsAfterCursor(events, previous);
		if (batch.nextCursor && batch.nextCursor !== previous) {
			trig.cursor = batch.nextCursor;
			cursorChanged = true;
		}
		if (previous === undefined && batch.nextCursor) seeded = true;
		fresh.push(...filterEvents(trig, batch.fresh));
	}

	// 按时间正序注入(多事件时从旧到新,一消息一轮)
	// 数据层剔除 discussion 自触发: bot 自己的回复不注入(游标仍推进)
	const userEvents =
		trig.event === "discussion.comment" && fresh.length > 0
			? await pruneBotDiscussionEvents(trig, fresh)
			: fresh;
	const chronological = userEvents
		.map((event, index) => ({ event, index }))
		.sort((a, b) => {
			const aTime = eventTime(a.event);
			const bTime = eventTime(b.event);
			return aTime && bTime && aTime !== bTime ? aTime - bTime : b.index - a.index;
		})
		.map(({ event }) => event);
	for (const ev of chronological) {
		// 注入前再查一次 paused(注入绕过 scheduler 的 paused gate,这里自检)
		if (runtime.store.routines[routine.id]?.paused) {
			ghLogger.info({ routine: live.name }, "paused — skip inject");
			continue;
		}
		try {
			let cwd: string;
			try {
				cwd = getCtx()?.cwd ?? process.cwd();
			} catch {
				cwd = process.cwd();
			}
			const tickState: RoutineTickState =
				runtime.store.tickState[routine.id] ?? { tickCount: 0, userState: {} };
			const prompt = buildPrompt(live, tickState, cwd, ev.payload);
			pi.sendUserMessage(prompt, { deliverAs: "followUp" });
			recordMessage(ev, live.name);
			ghLogger.info({ routine: live.name, event: trig.event }, "fire");
		} catch (err) {
			console.error(`[pi-claw] github inject failed for '${live.name}':`, err);
			ghLogger.error({ routine: live.name, err: String(err) }, "fire inject failed");
		}
	}

	// 频率退化: 全部成功时, 有 fresh(活跃)→ 回 base 档; 连续空转 → 升档(10s→30s→60s)。
	// 失败路径保留 backoff(2× cap 60s), 不与档位互相干扰。
	if (failures.length === 0) {
		const stepped = nextIdleDelay(userEvents.length, tstate.idleLevel, interval);
		tstate.idleLevel = stepped.level;
		nextDelay = stepped.delay;
	}

	ghLogger.info(
		{
			routine: routine.name,
			event: trig.event,
			ok: `${successes.length}/${polls.length}`,
			fresh: fresh.length,
			cursor: trig.cursor ?? "-",
			delay: nextDelay,
		},
		"poll",
	);

	if (cursorChanged || seeded) {
		await saveStore(runtime.store);
	}
	return nextDelay;
}

function armTrigger(
	runtime: RoutineRuntime,
	pi: ExtensionAPI,
	routineId: string,
	triggerIndex: number,
	getCtx: () => ExtensionContext | null,
): void {
	const trig = runtime.store.routines[routineId]?.triggers[triggerIndex];
	if (!trig || trig.kind !== "github") return;
	if (typeof trig.repo !== "string" || !/^[^/?#\s]+\/[^/?#\s]+$/.test(trig.repo)) {
		console.warn(`[pi-claw] github: invalid repo for routine '${routineId}': ${String(trig.repo)}`);
		return;
	}
	const interval = Math.max(MIN_GITHUB_POLL_MS, trig.pollIntervalMs);
	const tstate: TickerState = { backoffMs: interval, ghMissingLogged: false, idleLevel: 0 };

	const schedule = (delay: number): ReturnType<typeof setTimeout> => {
		const handle = setTimeout(() => {
			void (async () => {
				const live = runtime.store.routines[routineId];
				const trigNow = live?.triggers[triggerIndex];
				if (!live || !trigNow || trigNow.kind !== "github") return; // routine 没了,停
				const next = await tick(runtime, pi, live, triggerIndex, getCtx, tstate);
				// re-arm(若 routine/trigger 仍在)
				if (runtime.store.routines[routineId]?.triggers[triggerIndex]?.kind === "github") {
					const h = schedule(next);
					const arr = runtime.timers.get(routineId);
					if (arr) arr[triggerIndex] = h;
				}
			})().catch((err) => {
				console.error(`[pi-claw] github poller unexpected error:`, err);
			});
		}, delay);
		const arr = runtime.timers.get(routineId);
		if (arr) arr[triggerIndex] = handle;
		return handle;
	};

	schedule(interval);
}

/** 创建后 arm 一个新 routine 的所有 trigger。 */
export function armRoutine(runtime: RoutineRuntime, pi: ExtensionAPI, routineId: string, getCtx: () => ExtensionContext | null): void {
	for (let i = 0; i < (runtime.store.routines[routineId]?.triggers.length ?? 0); i++) {
		armTrigger(runtime, pi, routineId, i, getCtx);
	}
}

/** 停止一个 routine 的所有 timer(delete/pause 时)。 */
export function stopRoutine(runtime: RoutineRuntime, routineId: string): void {
	const arr = runtime.timers.get(routineId);
	if (!arr) return;
	for (const h of arr) if (h) clearTimeout(h);
	runtime.timers.delete(routineId);
}

/** 启动时为 store 里所有 routine arm。 */
export function armAll(runtime: RoutineRuntime, pi: ExtensionAPI, getCtx: () => ExtensionContext | null): void {
	for (const id of Object.keys(runtime.store.routines)) {
		armRoutine(runtime, pi, id, getCtx);
	}
}

/** 全部停止(session 卸载)。 */
export function stopAll(runtime: RoutineRuntime): void {
	for (const id of [...runtime.timers.keys()]) stopRoutine(runtime, id);
}

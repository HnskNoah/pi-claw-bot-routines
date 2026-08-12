/**
 * @file smoke.ts — 自检:消息桥核心逻辑(不依赖 pi 运行时)。
 *
 * 验证 endpoint 映射、[bot] 过滤、discussion 时间戳游标回退、seed 逻辑。
 * 运行:node smoke.ts(Node ≥23.6 原生 type stripping)。
 * 纯函数层,不发起真实 gh 调用 —— poller 的 ExtensionAPI import 是
 * type-only,type stripping 后不残留,故可脱离 pi 独立跑。
 */
import assert from "node:assert/strict";
import { endpointFor, eventsAfterCursor, normaliseEvents } from "./src/poller.ts";
import type { GithubTrigger } from "./src/types.ts";

const trig = (event: string, repo = "HnskNoah/pi-claw"): GithubTrigger => ({
	kind: "github",
	repo,
	event,
	pollIntervalMs: 10_000,
});

// 1. endpoint 映射
assert.ok(endpointFor(trig("issue.comment")).includes("issues/comments"), "issue.comment → issues/comments");
assert.ok(
	endpointFor(trig("discussion.comment")).includes("/discussions?"),
	"discussion.comment → discussions list (REST comments 404 的替代)",
);
assert.ok(endpointFor(trig("issues.opened")).includes("state=open"), "issues.opened → open issues");
assert.ok(endpointFor(trig("issues.closed")).includes("state=closed"), "issues.closed → closed issues");

// 2. [bot] 过滤:自己的回复不触发
const withBot = normaliseEvents(trig("issue.comment"), [
	{ id: 11, user: { login: "hanenoah-bot[bot]" }, body: "bot reply", created_at: "2026-08-12T00:00:00Z" },
	{ id: 10, user: { login: "HnskNoah" }, body: "hello", created_at: "2026-08-12T00:01:00Z" },
]);
assert.equal(withBot.length, 1, "[bot] 作者被跳过");
assert.equal(withBot[0].payload.message, "HnskNoah 在 issue #undefined 说: hello");

// 2b. issue.number=null quirk:从 html_url 解析真实 issue 号(曾导致回错帖)
const withUrl = normaliseEvents(trig("issue.comment"), [
	{
		id: 12,
		user: { login: "HnskNoah" },
		body: "现在看得到吗",
		created_at: "2026-08-12T06:00:00Z",
		html_url: "https://github.com/HnskNoah/pi-claw/issues/3#issuecomment-5262079650",
	},
]);
assert.equal(withUrl[0].payload.message, "HnskNoah 在 issue #3 说: 现在看得到吗", "html_url 解析出真实 issue 号");

// 3. discussion 游标 = number:updated_at,时间戳回退(commit 15c1c98 修复)
const d1 = { number: 2, title: "聊天", user: { login: "HnskNoah" }, body: "a", updated_at: "2026-08-12T01:00:00Z", comments: 1 };
const d2 = { number: 2, title: "聊天", user: { login: "HnskNoah" }, body: "a", updated_at: "2026-08-12T01:05:00Z", comments: 2 };
const seed = normaliseEvents(trig("discussion.comment"), [d1]);
assert.equal(seed[0].id, "2:2026-08-12T01:00:00Z", "游标格式 number:updated_at");
// 首轮:无游标 → 只 seed,不 fire
const seeded = eventsAfterCursor(seed, undefined);
assert.equal(seeded.fresh.length, 0, "首次 poll 只 seed 不 fire");
// 第二轮回合:对象更新(新评论 bump updated_at),旧游标消失 → 必须按时间戳回退 fire
const page2 = normaliseEvents(trig("discussion.comment"), [d2]);
const caught = eventsAfterCursor(page2, "2:2026-08-12T01:00:00Z");
assert.equal(caught.fresh.length, 1, "cursor 消失时按 ISO 时间戳比较找到新事件");
assert.equal(caught.fresh[0].id, "2:2026-08-12T01:05:00Z", "命中更新后的最新 id");
assert.equal(caught.nextCursor, "2:2026-08-12T01:05:00Z", "nextCursor 推进");

// 4. 数字游标(issue.comment):页内推进 + 页滚静默
const evs = normaliseEvents(trig("issue.comment"), [
	{ id: 5, user: { login: "HnskNoah" }, body: "c5", created_at: "2026-08-12T02:00:00Z" },
	{ id: 4, user: { login: "HnskNoah" }, body: "c4", created_at: "2026-08-12T01:00:00Z" },
]);
const after5 = eventsAfterCursor(evs, "5");
assert.equal(after5.fresh.length, 0, "游标是最新 → 无新事件");
const pageWithNew = normaliseEvents(trig("issue.comment"), [
	{ id: 7, user: { login: "HnskNoah" }, body: "c7", created_at: "2026-08-12T03:00:00Z" },
	{ id: 5, user: { login: "HnskNoah" }, body: "c5", created_at: "2026-08-12T02:00:00Z" },
]);
const after5New = eventsAfterCursor(pageWithNew, "5");
assert.equal(after5New.fresh.length, 1, "游标在页内 → 游标之前都是新的");
assert.equal(after5New.fresh[0].id, "7");
// 数字游标完全离开页面 → 静默前进不重放
const rolled = eventsAfterCursor(
	normaliseEvents(trig("issue.comment"), [
		{ id: 9, user: { login: "HnskNoah" }, body: "c9", created_at: "2026-08-12T04:00:00Z" },
	]),
	"5",
);
assert.equal(rolled.fresh.length, 0, "数字游标离页 → 静默前进,不重放旧事件");

// 5. 事件消息化
const opened = normaliseEvents(trig("issues.opened"), [
	{ number: 9, title: "标题", user: { login: "HnskNoah" }, state: "open", body: "正文", created_at: "2026-08-12T05:00:00Z" },
]);
assert.match(opened[0].payload.message as string, /打开了 issue #9「标题」/);

console.log("✓ smoke 全过:endpoint / [bot] 过滤 / discussion 时间戳回退 / seed / 页滚 / 消息化");

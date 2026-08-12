/**
 * @file db.ts — GH 消息本地库(SQLite, Node 内置 node:sqlite, 零依赖)。
 * 每条注入的消息落库(INSERT OR IGNORE, id 唯一), 会话/compaction 冲不掉,
 * 供本地处理(查询/统计/复盘)。DB 文件: ~/.pi/agent/extensions/routines/gh-messages.db
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** 注入事件的最小形状(避免与 poller 循环 import)。 */
export interface MessageRecord {
	id: string;
	event?: string;
	payload: Record<string, unknown>;
}

export const DB_PATH =
	process.env.PI_GH_DB ??
	path.join(os.homedir(), ".pi", "agent", "extensions", "routines", "gh-messages.db");

let db: DatabaseSync | null = null;

/** 打开(惰性)并建表。失败返回 null, 不影响轮询主流程。 */
export function getDb(dbPath: string = DB_PATH): DatabaseSync | null {
	if (db) return db;
	try {
		mkdirSync(path.dirname(dbPath), { recursive: true });
		db = new DatabaseSync(dbPath);
		db.exec(`
			CREATE TABLE IF NOT EXISTS messages (
				id        TEXT PRIMARY KEY,
				routine   TEXT,
				event     TEXT,
				author    TEXT,
				body      TEXT,
				url       TEXT,
				gh_time   TEXT,
				seen_at   TEXT DEFAULT (datetime('now'))
			);
		`);
		return db;
	} catch (err) {
		console.error(`[pi-claw] sqlite unavailable (${dbPath}):`, err);
		return null;
	}
}

/** 记录一条注入消息(幂等, 失败静默)。 */
export function recordMessage(ev: MessageRecord, routineName: string): void {
	try {
		const d = getDb();
		if (!d) return;
		const p = ev.payload as Record<string, unknown>;
		d.prepare(
			`INSERT OR IGNORE INTO messages (id, routine, event, author, body, url, gh_time)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		).run(
			ev.id,
			routineName,
			ev.event ?? null,
			p.user ?? p.author ?? null,
			p.body ?? p.message ?? null,
			p.html_url ?? null,
			p.created_at ?? p.updated_at ?? null,
		);
	} catch {
		// 记录失败不阻断注入
	}
}
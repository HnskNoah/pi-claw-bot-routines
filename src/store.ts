/**
 * @file store.ts — state.json 原子读写(自研重构版)。
 *
 * 路径与既有实现一致:${HOME}/.pi/agent/extensions/routines/state.json,
 * schemaVersion 3。读失败返回空 store(不崩);写为 tmp + rename 原子替换,
 * 并保留 .bak 供恢复。无 migration / generation 机制 —— 全量写小文件足够。
 */
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SCHEMA_VERSION, type RoutineStore } from "./types.ts";

export const STATE_FILE =
	process.env.PI_ROUTINES_STATE ??
	path.join(os.homedir(), ".pi", "agent", "extensions", "routines", "state.json");

export function emptyStore(): RoutineStore {
	return { schemaVersion: SCHEMA_VERSION, routines: {}, tickState: {} };
}

function asRecord(raw: unknown): Record<string, unknown> | null {
	return raw !== null && typeof raw === "object" && !Array.isArray(raw)
		? (raw as Record<string, unknown>)
		: null;
}

/** 读 state.json;缺失/损坏一律返回空 store(绝不抛)。 */
export async function loadStore(): Promise<RoutineStore> {
	try {
		const raw = await fs.readFile(STATE_FILE, "utf8");
		const parsed = asRecord(JSON.parse(raw));
		if (!parsed) return emptyStore();
		const routines = asRecord(parsed.routines) ?? {};
		const tickState = asRecord(parsed.tickState) ?? {};
		return {
			schemaVersion:
				typeof parsed.schemaVersion === "number" ? parsed.schemaVersion : SCHEMA_VERSION,
			routines: routines as RoutineStore["routines"],
			tickState: tickState as RoutineStore["tickState"],
		};
	} catch {
		return emptyStore();
	}
}

/** 原子写:tmp → rename,再异步留 .bak 副本。 */
export async function saveStore(store: RoutineStore): Promise<void> {
	const tmp = `${STATE_FILE}.tmp.${randomBytes(4).toString("hex")}`;
	await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
	await fs.writeFile(tmp, JSON.stringify(store, null, 2), { encoding: "utf8", mode: 0o600 });
	await fs.rename(tmp, STATE_FILE);
	await fs.copyFile(STATE_FILE, `${STATE_FILE}.bak`).catch(() => {});
}

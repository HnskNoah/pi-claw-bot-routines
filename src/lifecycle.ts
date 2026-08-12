/**
 * @file lifecycle.ts — pi 生命周期接线(自研重构版)。
 *
 * session_start:载入 store + arm 全部 poller(幂等,reload 不会重复 arm)。
 * tool_result:保持 currentCtx 新鲜(工具可能跨生命周期事件异步跑)。
 * session 结束:停全部 timer。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ghLogger } from "./log.ts";
import { armAll, stopAll } from "./poller.ts";
import { loadStore } from "./store.ts";
import type { RoutineRuntime } from "./types.ts";

export function registerLifecycle(
	pi: ExtensionAPI,
	runtime: RoutineRuntime,
	getCtx: () => ExtensionContext | null,
	setCtx: (ctx: ExtensionContext) => void,
): () => void {
	let armed = false;

	pi.on("session_start", (_event, ctx) => {
		setCtx(ctx);
		if (armed) return; // reload 幂等
		void (async () => {
			const store = await loadStore();
			runtime.store = store;
			runtime.timers = new Map(
				Object.keys(store.routines).map((id) => [
					id,
					store.routines[id].triggers.map(() => null),
				]),
			);
			armAll(runtime, pi, getCtx);
			armed = true;
			ghLogger.info(
				{ routines: Object.keys(store.routines).length },
				"session_start — pollers armed",
			);
		})().catch((err) => {
			console.error("[pi-claw] failed to arm pollers on session_start:", err);
			ghLogger.error({ err: String(err) }, "arm failed");
		});
	});

	// 工具可能经异步流与下一个生命周期事件竞争 —— 保持 ctx 新鲜
	pi.on("tool_result", (_event, ctx) => {
		setCtx(ctx);
	});

	return () => {
		stopAll(runtime);
		armed = false;
		ghLogger.info({}, "cleanup — pollers stopped");
	};
}
/**
 * @file index.ts — pi-claw bot 扩展入口(自研重构版)。
 *
 * 整个 pi-routines fork 重写后的形态:6 个 LLM 工具 + GitHub 轮询消息桥 +
 * 生命周期接线。无 slash 命令、无 pulse/cron/oneoff/hook/api 触发、无
 * widget/suppressor/guard —— 只有这个 bot 场景需要的东西。
 * loadStore 在 session_start 做(state 路径固定为
 * ~/.pi/agent/extensions/routines/state.json,与旧实现共用,数据零迁移)。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerLifecycle } from "../src/lifecycle.ts";
import { registerTools } from "../src/tools.ts";
import type { RoutineRuntime, RoutineStore } from "../src/types.ts";

export default function registerRoutinesExtension(pi: ExtensionAPI): void {
	let currentCtx: ExtensionContext | null = null;
	const getCtx = () => currentCtx;
	const setCtx = (ctx: ExtensionContext) => {
		currentCtx = ctx;
	};

	const runtime: RoutineRuntime = {
		store: { schemaVersion: 3, routines: {}, tickState: {} } satisfies RoutineStore,
		timers: new Map(),
	};

	// 1. LLM 工具(立即注册)。
	registerTools(pi, runtime);

	// 2. 生命周期(session_start 载入 store + arm poller;卸载停 timer)。
	const cleanup = registerLifecycle(pi, runtime, getCtx, setCtx);

	// 3. 清理注册:会话结束时停全部 timer;下个 session_start 重新 loadStore + arm。
	pi.on("session_shutdown", () => {
		try {
			cleanup();
		} catch {
			/* teardown 期间吞掉 */
		}
	});
}
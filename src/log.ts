/**
 * @file log.ts — 集中 pino 日志(自研)。
 *
 * JSON Lines 到文件(默认 ~/.pi/agent/logs/pi-claw.log),level 由
 * $PI_GH_LOG_LEVEL(默认 info),ISO 时间戳。轮询/触发/注入失败/401 刷新
 * 全部走 ghLogger。
 */
import { pino, type Logger } from "pino";
import * as os from "node:os";
import * as path from "node:path";

export const GH_LOG_FILE =
	process.env.PI_GH_LOG ?? path.join(os.homedir(), ".pi", "agent", "logs", "pi-claw.log");

// pino v10 的类型没在 namespace 上导出 transport(运行时存在);本地收窄保 tsc。
const pinoNs = pino as unknown as {
	transport(opts: { target: string; options?: Record<string, unknown> }): unknown;
	stdTimeFunctions: typeof pino.stdTimeFunctions;
};
const logStream = pinoNs.transport({
	target: "pino/file",
	options: { destination: GH_LOG_FILE, mkdir: true },
});

export const ghLogger: Logger = pino(
	{
		level: process.env.PI_GH_LOG_LEVEL ?? "info",
		base: undefined, // 去掉 pid/hostname 噪音
		timestamp: pinoNs.stdTimeFunctions.isoTime,
	},
	logStream as import("pino").DestinationStream,
);

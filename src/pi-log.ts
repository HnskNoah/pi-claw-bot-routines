/**
 * patched by pi: central pino logger for the GitHub bot.
 *
 * JSON Lines to a file (default ~/.pi/agent/logs/pi-claw.log), level from
 * $PI_GH_LOG_LEVEL (default info). This is the mature-logging swap for the
 * earlier appendFileSync hack: structured fields, ISO timestamps, levels.
 */
import { pino, type Logger } from "pino";
import * as os from "node:os";
import * as path from "node:path";

export const GH_LOG_FILE =
	process.env.PI_GH_LOG ?? path.join(os.homedir(), ".pi", "agent", "logs", "pi-claw.log");

// pino v10's shipped types don't export transport on the namespace (runtime OK);
// narrow it locally to keep tsc happy.
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
		base: undefined, // no pid/hostname noise
		timestamp: pinoNs.stdTimeFunctions.isoTime,
	},
	logStream as import("pino").DestinationStream,
);
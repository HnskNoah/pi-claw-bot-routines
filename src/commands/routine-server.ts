/**
 * @file routine-server.ts — `/routine-server start|stop|status` slash command.
 *
 * Lifecycle wrapper around `src/server.ts`. The server is OFF by default; a
 * user must run `/routine-server start` to expose any API-triggered routines.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_PORT, isServerRunning, serverStatus, startServer, stopServer } from "../server.ts";
import type { RoutineRuntimeState } from "../types.ts";

const SYSTEM_MSG_TYPE = "pi-routines/system";

export function registerRoutineServerCommand(
	pi: ExtensionAPI,
	runtime: RoutineRuntimeState,
	getCtx: () => ExtensionContext | null,
): void {
	pi.registerCommand("routine-server", {
		description:
			"Control the local HTTP trigger server: /routine-server <start [port]|stop|status>",
		async handler(args: string): Promise<void> {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const sub = (parts[0] ?? "status").toLowerCase();

			if (sub === "start") {
				if (isServerRunning()) {
					const s = serverStatus();
					pi.sendMessage({
						customType: SYSTEM_MSG_TYPE,
						content: `Server already running on 127.0.0.1:${s.port}.`,
						display: true,
					});
					return;
				}
				const port = parts[1] ? Number.parseInt(parts[1], 10) : DEFAULT_PORT;
				if (!Number.isFinite(port) || port < 0 || port > 65535) {
					pi.sendMessage({
						customType: SYSTEM_MSG_TYPE,
						content: `Error: invalid port '${parts[1]}'`,
						display: true,
					});
					return;
				}
				try {
					const bound = await startServer(runtime, port, { pi, getCtx });
					pi.sendMessage({
						customType: SYSTEM_MSG_TYPE,
						content: `Server listening on 127.0.0.1:${bound}. Endpoint: POST /routines/<id>/trigger`,
						display: true,
					});
				} catch (err) {
					pi.sendMessage({
						customType: SYSTEM_MSG_TYPE,
						content: `Error starting server: ${(err as Error).message}`,
						display: true,
					});
				}
				return;
			}

			if (sub === "stop") {
				if (!isServerRunning()) {
					pi.sendMessage({
						customType: SYSTEM_MSG_TYPE,
						content: "Server is not running.",
						display: true,
					});
					return;
				}
				await stopServer(runtime);
				pi.sendMessage({
					customType: SYSTEM_MSG_TYPE,
					content: "Server stopped.",
					display: true,
				});
				return;
			}

			// status
			const s = serverStatus();
			if (!s.running) {
				pi.sendMessage({
					customType: SYSTEM_MSG_TYPE,
					content: "Server: stopped.",
					display: true,
				});
				return;
			}
			const uptimeSec = Math.floor(s.uptimeMs / 1000);
			pi.sendMessage({
				customType: SYSTEM_MSG_TYPE,
				content: `Server: running on 127.0.0.1:${s.port} · uptime ${uptimeSec}s · ${s.requestCount} requests`,
				display: true,
			});
		},
	});
}

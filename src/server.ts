/**
 * @file server.ts — embedded `node:http` server for API-triggered routines.
 *
 * Lifecycle: OFF by default. Started by `/routine-server start [port]`,
 * stopped by `/routine-server stop` and by the extension cleanup hook.
 *
 * Security posture (see PROMPT.md → Security Requirements):
 *   - Bind 127.0.0.1 ONLY.
 *   - Re-check `req.socket.remoteAddress` is loopback at request time.
 *   - Reject any method other than POST.
 *   - Reject Host headers that don't match `127.0.0.1[:port]` / `localhost[:port]`.
 *   - Reject bodies > 4 KiB.
 *   - Per-token bucket rate limit: 60 req/min.
 *   - Tokens compared in constant time; never logged in full.
 *
 * The server only knows how to enqueue \u2014 actual firing is gated through
 * the scheduler's idle/drain logic, identical to all other trigger kinds.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { nanoid } from "nanoid";
import { recordSkippedFire } from "./executor.ts";
import { enqueueFireRequest } from "./scheduler.ts";
import { assertTokenStoreSafe, verifyToken } from "./tokens.ts";
import { resolveRoutine } from "./tools/_resolve.ts";
import type { ApiTrigger, RoutineRuntimeState } from "./types.ts";

/** Default port if none supplied. */
export const DEFAULT_PORT = 7424;
/** Max body size accepted (bytes). */
const MAX_BODY_BYTES = 4 * 1024;
/** Rate limit window (ms) and capacity per token. */
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_CAPACITY = 60;
const REQUEST_TIMEOUT_MS = 10_000;

/** Live server state. Stored on a module-level singleton so cleanup is easy. */
interface ServerState {
	server: Server;
	port: number;
	startedAt: number;
	requestCount: number;
	rate: Map<string, number[]>; // routineId -> request timestamps within window
}

let active: ServerState | null = null;
let closing: Promise<void> | null = null;
let desiredPort: number | null = null;

/** True if the server is currently listening. */
export function isServerRunning(): boolean {
	return active !== null;
}

/** Snapshot for the status command. */
export function serverStatus(): {
	running: boolean;
	port: number | null;
	uptimeMs: number;
	requestCount: number;
} {
	if (!active) return { running: false, port: null, uptimeMs: 0, requestCount: 0 };
	return {
		running: true,
		port: active.port,
		uptimeMs: Date.now() - active.startedAt,
		requestCount: active.requestCount,
	};
}

function isLoopback(addr: string | undefined): boolean {
	if (!addr) return false;
	// Strip IPv6-mapped IPv4 prefix.
	const a = addr.startsWith("::ffff:") ? addr.slice(7) : addr;
	return a === "127.0.0.1" || a === "::1" || a === "localhost";
}

function isAllowedHost(host: string | undefined, port: number): boolean {
	if (!host) return false;
	const candidates = [
		"127.0.0.1",
		`127.0.0.1:${port}`,
		"localhost",
		`localhost:${port}`,
		"[::1]",
		`[::1]:${port}`,
	];
	return candidates.includes(host);
}

/** Bump the in-window count for a token; return true if over capacity. */
function isRateLimited(state: ServerState, routineId: string): boolean {
	const now = Date.now();
	const arr = state.rate.get(routineId) ?? [];
	const cutoff = now - RATE_LIMIT_WINDOW_MS;
	const fresh = arr.filter((t) => t > cutoff);
	if (fresh.length >= RATE_LIMIT_CAPACITY) {
		state.rate.set(routineId, fresh);
		return true;
	}
	fresh.push(now);
	state.rate.set(routineId, fresh);
	return false;
}

/** Read up to MAX_BODY_BYTES of body; reject (throw) if exceeded. */
function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let total = 0;
		let rejected = false;
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => {
			if (rejected) return;
			total += chunk.length;
			if (total > MAX_BODY_BYTES) {
				rejected = true;
				reject(new Error("body too large"));
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			if (!rejected) resolve(Buffer.concat(chunks).toString("utf8"));
		});
		req.on("error", (e) => {
			if (!rejected) reject(e);
		});
	});
}

/** Sanitize caller-supplied args: cap depth 3, cap stringified to 1 KiB. */
function sanitizeArgs(raw: unknown): Record<string, unknown> | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	function checkDepth(v: unknown, depth: number): boolean {
		if (depth > 3) return false;
		if (v === null || typeof v !== "object") return true;
		for (const child of Object.values(v as Record<string, unknown>)) {
			if (!checkDepth(child, depth + 1)) return false;
		}
		return true;
	}
	if (!checkDepth(raw, 1)) return null;
	const json = JSON.stringify(raw);
	if (json.length > 1024) return null;
	return raw as Record<string, unknown>;
}

interface StartContext {
	pi: ExtensionAPI;
	getCtx: () => ExtensionContext | null;
}

/**
 * Start the HTTP server. Returns the actual bound port (useful when caller
 * passes `0` for "pick any free port"). Idempotent on success: a second call
 * with the server already running returns the existing port.
 */
export async function startServer(
	runtime: RoutineRuntimeState,
	port: number,
	ctx: StartContext,
): Promise<number> {
	if (active) return active.port;
	if (closing) await closing;
	await assertTokenStoreSafe();

	const server = createServer((req, res) => {
		void handleRequest(req, res, runtime, ctx).catch((err) => {
			console.error("[pi-routines] server handler error:", err);
			try {
				res.writeHead(500);
				res.end();
			} catch {
				/* ignore */
			}
		});
	});

	await new Promise<void>((resolve, reject) => {
		const onErr = (err: Error) => {
			server.removeListener("listening", onOk);
			reject(err);
		};
		const onOk = () => {
			server.removeListener("error", onErr);
			resolve();
		};
		server.once("error", onErr);
		server.once("listening", onOk);
		server.listen(port, "127.0.0.1");
	});

	const addr = server.address();
	const boundPort = typeof addr === "object" && addr ? addr.port : port;
	active = {
		server,
		port: boundPort,
		startedAt: Date.now(),
		requestCount: 0,
		rate: new Map(),
	};
	desiredPort = boundPort;
	return boundPort;
}

/** Stop the HTTP server. Idempotent. */
export async function stopServer(
	_runtime: RoutineRuntimeState,
	options: { preserveIntent?: boolean } = {},
): Promise<void> {
	if (!options.preserveIntent) desiredPort = null;
	if (closing) return closing;
	if (!active) return;
	const { server } = active;
	active = null;
	closing = new Promise<void>((resolve) => {
		server.close(() => resolve());
		// Force-close any keepalive connections so we don't hang on shutdown.
		server.closeAllConnections?.();
	});
	await closing;
	closing = null;
}

/** Restart the API server after extension reload when it was previously running. */
export async function restartServerIfConfigured(
	runtime: RoutineRuntimeState,
	ctx: StartContext,
): Promise<number | null> {
	if (desiredPort === null) return null;
	return startServer(runtime, desiredPort, ctx);
}

async function handleRequest(
	req: IncomingMessage,
	res: ServerResponse,
	runtime: RoutineRuntimeState,
	ctx: StartContext,
): Promise<void> {
	if (!active) {
		res.writeHead(503);
		res.end();
		return;
	}
	active.requestCount++;
	req.setTimeout(REQUEST_TIMEOUT_MS, () => {
		req.destroy(new Error("request timeout"));
	});

	// 1. Loopback re-check (defense in depth).
	if (!isLoopback(req.socket.remoteAddress ?? undefined)) {
		res.writeHead(403);
		res.end();
		return;
	}

	// 2. Method.
	if (req.method !== "POST") {
		res.writeHead(405);
		res.end();
		return;
	}

	// 3. Host header allowlist (DNS-rebinding defense).
	if (!isAllowedHost(req.headers.host, active.port)) {
		res.writeHead(403);
		res.end();
		return;
	}

	// 4. Route parse: POST /routines/:id/trigger or Claude-style /fire.
	const url = req.url ?? "";
	const m = /^\/routines\/([^/]+)\/(?:trigger|fire)$/.exec(url);
	if (!m) {
		res.writeHead(404);
		res.end();
		return;
	}
	const routineId = decodeURIComponent(m[1] ?? "");

	// 5. Auth.
	const authHeader = req.headers.authorization ?? "";
	const bearer = /^Bearer\s+(.+)$/i.exec(authHeader)?.[1]?.trim();
	if (!bearer) {
		res.writeHead(401);
		res.end();
		return;
	}
	const routine = resolveRoutine(runtime.store, routineId);
	const ok = await verifyToken(routine?.id ?? "__missing__", bearer);
	if (!routine || !ok) {
		res.writeHead(401);
		res.end();
		return;
	}

	// 6. Confirm the routine actually has an "api" trigger.
	const apiTrigger = routine.triggers.find((t): t is ApiTrigger => t.kind === "api");
	if (!apiTrigger) {
		res.writeHead(404);
		res.end();
		return;
	}

	// 6b. Paused routines refuse api fires (HTTP 423 Locked). Resume with
	// /routine-resume to re-enable.
	if (routine.paused) {
		const triggerIndex = routine.triggers.indexOf(apiTrigger);
		recordSkippedFire(
			runtime,
			runtime.store,
			routine,
			{ index: triggerIndex, kind: "api" },
			"paused",
		);
		res.writeHead(423, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: "routine is paused" }));
		return;
	}

	// 7. Rate-limit.
	if (isRateLimited(active, routine.id)) {
		res.writeHead(429);
		res.end();
		return;
	}

	// 8. Body parse (optional).
	let bodyText = "";
	try {
		bodyText = await readBody(req);
	} catch (err) {
		res.writeHead((err as Error).message === "body too large" ? 413 : 408);
		res.end();
		return;
	}
	let args: Record<string, unknown> | null = null;
	if (bodyText.length > 0) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(bodyText);
		} catch {
			res.writeHead(400);
			res.end();
			return;
		}
		if (parsed && typeof parsed === "object" && "args" in (parsed as object)) {
			const raw = (parsed as { args: unknown }).args;
			if (apiTrigger.allowArgs) {
				args = sanitizeArgs(raw);
				if (args === null && raw !== undefined) {
					res.writeHead(400);
					res.end();
					return;
				}
			}
			// If allowArgs is false, args are silently dropped.
		} else if (parsed && typeof parsed === "object" && "text" in (parsed as object)) {
			const rawText = (parsed as { text: unknown }).text;
			if (typeof rawText !== "string") {
				res.writeHead(400);
				res.end();
				return;
			}
			if (apiTrigger.allowArgs) {
				args = sanitizeArgs({ text: rawText });
				if (args === null) {
					res.writeHead(400);
					res.end();
					return;
				}
			}
		}
	}

	// 9. Enqueue (same logic shape as scheduler.onTriggerFire).
	const runId = nanoid();
	const triggerIndex = routine.triggers.indexOf(apiTrigger);

	enqueueFireRequest(
		routine,
		triggerIndex,
		runtime,
		ctx.pi,
		ctx.getCtx,
		args ? { runId, apiArgs: args } : { runId },
	);

	res.writeHead(202, { "content-type": "application/json" });
	res.end(JSON.stringify({ runId }));
}

/**
 * @file tokens.ts — per-routine bearer tokens for the HTTP trigger.
 *
 * Tokens are 32-byte random hex strings, keyed by routine id, persisted to
 * `${HOME}/.pi/agent/extensions/routines/tokens.json` (falls back to
 * `/tmp/pi-routines-tokens.json` when HOME is unset).
 *
 * Security:
 *   - File is created with mode `0o600` (owner read/write only).
 *   - {@link loadTokens} refuses to read a file whose mode is wider than
 *     `0o600` — throws so the operator notices.
 *   - {@link verifyToken} uses `crypto.timingSafeEqual`.
 *   - Tokens are NEVER logged in full — use {@link maskToken}.
 *
 * The store is a flat record `{ [routineId]: tokenHex }`. We never store a
 * hash — the file is the secret. Defense relies on file mode + filesystem
 * permissions, same posture as `~/.ssh/id_*` private keys.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";

/** Absolute path of the persisted token file. */
export const TOKEN_FILE: string = `${process.env.HOME || homedir()}/.pi/agent/extensions/routines/tokens.json`;

/** Permissive bits we will not tolerate: anything broader than 0o600. */
const MAX_ALLOWED_MODE = 0o600;

interface TokenFile {
	tokens: Record<string, string>;
}

/** In-memory cache so verifyToken doesn't hit disk per request. */
let cache: TokenFile | null = null;
let loadPromise: Promise<TokenFile> | null = null;
let mutationChain: Promise<void> = Promise.resolve();

/**
 * Refuse to load if the on-disk file is more permissive than `0o600`. A
 * `tokens.json` with mode 0o644 means another local user could exfiltrate
 * the secret — fail loudly rather than continue.
 */
async function assertSafeMode(path: string): Promise<void> {
	const st = await fs.stat(path);
	const modeBits = st.mode & 0o777;
	if (modeBits & ~MAX_ALLOWED_MODE) {
		throw new Error(
			`pi-routines: refusing to read ${path} — file mode ${modeBits.toString(8)} is wider than 600. ` +
				`Run: chmod 600 ${path}`,
		);
	}
}

/** Refuse server startup when an existing token store has unsafe permissions. */
export async function assertTokenStoreSafe(): Promise<void> {
	try {
		await assertSafeMode(TOKEN_FILE);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}
}

/** Load tokens from disk (or cache). */
export async function loadTokens(): Promise<TokenFile> {
	if (cache) return cache;
	if (!loadPromise) {
		loadPromise = (async () => {
			try {
				await assertSafeMode(TOKEN_FILE);
			} catch (err) {
				const code = (err as NodeJS.ErrnoException).code;
				if (code === "ENOENT") {
					cache = { tokens: {} };
					return cache;
				}
				throw err;
			}
			const raw = await fs.readFile(TOKEN_FILE, "utf8");
			try {
				const parsed = JSON.parse(raw) as Partial<TokenFile>;
				cache = { tokens: { ...(parsed.tokens ?? {}) } };
			} catch {
				cache = { tokens: {} };
			}
			return cache;
		})().finally(() => {
			loadPromise = null;
		});
	}
	return loadPromise;
}

/** Persist atomically with mode 0o600. Callers serialize mutations. */
async function saveTokens(data: TokenFile): Promise<void> {
	const dir = dirname(TOKEN_FILE);
	const tmp = `${TOKEN_FILE}.tmp.${randomBytes(4).toString("hex")}`;
	await fs.mkdir(dir, { recursive: true });
	try {
		const fh = await fs.open(tmp, "w", 0o600);
		try {
			await fh.writeFile(JSON.stringify(data, null, 2), "utf8");
		} finally {
			await fh.close();
		}
		await fs.chmod(tmp, 0o600);
		await fs.rename(tmp, TOKEN_FILE);
		await fs.chmod(TOKEN_FILE, 0o600);
		cache = data;
	} catch (err) {
		await fs.rm(tmp, { force: true });
		throw err;
	}
}

async function mutateTokens<T>(mutate: (next: TokenFile) => T): Promise<T> {
	let result!: T;
	const operation = mutationChain.then(async () => {
		const current = await loadTokens();
		const next = { tokens: { ...current.tokens } };
		result = mutate(next);
		await saveTokens(next);
	});
	mutationChain = operation.catch(() => {});
	await operation;
	return result;
}

/** Reset the in-memory cache (test hook). */
export function _resetTokenCache(): void {
	cache = null;
	loadPromise = null;
}

/** Create + persist a fresh token for a routine. Returns the plaintext token. */
export async function generateToken(routineId: string): Promise<string> {
	const token = randomBytes(32).toString("hex");
	await mutateTokens((data) => {
		data.tokens[routineId] = token;
	});
	return token;
}

/** Constant-time check of presented token vs stored. */
export async function verifyToken(routineId: string, presented: string): Promise<boolean> {
	const data = await loadTokens();
	const stored = data.tokens[routineId];
	if (!stored) return false;
	// Both must be same length for timingSafeEqual; reject mismatched lengths
	// without leaking via early return path (length check is itself O(1)).
	const a = Buffer.from(stored, "utf8");
	const b = Buffer.from(presented, "utf8");
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}

/** Replace any existing token. Returns the new plaintext. */
export async function rotateToken(routineId: string): Promise<string> {
	return generateToken(routineId);
}

/** Remove the token for a routine. */
export async function revokeToken(routineId: string): Promise<void> {
	await mutateTokens((data) => {
		delete data.tokens[routineId];
	});
}

/** Look up the stored token (used by `/routine-token show`). */
export async function getStoredToken(routineId: string): Promise<string | null> {
	const data = await loadTokens();
	return data.tokens[routineId] ?? null;
}

/** Mask a token for log/display: first 8 chars + "...". */
export function maskToken(token: string): string {
	if (token.length <= 8) return "********";
	return `${token.slice(0, 8)}...`;
}

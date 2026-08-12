/**
 * @file path-probe.ts — pure Node-side "is this tool installed?" check.
 *
 * Replaces the POSIX-only `which <tool>` invocation that
 * {@link registerRoutineInstallCommand} used to do via `pi.exec`. The probe
 * walks `process.env.PATH` (using `path.delimiter` for cross-platform
 * splitting) and on Windows also tries each entry of `PATHEXT` (`.EXE`,
 * `.CMD`, `.BAT`, …) so e.g. `node` → `node.exe` is found correctly.
 *
 * No shell is spawned; no `pi.exec` round-trip. Returns boolean only —
 * callers don't need the absolute path.
 *
 * Test seam: {@link isToolOnPath} accepts an optional `env` argument so
 * tests can pass a synthetic PATH without polluting the process env.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";

const IS_WIN = process.platform === "win32";

/** Default PATHEXT used on Windows when the env var is missing. */
const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

interface ProbeEnv {
	PATH?: string;
	PATHEXT?: string;
}

/**
 * Return true when an executable named `tool` is reachable via the current
 * `PATH`. On Windows, `tool` is tried verbatim and again with each
 * `PATHEXT` suffix. On POSIX, the file must be regular and executable
 * by the current process (X_OK).
 *
 * Bare names only — callers must not pass a path with separators; if the
 * caller already has an absolute path it's their responsibility to check
 * it directly.
 */
export async function isToolOnPath(tool: string, env: ProbeEnv = process.env): Promise<boolean> {
	if (!tool || tool.includes("/") || tool.includes("\\")) return false;
	const pathVar = env.PATH ?? "";
	if (!pathVar) return false;

	const entries = pathVar.split(path.delimiter).filter(Boolean);
	const exts = IS_WIN ? (env.PATHEXT ?? DEFAULT_PATHEXT).split(";").filter(Boolean) : [""]; // POSIX: just the bare name

	for (const dir of entries) {
		for (const ext of exts) {
			const candidate = path.join(dir, tool + ext);
			try {
				if (IS_WIN) {
					// On Windows, fs.access(X_OK) is unreliable — existence is
					// enough since PATHEXT entries are executable by definition.
					await fs.access(candidate, fs.constants.F_OK);
					const stat = await fs.stat(candidate);
					if (!stat.isFile()) continue;
				} else {
					await fs.access(candidate, fs.constants.X_OK);
					const stat = await fs.stat(candidate);
					if (!stat.isFile()) continue;
				}
				return true;
			} catch {
				/* not found in this dir; keep looking */
			}
		}
	}
	return false;
}

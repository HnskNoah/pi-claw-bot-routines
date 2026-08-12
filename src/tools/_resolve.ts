/**
 * @file _resolve.ts — single source of truth for id/name resolution.
 *
 * Every caller (LLM tools, slash commands, HTTP server) goes through these
 * helpers. Resolution prefers exact id match, then case-insensitive name.
 *
 * Two overloads are accepted:
 *   - `resolveRoutine(store, id?, name?)` — explicit split (tool args)
 *   - `resolveRoutine(store, idOrName)`   — single arg, tries id then name
 *     (slash commands and the HTTP server use this shape)
 */

import type { Routine, RoutineStore } from "../types.ts";

/**
 * Resolve a routine by id first (exact), then by case-insensitive name.
 *
 * Accepts either a single `idOrName` (tries both interpretations) or the
 * explicit `(id?, name?)` shape used by typed tool args. Returns `null`
 * when nothing matches; callers craft their own error messages.
 */
export function resolveRoutine(store: RoutineStore, idOrName: string): Routine | null;
export function resolveRoutine(store: RoutineStore, id?: string, name?: string): Routine | null;
export function resolveRoutine(store: RoutineStore, a?: string, b?: string): Routine | null {
	const id = a;
	const name = b ?? a;
	if (id) {
		const byId = store.routines[id];
		if (byId) return byId;
	}
	if (name) {
		const lower = name.toLowerCase();
		for (const r of Object.values(store.routines)) {
			if (r.name.toLowerCase() === lower) return r;
		}
	}
	return null;
}

/** Comma-separated list of current routine names (for "not found" errors). */
export function listRoutineNames(store: RoutineStore): string {
	const names = Object.values(store.routines)
		.map((r) => r.name)
		.sort();
	return names.length === 0 ? "(none)" : names.join(", ");
}

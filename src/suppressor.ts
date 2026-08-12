/**
 * @file suppressor.ts — message_end interceptor that collapses `[~]` (silent
 * token) assistant responses produced by routine turns into a single compact
 * status line when the active routine is configured with `quiet: true`.
 *
 * Wired by `extensions/index.ts`. The handler only fires while
 * {@link RoutineRuntimeState.isRoutineTurnActive} is true, so user-driven
 * assistant turns are never modified.
 *
 * Amendment (TP-003): PLAN.md showed `text.trimStart().startsWith(SILENT_TOKEN)`,
 * which would suppress responses like `"[~] but actually the build failed"`.
 * We use exact-equality on the trimmed text instead — the LLM only loses its
 * message when the *entire* response is the silent token. See PROMPT.md.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateSnippet } from "./executor.ts";
import { type RoutineRuntimeState, SILENT_TOKEN } from "./types.ts";

/**
 * Minimal structural shape of an AgentMessage — sufficient for text extraction.
 * The real type (pi-agent-core `AgentMessage`) is not re-exported by
 * pi-coding-agent's package entry, so we duck-type instead.
 */
type MessageLike = { role: string; content: unknown };

/**
 * Extract concatenated text from any AgentMessage. Text blocks are joined by
 * newlines. Returns `""` if there are no text blocks (e.g. image-only or
 * tool-result messages).
 */
export function extractText(message: MessageLike): string {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (
			block &&
			typeof block === "object" &&
			(block as { type?: unknown }).type === "text" &&
			typeof (block as { text?: unknown }).text === "string"
		) {
			parts.push((block as { text: string }).text);
		}
	}
	return parts.join("\n");
}

/**
 * Register the suppression handler on `message_end`. Idempotent only at the
 * call-site level — call once per extension load.
 */
export function registerSuppressor(pi: ExtensionAPI, runtime: RoutineRuntimeState): void {
	pi.on("message_end", (event) => {
		if (!runtime.isRoutineTurnActive) return undefined;
		if (event.message.role !== "assistant") return undefined;

		const text = extractText(event.message);
		const routine = runtime.pendingRun
			? runtime.store.routines[runtime.pendingRun.routineId]
			: undefined;
		const isQuietRoutine = routine?.quiet === true;

		// Populate the in-flight run record (if any) with the response snippet.
		// agent_end will finalise + persist it.
		if (runtime.pendingRun) {
			const trimmed = text.trim();
			if (isQuietRoutine && trimmed === SILENT_TOKEN) {
				runtime.pendingRun.status = "silent";
				runtime.pendingRun.snippet = SILENT_TOKEN;
			} else if (text.length > 0) {
				runtime.pendingRun.snippet = truncateSnippet(text);
			}
		}

		if (text.length === 0) return undefined;

		// Exact-equality check (see file header amendment). LLM may pad the
		// token with whitespace; anything more substantial passes through.
		if (text.trim() !== SILENT_TOKEN) return undefined;
		if (!isQuietRoutine) return undefined;

		const name = routine?.name ?? runtime.activeRoutineName ?? "routine";
		const routineId = routine?.id ?? lookupRoutineIdByName(runtime, name);
		const tickCount = routineId ? (runtime.store.tickState[routineId]?.tickCount ?? 0) : 0;
		const time = new Date().toLocaleTimeString([], {
			hour: "2-digit",
			minute: "2-digit",
		});

		return {
			message: {
				...event.message,
				content: [
					{
						type: "text",
						text: `↺ ${name} · quiet · tick ${tickCount} · ${time}`,
					},
				],
			},
		};
	});
}

function lookupRoutineIdByName(runtime: RoutineRuntimeState, name: string): string | undefined {
	for (const [id, routine] of Object.entries(runtime.store.routines)) {
		if (routine.name === name) return id;
	}
	return undefined;
}

/**
 * @file routine-install.ts — `/routine-install <template>` slash command.
 *
 * Reads `templates/<name>.json` (name sanitized against [a-z0-9-]+),
 * minimally validates it as a `RoutineTemplate`, runs `which <tool>` for
 * each `requiredTools` entry (warns only — does not block), and creates
 * the routine via `_mutate.createRoutine`. Provides tab-completion over
 * the templates directory.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { isToolOnPath } from "../path-probe.ts";
import { createRoutine, type TriggerInput } from "../tools/_mutate.ts";
import type { RoutineRuntimeState, RoutineTemplate } from "../types.ts";
import { TEMPLATES_DIR } from "../types.ts";

const SYSTEM_MSG_TYPE = "pi-routines/system";
const NAME_RE = /^[a-z0-9-]+$/;

function send(pi: ExtensionAPI, text: string): void {
	pi.sendMessage({
		customType: SYSTEM_MSG_TYPE,
		content: text,
		display: true,
	});
}

/** List available template names (filenames in TEMPLATES_DIR without .json). */
function listTemplateNames(): string[] {
	try {
		return fs
			.readdirSync(TEMPLATES_DIR)
			.filter((f) => f.endsWith(".json"))
			.map((f) => f.slice(0, -".json".length))
			.sort();
	} catch {
		return [];
	}
}

/** Allowed trigger kinds in templates (mirror of TriggerInput.kind). */
const ALLOWED_TRIGGER_KINDS = new Set(["pulse", "cron", "oneoff", "hook", "api", "github"]);

/**
 * Minimal shape check; throws on missing required fields. Per-kind detail
 * validation (interval parsing, cron syntax, github repo shape, …) is left
 * to `_mutate.resolveTrigger` so the install path and the LLM tool path
 * report errors identically.
 */
function validateTemplate(raw: unknown): RoutineTemplate {
	if (!raw || typeof raw !== "object") throw new Error("not an object");
	const t = raw as Record<string, unknown>;
	if (typeof t.name !== "string" || !t.name) throw new Error("missing 'name'");
	if (typeof t.description !== "string") throw new Error("missing 'description'");
	if (typeof t.prompt !== "string" || !t.prompt) throw new Error("missing 'prompt'");
	if (typeof t.quiet !== "boolean") throw new Error("missing 'quiet'");

	const triggers: unknown[] = [];
	if (t.trigger !== undefined) triggers.push(t.trigger);
	if (Array.isArray(t.triggers)) triggers.push(...t.triggers);
	if (triggers.length === 0) throw new Error("template needs 'trigger' or 'triggers'");

	for (let i = 0; i < triggers.length; i++) {
		const trig = triggers[i] as Record<string, unknown> | undefined;
		if (!trig || typeof trig !== "object") throw new Error(`trigger #${i + 1} not an object`);
		if (typeof trig.kind !== "string" || !ALLOWED_TRIGGER_KINDS.has(trig.kind)) {
			throw new Error(
				`trigger #${i + 1}: unknown kind '${String(trig.kind)}'. Expected one of pulse|cron|oneoff|hook|api|github.`,
			);
		}
		if (trig.kind === "pulse" && typeof trig.interval !== "string") {
			throw new Error(`trigger #${i + 1}: pulse missing 'interval'`);
		}
		if (trig.kind === "cron" && typeof trig.expr !== "string") {
			throw new Error(`trigger #${i + 1}: cron missing 'expr'`);
		}
		if (trig.kind === "oneoff" && typeof trig.fireAtIso !== "string") {
			throw new Error(`trigger #${i + 1}: oneoff missing 'fireAtIso'`);
		}
		if (trig.kind === "hook" && typeof trig.event !== "string") {
			throw new Error(`trigger #${i + 1}: hook missing 'event'`);
		}
		if (trig.kind === "github") {
			if (typeof trig.repo !== "string") {
				throw new Error(`trigger #${i + 1}: github missing 'repo'`);
			}
			if (typeof trig.event !== "string") {
				throw new Error(`trigger #${i + 1}: github missing 'event'`);
			}
		}
	}
	return raw as RoutineTemplate;
}

/** Register `/routine-install`. */
export function registerRoutineInstallCommand(
	pi: ExtensionAPI,
	runtime: RoutineRuntimeState,
	getCtx: () => ExtensionContext | null,
): void {
	pi.registerCommand("routine-install", {
		description: "Install a bundled routine template: /routine-install <name>",
		getArgumentCompletions(prefix: string): AutocompleteItem[] {
			const lower = (prefix ?? "").toLowerCase();
			return listTemplateNames()
				.filter((n) => n.toLowerCase().startsWith(lower))
				.map((name) => ({ value: name, label: name }));
		},
		async handler(args: string): Promise<void> {
			const [name = "", repoOverride, ...extra] = args.trim().split(/\s+/).filter(Boolean);
			if (!name) {
				const available = listTemplateNames().join(", ") || "(none)";
				send(pi, `Usage: /routine-install <template> [owner/repo]\nAvailable: ${available}`);
				return;
			}
			if (extra.length > 0) {
				send(pi, "Usage: /routine-install <template> [owner/repo]");
				return;
			}
			if (!NAME_RE.test(name)) {
				send(pi, `Invalid template name '${name}'. Use lowercase letters, digits, hyphens only.`);
				return;
			}
			const file = path.join(TEMPLATES_DIR, `${name}.json`);
			if (!fs.existsSync(file)) {
				const available = listTemplateNames().join(", ") || "(none)";
				send(pi, `Template '${name}' not found in ${TEMPLATES_DIR}. Available: ${available}`);
				return;
			}
			let template: RoutineTemplate;
			try {
				const raw = JSON.parse(fs.readFileSync(file, "utf8"));
				template = validateTemplate(raw);
			} catch (err) {
				send(pi, `Failed to load template '${name}': ${(err as Error).message}`);
				return;
			}

			// requiredTools: warn (do not block) on missing. Cross-platform
			// PATH walk — avoids hard-coding `which` (Unix) vs `where` (Win).
			const warnings: string[] = [];
			for (const tool of template.requiredTools ?? []) {
				try {
					const found = await isToolOnPath(tool);
					if (!found) {
						warnings.push(`tool '${tool}' not found on PATH; routine may fail until installed`);
					}
				} catch {
					warnings.push(`could not check for tool '${tool}'`);
				}
			}

			// Collect every trigger in template order (single + array forms).
			// Templates use the same raw shape that the LLM tool / slash
			// commands use, so we can pass them straight through.
			const triggers: TriggerInput[] = [];
			if (template.trigger) triggers.push(template.trigger as TriggerInput);
			if (template.triggers && template.triggers.length > 0) {
				for (const t of template.triggers) triggers.push(t as TriggerInput);
			}
			let usedRepoOverride = false;
			for (const trigger of triggers) {
				if (trigger.kind !== "github" || trigger.repo.toLowerCase() !== "owner/name") continue;
				if (!repoOverride || !/^[^/?#\s]+\/[^/?#\s]+$/.test(repoOverride)) {
					send(
						pi,
						`Template '${name}' needs a repository: ` + `/routine-install ${name} owner/repo`,
					);
					return;
				}
				trigger.repo = repoOverride;
				usedRepoOverride = true;
			}
			if (repoOverride && !usedRepoOverride) {
				send(pi, `Template '${name}' does not accept a repository override.`);
				return;
			}

			const result = await createRoutine(
				{
					name: template.name,
					prompt: template.prompt,
					triggers,
					quiet: template.quiet,
					...(template.maxTicks !== undefined ? { maxTicks: template.maxTicks } : {}),
					...(template.maxRunsPerDay !== undefined
						? { maxRunsPerDay: template.maxRunsPerDay }
						: {}),
				},
				runtime,
				pi,
				getCtx,
			);
			if ("error" in result) {
				send(pi, `Error: ${result.error}`);
				return;
			}
			const parts: string[] = [`Installed '${result.name}' — fires ${result.triggerDescription}.`];
			if (result.nextFireIn) parts.push(`Next fire in ~${result.nextFireIn}.`);
			parts.push("Use `/routines` to inspect.");
			if (warnings.length > 0) {
				parts.push("\nWarnings:");
				for (const w of warnings) parts.push(`  - ${w}`);
			}
			send(pi, parts.join(" "));
		},
	});
}

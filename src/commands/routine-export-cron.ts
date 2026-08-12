/**
 * @file routine-export-cron.ts — `/routine-export-cron <name>` slash command.
 *
 * Emits a `crontab` line, a `launchd` plist, and a prompt file for a
 * pulse routine. Refuses hook routines (no time component) and pulses
 * with interval > 60m (use a daily cron manually). Writes the helper
 * files to `~/.pi/routines/{prompts,launchd}/`, but does NOT modify the
 * user's crontab or load the launchd job — v1 prints copy-paste
 * instructions only.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { resolveRoutine } from "../tools/_mutate.ts";
import type { RoutineRuntimeState } from "../types.ts";

const SYSTEM_MSG_TYPE = "pi-routines/system";
const MIN_CRON_MS = 60 * 1000;
const MAX_CRON_MS = 60 * 60 * 1000;
const NAME_RE = /^[a-z0-9-]+$/;

function send(pi: ExtensionAPI, text: string): void {
	pi.sendMessage({
		customType: SYSTEM_MSG_TYPE,
		content: text,
		display: true,
	});
}

/**
 * Build a `"*" + "/N * * * *"` cron schedule clamped to 1..60 minutes.
 * (Star-slash-N is split here to avoid closing the JSDoc block.)
 * Callers validate that the interval is an exact divisor of one hour.
 */
function cronSchedule(intervalMs: number): string {
	const minutes = intervalMs / 60_000;
	return `*/${minutes} * * * *`;
}

function buildPlist(label: string, intervalSeconds: number, promptFile: string): string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>pi --print "$(cat ${promptFile})"</string>
  </array>
  <key>StartInterval</key>
  <integer>${intervalSeconds}</integer>
  <key>RunAtLoad</key>
  <false/>
</dict>
</plist>
`;
}

/** Register `/routine-export-cron`. */
export function registerRoutineExportCronCommand(
	pi: ExtensionAPI,
	runtime: RoutineRuntimeState,
): void {
	pi.registerCommand("routine-export-cron", {
		description: "Export a routine as cron + launchd + prompt files: /routine-export-cron <name>",
		getArgumentCompletions(prefix: string): AutocompleteItem[] {
			const lower = (prefix ?? "").toLowerCase();
			return Object.values(runtime.store.routines)
				.map((r) => r.name)
				.filter((n) => n.toLowerCase().startsWith(lower))
				.sort()
				.map((name) => ({ value: name, label: name }));
		},
		async handler(args: string): Promise<void> {
			const target = args.trim();
			if (!target) {
				send(pi, "Usage: /routine-export-cron <name>");
				return;
			}
			const routine = resolveRoutine(target, runtime);
			if (!routine) {
				send(pi, `No routine matched '${target}'. Use /routines to list, or check the name.`);
				return;
			}
			const pulse = routine.triggers.find((t) => t.kind === "pulse");
			if (!pulse) {
				send(
					pi,
					"Only pulse triggers can be exported to cron. This routine has no " +
						"pulse trigger — use a pulse routine if you need time-based " +
						"persistence outside Pi.",
				);
				return;
			}
			if (pulse.intervalMs > MAX_CRON_MS) {
				send(
					pi,
					`Interval ${pulse.intervalHuman} is longer than 60m; cron's */N syntax ` +
						"can't represent it cleanly. Set a daily cron manually, e.g. `0 9 * * *`, " +
						"pointing at the prompt file this command would have written.",
				);
				return;
			}
			const minutes = pulse.intervalMs / 60_000;
			if (pulse.intervalMs < MIN_CRON_MS || !Number.isInteger(minutes) || 60 % minutes !== 0) {
				send(
					pi,
					`Interval ${pulse.intervalHuman} cannot be represented exactly by a portable ` +
						"5-field cron schedule. Use launchd/systemd directly or choose a whole-minute " +
						"interval that divides 60 (1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, or 60m).",
				);
				return;
			}
			if (!NAME_RE.test(routine.name)) {
				// Defensive: routine names already pass NAME_RE on create, but make
				// the path-safety check explicit at the filesystem boundary.
				send(pi, `Routine name '${routine.name}' is unsafe for filesystem export.`);
				return;
			}

			const home = process.env.HOME ?? os.homedir();
			const promptsDir = path.join(home, ".pi", "routines", "prompts");
			const launchdDir = path.join(home, ".pi", "routines", "launchd");
			const promptFile = path.join(promptsDir, `${routine.name}.txt`);
			const label = `com.pi-routines.${routine.name}`;
			const plistFile = path.join(launchdDir, `${label}.plist`);
			const cronLine = `${cronSchedule(pulse.intervalMs)} pi --print "$(cat ${promptFile})"`;
			const plistBody = buildPlist(
				label,
				Math.max(60, Math.floor(pulse.intervalMs / 1000)),
				promptFile,
			);

			try {
				fs.mkdirSync(promptsDir, { recursive: true });
				fs.mkdirSync(launchdDir, { recursive: true });
				fs.writeFileSync(promptFile, `${routine.prompt}\n`, "utf8");
				fs.writeFileSync(plistFile, plistBody, "utf8");
			} catch (err) {
				send(pi, `Failed to write export files: ${(err as Error).message}`);
				return;
			}

			const out = [
				`Exported '${routine.name}' (fires every ${pulse.intervalHuman}).`,
				"",
				`Prompt file: ${promptFile}`,
				`launchd plist: ${plistFile}`,
				"",
				"Crontab line (append to your crontab manually with `crontab -e`):",
				`  ${cronLine}`,
				"",
				`launchd: load with \`launchctl load ${plistFile}\` if you prefer launchd over cron.`,
				"",
				"This command does NOT modify your crontab or load the launchd job.",
			].join("\n");
			send(pi, out);
		},
	});
}

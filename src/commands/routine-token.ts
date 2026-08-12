/**
 * @file routine-token.ts — `/routine-token generate|rotate|show|revoke <id|name>`.
 *
 * Print-once policy: `generate` and `rotate` echo the new plaintext token
 * exactly once. `show` prints only the masked prefix. The CLI does NOT
 * support re-reading a token after creation — the operator must rotate.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { generateToken, getStoredToken, maskToken, revokeToken, rotateToken } from "../tokens.ts";
import { listRoutineNames, resolveRoutine } from "../tools/_resolve.ts";
import type { RoutineRuntimeState } from "../types.ts";

const SYSTEM_MSG_TYPE = "pi-routines/system";

export function registerRoutineTokenCommand(pi: ExtensionAPI, runtime: RoutineRuntimeState): void {
	pi.registerCommand("routine-token", {
		description:
			"Manage API trigger tokens: /routine-token <generate|rotate|show|revoke> <id|name>",
		getArgumentCompletions(prefix: string): AutocompleteItem[] {
			const parts = (prefix ?? "").split(/\s+/);
			if (parts.length <= 1) {
				return ["generate", "rotate", "show", "revoke"]
					.filter((s) => s.startsWith(parts[0] ?? ""))
					.map((value) => ({ value, label: value }));
			}
			const lower = (parts[1] ?? "").toLowerCase();
			return Object.values(runtime.store.routines)
				.map((r) => r.name)
				.filter((n) => n.toLowerCase().startsWith(lower))
				.sort()
				.map((name) => ({ value: `${parts[0]} ${name}`, label: name }));
		},
		async handler(args: string): Promise<void> {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const sub = (parts[0] ?? "").toLowerCase();
			const target = parts.slice(1).join(" ").trim();
			if (!sub || !target) {
				pi.sendMessage({
					customType: SYSTEM_MSG_TYPE,
					content: "Usage: /routine-token <generate|rotate|show|revoke> <id|name>",
					display: true,
				});
				return;
			}
			const routine = resolveRoutine(runtime.store, target, target);
			if (!routine) {
				pi.sendMessage({
					customType: SYSTEM_MSG_TYPE,
					content: `Error: no routine matches '${target}'. Known: ${listRoutineNames(runtime.store)}`,
					display: true,
				});
				return;
			}
			if (
				(sub === "generate" || sub === "rotate") &&
				!routine.triggers.some((trigger) => trigger.kind === "api")
			) {
				pi.sendMessage({
					customType: SYSTEM_MSG_TYPE,
					content: `Error: '${routine.name}' has no api trigger, so it cannot use a bearer token.`,
					display: true,
				});
				return;
			}

			switch (sub) {
				case "generate": {
					const token = await generateToken(routine.id);
					pi.sendMessage({
						customType: SYSTEM_MSG_TYPE,
						content:
							`Token for '${routine.name}' (id: ${routine.id}):\n\n${token}\n\n` +
							`⚠ This is the ONLY time the full token will be shown. Save it now. ` +
							`Use /routine-token rotate to replace.`,
						display: true,
					});
					return;
				}
				case "rotate": {
					const token = await rotateToken(routine.id);
					pi.sendMessage({
						customType: SYSTEM_MSG_TYPE,
						content:
							`Rotated token for '${routine.name}':\n\n${token}\n\n` +
							`⚠ Previous token revoked. Save this one — it won't be shown again.`,
						display: true,
					});
					return;
				}
				case "show": {
					const tok = await getStoredToken(routine.id);
					if (!tok) {
						pi.sendMessage({
							customType: SYSTEM_MSG_TYPE,
							content: `No token set for '${routine.name}'. Use /routine-token generate.`,
							display: true,
						});
						return;
					}
					pi.sendMessage({
						customType: SYSTEM_MSG_TYPE,
						content: `Token for '${routine.name}': ${maskToken(tok)} (use rotate to replace)`,
						display: true,
					});
					return;
				}
				case "revoke": {
					await revokeToken(routine.id);
					pi.sendMessage({
						customType: SYSTEM_MSG_TYPE,
						content: `Token for '${routine.name}' revoked.`,
						display: true,
					});
					return;
				}
				default:
					pi.sendMessage({
						customType: SYSTEM_MSG_TYPE,
						content: `Unknown subcommand '${sub}'. Use generate|rotate|show|revoke.`,
						display: true,
					});
			}
		},
	});
}

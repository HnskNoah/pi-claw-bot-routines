/**
 * @file schedule-nl.ts — natural-language → `RoutineCreate` meta-prompt.
 *
 * The `/schedule` slash command (see `commands/schedule.ts`) is a thin
 * wrapper that:
 *   1. Builds a meta-prompt (this file) describing the `RoutineCreate`
 *      tool surface and current local time.
 *   2. Submits it via `pi.sendUserMessage` so the active session's LLM
 *      processes it in-band, calling `RoutineCreate` as its only useful tool.
 *
 * Splitting prompt construction out of the command keeps the moving parts
 * unit-testable: `schedule-nl.test.ts` asserts the meta-prompt mentions the
 * tool name, current timezone, and the user's request verbatim, then feeds
 * a synthetic LLM JSON response into the same TypeBox schema the tool uses
 * at runtime, proving the contract round-trips.
 *
 * No LLM call lives here — the command file owns side effects.
 */

/** Inputs to the meta-prompt builder. */
export interface ScheduleNLInputs {
	/** User's free-text request, exactly as typed after `/schedule `. */
	userRequest: string;
	/** Reference time (epoch ms). Defaults to now; injected for tests. */
	now?: number;
	/** IANA timezone label to anchor relative phrases ("tomorrow", "9am"). */
	timezone?: string;
}

const TOOL_SURFACE = `
RoutineCreate parameters (TypeBox schema, summarised):
  name:    string — lowercase letters/digits/hyphens, max 32 chars.
  prompt:  string — what to ask Pi when the routine fires. May reference:
            {cwd}, {date}, {time}, {state}, {tickCount},
            {apiArgs}      (only meaningful when an "api" trigger is attached),
            {githubEvent}  (only meaningful when a "github" trigger is attached)
  trigger: one of (pass exactly one):
            { kind: "pulse",  interval: "5m" | "1h" | "1h30m" | ... }
            { kind: "cron",   expr: "0 9 * * 1-5", timezone?: "America/Los_Angeles" }
            { kind: "oneoff", fireAtIso: "2026-06-01T17:00:00Z", timezone?: "..." }
            { kind: "hook",   event: "session_start"|"agent_end"|"session_shutdown",
                              once?: "daily"|"per_session" }
            { kind: "api",    allowArgs?: boolean }
            { kind: "github", repo: "owner/name",
                              event: "pull_request.opened"|"pull_request.closed"|"issues.opened"|"push",
                              pollInterval?: "2m" | "5m",
                              filter?: { labels?: string[], branches?: string[], mergedOnly?: boolean } }
  triggers: optional — array form of the same union for multi-trigger routines (max 4).
  quiet:         optional boolean — suppress [~] in chat.
  maxTicks:      optional integer ≥1 — auto-delete after N fires.
  maxRunsPerDay: optional integer ≥1 — soft cap; runs above the cap are recorded as 'skipped'.
`.trim();

/**
 * Build the meta-prompt sent to the LLM. Must:
 *   - Name the only tool the LLM should invoke (`RoutineCreate`).
 *   - Describe the schema concisely enough that the LLM can pick valid args.
 *   - Anchor relative time phrases by stating the current local time + tz.
 *   - Include the user's literal request so the LLM sees what to parse.
 *
 * Format is fixed across calls so tests can assert key substrings.
 */
export function buildSchedulePrompt(inputs: ScheduleNLInputs): string {
	const now = inputs.now ?? Date.now();
	const tz =
		inputs.timezone ??
		(typeof Intl !== "undefined"
			? Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
			: "UTC");
	const localNow = new Date(now).toLocaleString("en-US", {
		timeZone: tz,
		hour12: false,
	});

	return [
		`The user asked to schedule a routine using natural language.`,
		`Current local time: ${localNow} (${tz}).`,
		``,
		`Use ONLY the RoutineCreate tool to create exactly one routine.`,
		`Pick a short kebab-case name derived from the request.`,
		`Translate the user's timing into the closest matching trigger:`,
		`  - "every N minutes/hours" → pulse with that interval.`,
		`  - "daily at 9am", "every weekday at 9am", "first of the month",`,
		`    or any other clock-aligned cadence → cron with the matching expression`,
		`    (e.g. "0 9 * * *" for daily 9am, "0 9 * * 1-5" for weekdays 9am).`,
		`    Pass the user's local timezone if known, otherwise omit it.`,
		`  - "tomorrow at 9am", "in 2 weeks", "next Friday" → oneoff with the`,
		`    resolved absolute timestamp in ISO-8601 form. Use the user's local zone.`,
		`  - "on session start" / "when the session ends" → hook with the matching`,
		`    event and once: "daily" if the user wants once-per-day.`,
		`  - "when my CI calls a webhook", "trigger from my deploy script" → api`,
		`    (the user must run /routine-server start and generate a token afterwards).`,
		`  - "when a PR opens on owner/repo", "react to issues on github" → github`,
		`    with the appropriate event and an optional filter block. Branch filters`,
		`    apply only to push; labels only to pull-request events.`,
		`  - session_shutdown hooks capture the ended transcript and replay at the`,
		`    next interactive session because Pi tears down immediately on quit.`,
		`Multi-trigger routines: pass a "triggers" array (max 4). Example use case:`,
		`a routine that polls every 10m AND can be fired on demand via API.`,
		`If the request is ambiguous, ask one clarifying question instead of guessing.`,
		``,
		TOOL_SURFACE,
		``,
		`User request: ${inputs.userRequest.trim()}`,
	].join("\n");
}

/** Short help blurb shown when `/schedule` is called with no args. */
export const SCHEDULE_HELP = [
	"Usage: /schedule <natural language>",
	"Examples:",
	"  /schedule every 10 minutes check CI",
	"  /schedule on session start summarise yesterday's PRs",
	"  /schedule every weekday at 9am list my open pull requests",
	"",
	"The active LLM parses your request and calls RoutineCreate.",
	"Use /routine-stop <name> to cancel a routine.",
].join("\n");

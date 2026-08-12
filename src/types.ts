/**
 * @file types.ts — single source of truth for pi-routines shared types & constants.
 *
 * All other modules (store, parser, guard, scheduler, executor, hooks, tools,
 * commands, widget) import their shapes from this file. Downstream tasks read
 * the JSDoc here as the contract.
 */

import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

// ─── Tiers ───────────────────────────────────────────────────────────────────

/** Two top-level kinds of routine: time-based ("pulse") vs. event-based ("hook"). */
export type RoutineTier = "pulse" | "hook";

// ─── Triggers ────────────────────────────────────────────────────────────────

/** Pulse trigger: fires on a fixed interval. */
export interface PulseTrigger {
	kind: "pulse";
	/** Resolved interval in milliseconds. */
	intervalMs: number;
	/** Original human-readable string, e.g. "5m", "1h30m". */
	intervalHuman: string;
}

/**
 * Cron trigger: fires on a 5-field POSIX cron expression.
 *
 * Fields: `minute hour day-of-month month day-of-week`.
 * Supports `*`, `*\/n`, `a,b,c`, `a-b`. Seconds field, `?`, `L`, `#`
 * are rejected by {@link parseCron}.
 */
export interface CronTrigger {
	kind: "cron";
	/** Raw cron expression, e.g. `"0 9 * * 1-5"`. */
	expr: string;
	/** Optional IANA timezone. Defaults to system local time. */
	timezone?: string;
}

/** One-off trigger: fires once at an absolute timestamp. */
export interface OneOffTrigger {
	kind: "oneoff";
	/** ISO-8601 timestamp. May be UTC (`...Z`) or local-in-`timezone`. */
	fireAtIso: string;
	/** Optional IANA timezone (used when `fireAtIso` has no offset). */
	timezone?: string;
	/**
	 * Set to `true` after the trigger fires (or whenever the scheduler
	 * detects the timestamp is already in the past). Spent triggers are
	 * silently skipped at re-arm — without this flag, `/reload` would log
	 * a noisy `parseOneOff` error on every restart.
	 */
	fired?: boolean;
}

/** Lifecycle events a hook routine can subscribe to. */
export type HookEvent = "session_start" | "agent_end" | "session_shutdown";

/**
 * API trigger: routine can be fired by a `POST /routines/:id/trigger`
 * request to the local HTTP server (TP-010). No fields are required — the
 * bearer token is keyed by routine id and stored separately in
 * `tokens.json`. Set `allowArgs: true` to opt in to receiving the
 * caller's JSON `args` as the `{apiArgs}` template variable.
 */
export interface ApiTrigger {
	kind: "api";
	/** When true, accept caller-supplied JSON args and expose as `{apiArgs}`. */
	allowArgs?: boolean;
}

/** Hook trigger: fires on a pi lifecycle event. */
export interface HookTrigger {
	kind: "hook";
	event: HookEvent;
	/**
	 * Optional firing-frequency guard.
	 * - "daily"       : fire at most once per local calendar day
	 * - "per_session" : fire at most once per pi session
	 */
	once?: "daily" | "per_session";
}

/**
 * GitHub trigger: fires when polling `gh` finds previously-unseen events.
 *
 * `cursor` is the highest-seen event id (PR/issue number as string, or
 * commit sha for `push`); persisted across reloads. The poller seeds
 * `cursor` on its first successful tick without firing, so existing items
 * do not trigger a stampede on first arm.
 *
 * Filters:
 *   - `labels`     (pull_request only): all listed labels must be present
 *   - `branches`   (push only):          only commits to one of these refs
 *   - `mergedOnly` (pull_request.closed only): only merged PRs count
 */
export interface GithubTrigger {
	kind: "github";
	/** `"owner/name"`. */
	repo: string;
	// patched by pi: added issues.closed, issues.events, discussion, issue.comment, discussion.comment
	event: "pull_request.opened" | "pull_request.closed" | "issues.opened" | "issues.closed" | "issues.events" | "discussion" | "issue.comment" | "discussion.comment" | "push";
	/** Resolved poll interval in ms. Lower-bounded by MIN_GITHUB_POLL_MS. */
	pollIntervalMs: number;
	filter?: {
		labels?: string[];
		branches?: string[];
		mergedOnly?: boolean;
	};
	/** Last-seen event id. */
	cursor?: string;
	/** Last-seen commit sha per filtered branch. */
	branchCursors?: Record<string, string>;
}

/** Union of all trigger kinds. */
export type RoutineTrigger =
	| PulseTrigger
	| CronTrigger
	| OneOffTrigger
	| HookTrigger
	| GithubTrigger
	| ApiTrigger;

// ─── Context modes ───────────────────────────────────────────────────────────

/**
 * Context mode controls what conversation history the LLM sees when the
 * routine fires.
 *
 * v1 only supports `"session"` (full current session). `"fresh"` is reserved
 * for v2 (subagent isolation).
 */
export type RoutineContext = "session";

// ─── Routine definition ──────────────────────────────────────────────────────

/** A user-defined routine. Stored in {@link RoutineStore.routines}. */
export interface Routine {
	/** nanoid — stable across renames. Primary key in the store. */
	id: string;
	/** User-facing display name; used by /routine-stop. */
	name: string;
	/** Prompt text sent to the LLM when the routine fires. */
	prompt: string;
	/**
	 * One or more triggers. v1 routines (single `trigger`) are migrated to a
	 * single-element array by {@link migrateV1ToV2}. ANY trigger firing
	 * enqueues the routine once.
	 */
	triggers: RoutineTrigger[];
	context: RoutineContext;
	/** If true, suppress `[~]` "nothing to report" responses in chat. */
	quiet: boolean;
	/** Auto-delete after N fires. `undefined` = unlimited. */
	maxTicks?: number;
	/**
	 * Soft per-day cap: once {@link RoutineTickState.runsToday} reaches this
	 * value, further fires are skipped (recorded as `"skipped"` runs with
	 * reason `"daily cap reached"`) until local midnight. `undefined` = no
	 * cap. The cap is enforced inside {@link fireRoutine} before any LLM
	 * turn is opened, so capped fires consume no provider tokens.
	 */
	maxRunsPerDay?: number;
	/**
	 * When `true`, the routine is suspended: timers stay armed for cheap
	 * /reload behaviour, but `enqueueTriggerFire`, hook firing, and the
	 * HTTP server all short-circuit and record a `"skipped"` run with
	 * reason `"paused"`. Resume with `/routine-resume` or `RoutineResume`.
	 */
	paused?: boolean;
	/** Epoch millis of creation. */
	createdAt: number;
}

// ─── Per-routine persisted state ─────────────────────────────────────────────

/** State persisted between ticks for a single routine. */
export interface RoutineTickState {
	/** Number of times this routine has fired. */
	tickCount: number;
	/** Epoch millis of the most recent fire. */
	lastFiredAt: number;
	/** Local ISO date (`YYYY-MM-DD`) of last fire — used by the daily guard. */
	lastFiredDateLocal: string;
	/** Arbitrary LLM-writable state. Capped at {@link MAX_USER_STATE_BYTES}. */
	userState: Record<string, unknown>;
	/**
	 * Ring buffer of recent runs, newest last. Capped at
	 * {@link MAX_RUN_HISTORY}. Optional for back-compat with stores written
	 * before TP-009 — readers treat missing/undefined as empty.
	 */
	runs?: RoutineRun[];
	/**
	 * Number of runs (success + silent + error) recorded today, used by
	 * {@link Routine.maxRunsPerDay}. Resets to 0 when `runsTodayDate` no
	 * longer matches the current local date. Optional for back-compat;
	 * missing/undefined is treated as 0.
	 */
	runsToday?: number;
	/** Local ISO date (`YYYY-MM-DD`) the {@link runsToday} counter applies to. */
	runsTodayDate?: string;
	/** Per-hook-trigger local date for `once: "daily"` semantics. */
	hookOnceDaily?: Record<string, string>;
}

/**
 * A single recorded execution of a routine. Pushed into
 * {@link RoutineTickState.runs} after the routine's turn completes (or fails,
 * or is skipped). The list is capped at {@link MAX_RUN_HISTORY}, newest last.
 *
 * `triggerKind` is widened to include the `"manual"` sentinel used by
 * `/routine-run-now` (see TP-009 Step 3). For manual fires `triggerIndex`
 * is `-1`.
 */
export interface RoutineRun {
	/** nanoid — unique per run record. */
	id: string;
	/** Owning routine id. */
	routineId: string;
	/** Epoch millis when the turn was initiated. */
	startedAt: number;
	/** Epoch millis when the turn finalised (response, error, or skip). */
	endedAt: number;
	/** `endedAt - startedAt`. */
	durationMs: number;
	/** Outcome classification. */
	status: "success" | "error" | "skipped" | "silent";
	/**
	 * Optional reason for `"skipped"` runs (e.g. `"paused"` or
	 * `"daily cap reached"`). Omitted for non-skipped statuses.
	 */
	skipReason?: string;
	/** Index into `routine.triggers` that fired; `-1` for manual. */
	triggerIndex: number;
	/** Kind of trigger that fired (or `"manual"`). */
	triggerKind: RoutineTrigger["kind"] | "manual";
	/** First 200 chars of the assistant response (or error / skip reason). */
	snippet: string;
}

/** Origin metadata for one queued or in-flight routine fire. */
export interface RoutineFireOrigin {
	index: number;
	kind: RoutineTrigger["kind"] | "manual";
}

/** FIFO queue entry carrying all metadata for one independent fire. */
export interface RoutineQueueEntry {
	routineId: string;
	runId: string;
	origin: RoutineFireOrigin;
	apiArgs?: Record<string, unknown>;
	githubEvent?: Record<string, unknown>;
	/** Extra bounded context, used by deferred shutdown hooks. */
	contextNote?: string;
	/** Hook key/once mode committed only after the turn starts successfully. */
	hookOnceKey?: string;
	hookOnce?: HookTrigger["once"];
	/** Persisted deferred hook removed after successful fire start. */
	deferredHookId?: string;
}

/** Persisted shutdown hook replayed at the next interactive session. */
export interface DeferredHookFire {
	id: string;
	routineId: string;
	triggerIndex: number;
	endedSessionId: string;
	deferredAt: number;
	endedSessionCwd: string;
	endedDateLocal: string;
	endedTimeLocal: string;
	transcript: string;
	transcriptTruncated?: boolean;
}

// ─── Persisted store shape ───────────────────────────────────────────────────

/** What gets written to state.json. */
export interface RoutineStore {
	/** Persisted store schema version. Files without this field are v1. */
	schemaVersion: typeof SCHEMA_VERSION;
	/** Keyed by {@link Routine.id}. */
	routines: Record<string, Routine>;
	/** Keyed by {@link Routine.id}. */
	tickState: Record<string, RoutineTickState>;
	/** Shutdown hooks waiting for the next interactive session. */
	deferredHooks: DeferredHookFire[];
}

// ─── Non-persisted runtime state ─────────────────────────────────────────────

/** In-memory runtime state. Reconstructed on session_start; not persisted. */
export interface RoutineRuntimeState {
	store: RoutineStore;
	/**
	 * routine id → list of active timer handles (one per trigger).
	 * Ordered by trigger index; entries may be `null` for fired-and-spent
	 * one-off triggers.
	 */
	timers: Map<string, Array<ReturnType<typeof setInterval> | null>>;
	/** routine fires waiting for an idle slot (FIFO). */
	queue: RoutineQueueEntry[];
	/** Store writer generation; stale extension instances cannot overwrite disk. */
	storeGeneration?: number;
	/** Recursion guard — set true while a routine turn is in flight. */
	isRoutineTurnActive: boolean;
	/** Name of the currently executing routine (for widget/suppressor labels). */
	activeRoutineName: string | null;
	/** Most recently seen ExtensionContext, for use when firing outside an event. */
	lastUiCtx: ExtensionContext | null;
	/**
	 * Per-session hook fire keys for `once: "per_session"`. This is intentionally
	 * in-memory: persisted tick counts span sessions and cannot model this guard.
	 */
	sessionHookFires?: Set<string>;
	/**
	 * Stop handle for the widget's periodic refresh loop. Owned by widget.ts
	 * but stored here so hooks and mutations can restart it after store changes.
	 */
	stopWidgetRefresh?: () => void;
	/**
	 * Trigger origin for the next/current enqueue per routine id. Populated
	 * by the scheduler / hook handlers / manual-fire command BEFORE pushing
	 * onto `queue`, consumed by `fireRoutine` when it begins the turn.
	 * Non-persisted; cleared on session start.
	 */
	triggerOrigin: Map<string, RoutineFireOrigin>;
	/**
	 * The in-flight run record. Set by `fireRoutine` on acquire, populated by
	 * the suppressor / message_end with the response snippet, finalised by
	 * the agent_end handler. Non-persisted.
	 */
	/**
	 * Caller-supplied JSON args for in-flight API-triggered fires. Populated
	 * by `server.ts` before enqueue, consumed by `executor.buildPrompt` via
	 * the `{apiArgs}` template variable. Non-persisted.
	 */
	apiArgs?: Map<string, Record<string, unknown>>;
	/**
	 * Github event payload for in-flight github-triggered fires. Populated
	 * by `github-poller.ts` before enqueue, consumed by
	 * `executor.buildPrompt` via the `{githubEvent}` template variable.
	 * Non-persisted; cleared on consume.
	 */
	githubEvents?: Map<string, Record<string, unknown>>;
	pendingRun: {
		routineId: string;
		runId: string;
		triggerIndex: number;
		triggerKind: RoutineTrigger["kind"] | "manual";
		startedAt: number;
		snippet: string;
		status: RoutineRun["status"];
		deferredHookId?: string;
	} | null;
}

// ─── Parser output ───────────────────────────────────────────────────────────

/** Output of {@link parseInterval}: numeric ms + normalized human string. */
export interface ParsedInterval {
	ms: number;
	/** Normalized form, e.g. "1h30m" for input "90 minutes". */
	human: string;
}

// ─── Template definition (templates/*.json) ──────────────────────────────────

/**
 * JSON shape for a bundled routine template. Supports the same union of
 * triggers as {@link Routine.triggers}, plus a `triggers: [...]` array form
 * for multi-trigger templates. Use the raw (pre-parse) field names that
 * `_mutate.createRoutine` accepts (`interval`, `expr`, `fireAtIso`,
 * `pollInterval`, etc.) — installer code passes them through unmodified.
 */
export interface RoutineTemplate {
	/** Template id, e.g. "ci-watch". */
	name: string;
	/** One-line description shown in `/routine-template`. */
	description: string;
	/**
	 * Single trigger (back-compat with v0.1 templates). Either this OR
	 * {@link triggers} (or both — they concatenate) must be present.
	 */
	trigger?:
		| { kind: "pulse"; interval: string }
		| { kind: "cron"; expr: string; timezone?: string }
		| { kind: "oneoff"; fireAtIso: string; timezone?: string }
		| { kind: "hook"; event: HookEvent; once?: "daily" | "per_session" }
		| { kind: "api"; allowArgs?: boolean }
		| {
				kind: "github";
				repo: string;
				// patched by pi: added issues.closed, issues.events, discussion, issue.comment, discussion.comment
				event: "pull_request.opened" | "pull_request.closed" | "issues.opened" | "issues.closed" | "issues.events" | "discussion" | "issue.comment" | "discussion.comment" | "push";
				pollInterval?: string;
				filter?: { labels?: string[]; branches?: string[]; mergedOnly?: boolean };
		  };
	/** Multi-trigger array form. Same union element as `trigger` above. */
	triggers?: NonNullable<RoutineTemplate["trigger"]>[];
	/**
	 * Prompt body. May contain `{cwd}`, `{date}`, `{time}`, `{state}`,
	 * `{tickCount}`, `{apiArgs}`, `{githubEvent}` placeholders.
	 */
	prompt: string;
	quiet: boolean;
	maxTicks?: number;
	maxRunsPerDay?: number;
	/** Tool names to check at install time (warns, does not block). */
	requiredTools?: string[];
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** The token the LLM emits to signal "nothing to report". */
export const SILENT_TOKEN = "[~]";

/** Max items kept in the fire queue (backpressure). */
export const MAX_QUEUE_DEPTH = 3;

/** Max per-routine userState size in bytes (JSON.stringify). */
export const MAX_USER_STATE_BYTES = 2048;

/** Current persisted-store schema version. v3 adds deferred shutdown hooks. */
export const SCHEMA_VERSION = 3 as const;

/** Window within which fires from distinct triggers on the same routine
 *  collapse into a single enqueue (multi-trigger dedup). */
export const MULTI_TRIGGER_COLLAPSE_MS = 500;

/** Max entries kept per routine in {@link RoutineTickState.runs}. */
export const MAX_RUN_HISTORY = 20;

/** Max chars of assistant response captured into {@link RoutineRun.snippet}. */
export const SNIPPET_MAX_CHARS = 200;

/** Max deferred shutdown hooks retained across sessions. */
export const MAX_DEFERRED_HOOKS = 5;

/** Deferred shutdown hooks expire after seven days without an interactive replay. */
export const MAX_DEFERRED_AGE_MS = 7 * 24 * 60 * 60_000;

/** Max UTF-8 bytes retained from an ended session transcript. */
export const MAX_DEFERRED_TRANSCRIPT_BYTES = 8192;

/** Min poll interval for github triggers (rate-limit safety floor). */
// patched by pi: 10s floor (user requested). 360 req/h << 5000/h App token quota.
export const MIN_GITHUB_POLL_MS = 10_000;

/** Default github poll interval when caller omits it. */
export const DEFAULT_GITHUB_POLL_MS = 120_000;

/** Max backoff after consecutive `gh` failures (30 minutes). */
export const MAX_GITHUB_BACKOFF_MS = 30 * 60_000;

/**
 * Absolute path of the persisted state file.
 * Uses the OS home directory when `HOME` is unset.
 */
export const STATE_FILE: string = `${process.env.HOME || homedir()}/.pi/agent/extensions/routines/state.json`;

/** Directory containing bundled routine templates. */
export const TEMPLATES_DIR: string = fileURLToPath(new URL("../templates", import.meta.url));

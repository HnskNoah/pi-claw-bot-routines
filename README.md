# pi-routines fork (HnskNoah/pi-claw bot setup)

Full fork of `@davecodes/pi-routines` v0.5.1 — **all source lives in this
repo**. The running copy is installed at
`~/.pi/agent/npm/node_modules/@davecodes/pi-routines/` (lost on extension
reinstall/upgrade); `deploy.ts` is the only entry point that syncs this repo
into the install.

Owned by the pi-claw GitHub bot setup. Upstream: `Davidcreador/pi-routines`.

## Workflow (user convention)

```
edit fork source → node deploy.ts → npx tsc --noEmit (in install dir) → done
```

The fork has no node_modules; run type-checking inside the installed copy.
`node deploy.ts` runs on Node ≥22 native type stripping (no tsx, no cjs shim).

## Deploy

```powershell
node deploy.ts          # sync src/ + extensions/ + configs, restore missing deps
node deploy.ts --check  # diff-only report
```

Always re-run `deploy.ts` after the extension is reinstalled/upgraded
(the script also warns when the installed version ≠ fork baseline v0.5.1).

## Divergence from upstream (what we changed)

| Area | Change |
|---|---|
| `src/types.ts` | Poll `MIN_GITHUB_POLL_MS` = 10s; 9 github events (added issues.closed, issues.events, issue.comment, discussion, discussion.comment); `githubEvents` map removed (dead after message-bridge refactor). |
| `src/parser.ts` | `MIN_MS` 10s for human github intervals. |
| `src/github-poller.ts` | **Message bridge**: fresh events → `buildPrompt` + `pi.sendUserMessage({deliverAs:"followUp"})` (pi's unbounded `_followUpMessages` FIFO — zero loss, one turn per message, TUI-like). No fire-queue/guard/tick coupling; paused gate checked locally. Chat-style `message` field + trimmed payload per event; `[bot]` authors skipped; discussion id = `number:updated_at`; cursor-missing path compares embedded timestamps (discussion fires never happened without this); 401 auto-refresh via `refresh-bot-token.js`; pino log lines (poll/fire/paused/inject failed). |
| `src/executor.ts` | `{githubEvent}`/`{githubMessage}` injection of the chat `message` text; pino fire log; `githubEvents` map fallback removed. |
| `src/pi-log.ts` | **New**: pino JSON-Lines logger → `~/.pi/agent/logs/pi-claw.log` (`$PI_GH_LOG` path override, `$PI_GH_LOG_LEVEL` level). |
| `src/scheduler.ts` / `src/hooks.ts` / `src/tools/_mutate.ts` | Small: 10s parsing, removed `githubEvents` map references. |
| `src/tools/routine-create.ts` | Event enum unions for the 4 patched events. |
| `package.json` | Added `pino ^10.3.1` dependency (deploy.ts restores it). |

Notes: `// patched by pi:` comments inside source mark the changeset for
upstream diffing — they are our code now, kept as provenance markers.

## GitHub API quirks (this App token)

- REST `discussions` list GET → 200; list comments/POST comment → **404**;
  replies must use GraphQL `addDiscussionComment`.
- `issue.comment` entries have `issue.number = null` (message shows
  `#undefined`; resolve from `html_url` when needed).
- 10s polling ≈ 840 req/h (~17% of the 5000/h per-install quota).
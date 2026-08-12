# pi-routines patches (HnskNoah/pi-claw bot setup)

Patched copy of `@davecodes/pi-routines` v0.5.1 — installed at
`~/.pi/agent/npm/node_modules/@davecodes/pi-routines/`. The live install is in
node_modules and is **lost on extension reinstall/upgrade**; this directory is
the durable home for the patches.

## Apply after reinstall/upgrade

```powershell
node C:\Users\Latitude\Dev\pi-agent\pi-routines-patches\apply.js
# then /reload pi
```

Optional: `cd` into the pi-routines package and run `npx tsc --noEmit` to
verify the copy is clean.

## What was changed (vs 0.5.1)

| File | Change |
|---|---|
| `src/types.ts` | Event enum + `GithubEventUnion` + schema: added `issues.closed`, `issues.events`, `discussion`, `issue.comment`, `discussion.comment` (9 total). `MIN_GITHUB_POLL_MS` 60s → **10s** (user requirement). |
| `src/parser.ts` | `MIN_MS` 30_000 → **10_000** (10s poll floor). |
| `src/github-poller.ts` | `endpointFor`: issue.comment → `issues/comments?sort=created&direction=desc`, discussion.comment → `discussions/comments?...`; discussion event id = `number:updated_at`; issues.events id = own `id`. `normaliseEvents`: comment events skip `[bot]` authors (prevents self-loop); payload trimmed to essentials + a chat-style `message` line for every event type. **401 auto-refresh**: on unauthorized `gh` response, runs `refresh-bot-token.js` (path from `$PI_GH_REFRESH_SCRIPT` or `~/Dev/pi-agent/refresh-bot-token.js`) and retries once before backing off. |
| `src/executor.ts` | `buildPrompt`: `{githubEvent}` injects the chat-style `message` text when present (fallback: JSON); new alias placeholder `{githubMessage}`. |
| `src/store.ts` | Persisted schema/union updates for the new events; store validation accepts them. |
| `src/tools/routine-create.ts` | Trigger creation accepts the new events. |
| `src/tools/_mutate.ts` | Mutation validation union updated for new events. |

## Runtime dependencies (not in this dir)

- `C:\Users\Latitude\Dev\pi-agent\refresh-bot-token.js` — JWT → installation
  token → `gh auth login --with-token` (1h expiry; poller auto-refreshes on 401).
- GitHub App `hanenoah-bot` (App ID 4563716, installation 153042714), private
  key in `~/.pi/agent/gh-app/`, config `{"appId": 4563716}`.

## Notes / known quirks

- REST discussions endpoints return **404** for this App's token (read works,
  write doesn't); discussion replies must go through GraphQL
  (`addDiscussionComment`). The `github-discussion-chat` routine prompt embeds
  the GraphQL command.
- Comment-event fire payloads are trimmed to `body / user / created_at /
  issue_number / discussion_number` + `message` (no URLs — user request).
- Routine prompts live in `~/.pi/agent/extensions/routines/state.json`, not in
  this package — they don't need re-applying.

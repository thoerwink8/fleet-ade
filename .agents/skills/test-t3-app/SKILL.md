---
name: test-t3-app
description: Test T3 Code's web and desktop UI in a browser against isolated development state. Use for browser verification, browser pairing recovery, and test fixtures.
---

# Test T3 web and desktop

Use the browser automation your session already has, such as playwright-cli, for
verification. Do not install another automation system. Native mobile verification
is not covered by this skill.

## Start the app

Reuse this task's healthy dev server. Otherwise run `vp run dev` from the
repository root and retain its terminal session. Use the worktree's ignored
`.t3` state and read the actual ports and pairing URL from the dev-runner output.
Never run against `~/.t3/userdata` or set `VITE_HTTP_URL` or `VITE_WS_URL`.

Test with meaningful project and thread data. Read
[references/sqlite-fixtures.md](references/sqlite-fixtures.md) only when
inspecting or seeding SQLite. Stop the test server before direct fixture writes.

## Drive agent turns for free

Do not spend a paid model to see a turn render. `vp run dev` registers the
`Replay (dev)` provider, which replays recorded turns with simulated streaming
through the real adapter and orchestration. Its models are scenarios:
`showcase` covers thinking, a plan, tool calls, an approval, and markdown.
Press `Ctrl+Alt+Shift+R` for a picker (GNOME takes that key for screen
recording), call `window.t3dev.replay("showcase")` in the page, or run
`node apps/server/src/bin.ts thread start --base-dir .t3 --provider devReplay --model showcase <project> "go"`.
When the test needs real provider behavior, use that provider's cheapest
model, such as Haiku for Claude or Luna for Codex.

## Use the browser

Open the complete startup pairing URL once and use the browser tool's
navigation, snapshot, and interaction calls. If the token was consumed
or expired, run `node apps/server/src/bin.ts pair` for a fresh one.
Keep using the same browser context.

## Verify and retain

Exercise the affected flow and capture the state that proves it works. Keep
the server, state, and browser available while the user inspects or iterates.
An assistant turn ending is not teardown. Stop only processes you started,
using retained terminal sessions or captured PIDs.

When sharing is requested, start with `vp run dev --share` and give the user
a fresh complete pairing URL that you have not consumed. Keep other credentials
out of screenshots, commits, and replies.

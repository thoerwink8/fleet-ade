# Codex

Use your ChatGPT plan or an existing Codex CLI login to code in Fleet ADE.

## Connect with ChatGPT

Connect in **Settings → Agents**. For a remote computer,
select that computer first. Fleet ADE handles Codex installation; sign in on
OpenAI and allow sharing of your ChatGPT plan.

Manage shared usage and credits in ChatGPT through **Manage usage** in Fleet ADE.
If a request uses a feature that ChatGPT sharing does not support, use another
agent for that request.

Fast and Ultrafast speeds are unavailable with this connection. To use the speed
options your account supports, [use an existing Codex login](#use-an-existing-codex-login).

When reconnecting, choose the same account in Fleet ADE and on OpenAI's sign-in
page. Signing out stops running threads but keeps their history and lets you
sign in again later.

If remote sign-in cannot return automatically, paste the full URL from the final
localhost page into the sign-in panel, even if that page could not load.

## Use an existing Codex login

Fleet ADE can use your installed Codex and its existing login. Run `codex login`
on that computer to sign in. [Agent setup](./install.md#agents)
covers installation and custom configuration.

Running `codex login` does not change a managed ChatGPT connection. In
**Settings > Agents**, add a Codex agent, choose **Configure manually**,
and complete the wizard. Then select that agent from the thread's model
picker. See [Use multiple accounts](#use-multiple-accounts).

## Allow more time for agent checks

If an authenticated Codex installation reports “Timed out while checking Codex
app-server provider status,” set `T3CODE_CODEX_PROBE_TIMEOUT_MS=60000` in the
background service's environment and restart it. See [Agent check timeouts](./install.md#agent-check-timeouts)
for configuration and other agents.

## Generate images

Codex can generate images directly in a Fleet ADE thread when your Codex version,
model, and account support native image generation.

If Codex reports that its image tool is unavailable, image generation may be
disabled in its configuration. In **Settings → Agents**, edit your existing
Codex agent and add this to **Launch arguments**, keeping any other arguments:

```text
-c features.image_generation=true
```

This enables the feature for that Fleet ADE agent without changing your shared
Codex configuration. You do not need another agent or a separate image
API key. The flag does not add image support to an unsupported model or account.

Launch arguments apply to Codex sessions started after you save them. Start a new
thread with the same Codex agent and ask it to generate an image. The completed
image appears in the thread.

## Use multiple accounts

Add another ChatGPT account in **Settings → Agents**, then select the account
from the thread's model picker. Compatible accounts can continue the same thread.
Connecting accounts through Fleet ADE leaves your CLI login unchanged.

### Multiple CLI logins

A shared Codex home with a shadow home lets work and personal accounts continue
the same threads. The accounts share Codex sessions and configuration while keeping
their own login and available models.

Keep your first account in `~/.codex`. On that computer, sign the
second account into a fresh directory:

```bash
mkdir -p ~/.codex_personal
CODEX_HOME=~/.codex_personal codex login
```

Then add a second Codex agent in **Settings > Agents**:

| Agent          | CODEX_HOME path | Shadow home path    |
| -------------- | --------------- | ------------------- |
| Codex Work     | `~/.codex`      | Leave empty         |
| Codex Personal | `~/.codex`      | `~/.codex_personal` |

Both agents must use the same **CODEX_HOME path**. Fleet ADE prepares the shared
state in the shadow directory; do not populate it by copying your whole Codex
home.

The shadow account needs its own `auth.json` file. If Codex uses an OS credential
store, configure file storage for this setup. See
[OpenAI's credential storage guide](https://learn.chatgpt.com/docs/auth#credential-storage).

Use a completely separate **CODEX_HOME path**, with no shadow home, when you want
separate Codex sessions and configuration. That agent cannot continue threads
from the other home.

## Switch accounts in an existing thread

Choose the other account from the thread's model picker. Fleet ADE offers compatible
Codex agents that share the thread's **CODEX_HOME path**. Changing accounts does
not move the conversation into a separate Codex home.

If the account is missing from the picker, compare the home paths in agent
settings. If two agents show the same unexpected account or models, check their
reported accounts, refresh agent status, and confirm the second agent has
its own shadow path and login. A shadow-home conflict usually means the directory
contains a copied Codex setup. Use a fresh shadow directory and sign in again.

## Answer questions while Codex works

Codex can ask a question and keep working. Answer it in the thread's question
panel. The answer becomes a new message: it reaches the active turn, or starts
another turn if Codex has finished. Unanswered questions survive reconnects.
If you do not want to answer, dismiss the question from its panel. Dismissing
closes it without sending anything to Codex. This requires a Codex version that
supports async questions.

## Approve app access

Codex tools can request access to another app. Respond to the named app's request
in the thread on web or desktop. Some tools offer access for one request,
the current session, or permanently. See [Permission modes](./permission-modes.md)
for command and file approvals.

## Use Daybreak

Models with cyber access programs show a Cyber Access option in the model
options. It starts on Standard, or on Daybreak when `config.toml` in your Codex
home sets `daybreak = true` or the model only runs under Daybreak. Your choice carries
over to new threads. Custom models do not offer it. If Codex rejects a turn
because your login lacks the program, switch Cyber Access back to Standard or
sign in to Codex with an account that has it.

## Codex says I hit a usage limit

When Codex stops on a usage limit, the thread names the window that ran out and
when it resets, when Codex reports them. Send the message again after the reset. On a workspace plan the
message also says whether your workspace owner needs to add credits or raise the
spend limit to continue sooner.

## Send feedback to OpenAI

In an existing Codex thread, send `/feedback` with an optional description, for
example `/feedback The agent stopped before finishing the tests`. This uploads
the conversation and Codex logs to OpenAI. The returned thread ID can be shared
with OpenAI support.

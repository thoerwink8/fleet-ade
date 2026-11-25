# Outside agents

Agents that Fleet ADE did not start can work with a computer through its MCP
server. They can read projects and threads, start and message threads, and
check which agents and models are available. This covers Claude Code or
Codex in your own terminal, ChatGPT, and bots that support MCP. Each agent signs
in once, and you choose what it may do.

## Add Fleet ADE to an assistant app

Open the command palette (`Cmd/Ctrl+K`) and choose **Use Fleet ADE in another
app (MCP)**, or use the button in **Settings → Connections**. Pick the
app and follow the step for that app. Assistants like
Poke and Claude run in the cloud, so the wizard first asks you to sign in and
turn it on for that computer. To reach your other computers through the same
connection, [link them](./remote-access.md#link-another-computer).

When the app opens the sign-in page, choose what it may do and approve with
your session. On an older background service, the wizard asks for the
level and gives you a code to paste instead. A code works once, for 5 minutes,
and approves only that level.

For an app that is not listed, choose **Something else…**, add a remote MCP
server with OAuth in that app, and paste the URL. Apps that require their own
client ID cannot connect.

## Get the MCP URL

In **Settings → Connections**, open a saved computer's menu and choose
**Copy MCP URL**. The URL is the computer's address followed by `/mcp`, for
example:

```text
https://<computer-address>/mcp
```

When the computer is reached through a saved route, the copied URL uses that
route, which agents can reach wherever that route is available. Otherwise it
uses the route this device is connected over, so an agent on the same device can
reach it.

- **An agent on your own computers** can use `localhost` on that computer, a Tailscale
  HTTPS address, or any other `https` address. Signing in sends the agent's
  credentials to the computer, and agents only do that over `https` or to
  `localhost`. A plain-`http` LAN or Tailscale address, like
  `http://100.x.y.z:3773`, lets an agent find the computer but not finish
  signing in.
- **A hosted agent**, such as ChatGPT or a bot running in the cloud, must reach
  the computer from the internet. Use a public HTTPS route; a Tailscale
  address only works from your own tailnet.

## Approve a sign-in

The first time an agent connects, it opens a sign-in page. Approve the request
there, without sharing credentials with the agent. The page names the agent and
where its access goes:

A code from **Use Fleet ADE in another app (MCP)** already carries the level you
picked there. With another code, choose what the agent may do here: **Auto** is
selected by default. Approving without a code starts at **Read only**:

- **Read only** lets the agent read projects and threads and see
  the available agents and models. It cannot change anything.
- **Supervised** through **Full access** also let it start, message and stop
  threads in every project. A thread it starts or steers cannot run with more
  permissions than the mode you chose.

## What outside agents can call

Some tools only work for an agent running inside a Fleet ADE thread, because they act
as that thread: subagents, secret requests, rendered HTML,
and worktree handoff. They still appear in an outside agent's tool
list, but calling one returns an error saying it needs an agent running inside
Fleet ADE.

- To hand off work, start a thread with `t3_thread_launch`, then follow it with
  `t3_thread_wait` or `t3_thread_read`, instead of `create_threads` or
  `delegate_task`.
- Tools that default to the caller's own project or thread need an explicit
  `projectId` or `threadId`.
- To list threads across projects, call `t3_thread_list` with
  `allProjects: true`, or use `t3_thread_search`.

## Claude Code

```sh
claude mcp add --transport http t3 https://<computer-address>/mcp
claude mcp login t3
```

`claude mcp login` opens the sign-in page in your browser. On a computer
without a browser, add `--no-browser`, open the printed URL elsewhere, and
paste the final URL back when asked. `claude mcp list` shows `t3` as connected
once you approve.

## Codex

```sh
codex mcp add t3 --url https://<computer-address>/mcp
codex mcp login t3
```

`codex mcp login --no-browser` prints the sign-in URL instead of opening it.
`codex mcp list` shows `t3` with OAuth once you approve.

## ChatGPT

Add the computer as a custom MCP app in ChatGPT's apps settings:

1. Create a new app or plugin with a custom MCP server.
2. Set the server URL to `https://<computer-address>/mcp`, using the T3
   Connect address.
3. Choose **OAuth** for authentication. ChatGPT discovers the rest; you do not
   need a client ID or secret.
4. Create the app, then approve the sign-in page that opens.

## Other agents and bots

Any agent that supports remote MCP servers over HTTP with OAuth can connect. Give
it the MCP URL and choose OAuth, and the agent finds the sign-in settings itself.
Agents without OAuth support cannot connect.

## Scripts on the computer

On the computer that runs the background service, `t3 thread` uses the same tools
without a sign-in:

```sh
id=$(t3 thread start . "Find why the tests are slow")
t3 thread send "$id" "Now fix it" --wait
t3 thread show "$id"
t3 thread list
```

`.` means the project that contains the current folder, or a git worktree of
its repository; a project id also works. A new thread uses the project's
default model and permission mode, and runs in the project folder unless you
pass `--worktree <base-branch>`. `send` never interrupts: a busy thread gets
the message as its next turn. Pass `-` as the message to read it from stdin.

`--wait` prints the agent's reply. It exits 1 when the run fails or stops, and
2 when the agent waits for an answer you give in the app. Add `--json` for a
result that always includes the thread id.

## Remove an agent

Approved agents appear under **Settings → Connections** like other clients.
Revoke one there to cut off its access immediately. A sign-in lasts 30 days;
after that the agent asks you to approve it again.

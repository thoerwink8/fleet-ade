# ACP agents

Fleet ADE can run installed ACP commands or coding agents from the official
[ACP Registry](https://agentclientprotocol.com/get-started/registry). Registry agents bring their
own models, tools, and sign-in, while Fleet ADE provides projects, threads, file snapshots, and task
delegation.

Agents that Fleet ADE supports natively, such as Codex, Claude, Grok, and
[Antigravity](./providers-antigravity.md), don't appear in the Registry list. Enable them in
**Settings → Agents** instead.

Fleet ADE prefers the current ACP v2 preview protocol and uses its richer messages, usage, plans,
configuration, compaction, and agent-terminal updates when the agent supports them. It also
negotiates ACP v1 for Registry agents that have not migrated yet, so they continue to work through
the same generic integration.

## Add an agent

1. Open **Settings → Agents**.
2. Select **Add agent**, then **Show more**.
3. Search the ACP Registry for the agent and select **Add** on its result.
4. Confirm the name and agent ID, then complete the agent's sign-in step.

Search only shows agents that can run on the connected computer. Registry agents are third-party
code; review an agent's source and license before adding it.

## Add a local command

In **Settings → Agents → Add agent**, select **Show more**, then **Local ACP command**. Enter the executable
name or path on the selected computer, add one literal argument per row, and choose a display
name.

Local commands require no registry entry or download. Environment variable overrides apply to the command;
credentials and skills remain managed by the installed agent or its wrapper. Models and reasoning
options come from ACP, including model IDs that contain JSON. Fleet ADE launches the executable directly
without expanding shell expressions.

## Where agents run

Registry agents always run on the computer that hosts your Fleet ADE background service. That stays true when you
connect through a local route, Tailscale, or the hosted web app.

Agents install under `tools/<agent-id>/<version>/` inside T3 home. Fleet ADE verifies SHA-256 when the Registry entry
provides one; entries without a checksum retain the Registry's HTTPS distribution guarantee.
Registry `npx` and `uvx` packages use T3-owned npm prefixes and Python tool directories at the exact
version published by the Registry. Their commands are available in a new server terminal for
sign-in and direct use. Removing an agent's last entry removes T3-managed binary files
but keeps package installs. To use an existing local binary, set **Executable override** explicitly.

## Signing in

Open the agent's account section in **Settings → Agents** on web or desktop. Choose
**Sign in** and, if the agent offers several methods, select one.

Browser sign-in shows the agent's URL and waits for you to open or copy it before telling the
agent to proceed. The page opens on your device, while the agent runs on that computer.
Terminal methods run in an in-app terminal on that computer. Fleet ADE reconnects after terminal
login and waits for the agent to confirm sign-in before reporting success. You can cancel or retry
an expired attempt.

Browser and terminal sign-in leave credentials in the agent's own store. Agents that use API keys
through environment variables still take those keys in the agent's variable settings.
A configured environment or agent home applies to both sign-in and session use.

If the agent advertises logout, choose **Sign out**. Changing a shared agent login stops running
threads for entries of that same agent on that computer. Thread history and project files
are kept. ACP does not describe account isolation, so adding another entry does not guarantee
a separate account; use the agent's own configuration to isolate accounts when supported.

## Models and options

The model picker lists the models the agent reports. If the agent reports none, or hides some, add
your own model IDs under **Custom models** in the agent settings.

Other settings the agent offers, such as reasoning effort or approval mode, appear in the
composer's model picker, beside the model list, like they do for built-in agents. Models and options that change while an agent
is running update the picker without waiting for another agent probe.

## Commands and skills

Slash commands the agent provides appear under **Agent** in the `/` menu while a session is
running. Commands the agent names with a `$` prefix appear in Fleet ADE's `$` skill menu instead.

## Native sessions

When an agent advertises ACP session listing and import support, expand its agent card,
choose a project, and select **List sessions**. Importing one creates a deterministic thread
backed by that native session. Importing the same agent session again returns the existing thread,
including when another client performs the import.

The thread keeps the native session's title and last-update value as agent metadata without
overwriting a title you set in Fleet ADE. Agents that report ACP context usage drive the thread details
context window and cumulative cost metadata. See
[commands and skills](./composer.md#commands-and-skills) to show it on web and desktop.
Text resources and links render as assistant output;
binary resources, images, and audio that Fleet ADE cannot render yet appear as explicit placeholders
instead of disappearing.

## Permissions and terminals

Registry agents read files, edit, and run commands themselves, under their own sandbox and
approval rules. They start in their own default mode, and their mode picker in the model options
menu switches it. How far an agent is confined depends on that mode and the agent's own settings,
so use its sandbox and permission controls when that matters.

When a registry agent asks for approval, Fleet ADE answers by the thread's
[permission mode](./permission-modes.md): **Supervised** shows the request in the conversation,
**Auto-accept edits** approves edits and shows the rest, and **Auto** and **Full access** approve
automatically. File reads and searches never wait for approval.

Fleet ADE shows the command, output, and exit status a registry agent reports but does not run or
stop its terminals.

Registry agents can schedule work and use Fleet ADE's MCP tools. Child-task presentation depends on what
the agent exposes: ACP has no portable native subagent-lineage contract, so richer delegation views
remain agent-specific.

## File snapshots

Snapshot rollback restores your files as usual. ACP agents cannot rewind their own conversation,
so the next turn after a rollback starts a fresh agent session that no longer remembers the
conversation from before the snapshot.

Registry entries are not used for Fleet ADE's app-owned text generation, such as thread titles, commit
messages, branch names, or PR descriptions. Configure a text-generation-capable agent or text generator
for those actions.

## Advanced configuration

- **Executable override** runs an existing local executable instead of the managed distribution,
  keeping the registry-declared arguments and environment.
- **Authentication method** picks a specific method when the agent advertises more than one.
- **Custom models** adds model IDs the agent does not report.

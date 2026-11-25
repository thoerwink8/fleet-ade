# Updating

The desktop app does not update itself. Build a Windows package on this computer and install it by hand.

Background services that can update themselves, and agent CLIs, still update from the sidebar button and **Settings → Connections**. A service bundled in the desktop app is not updated that way; install a new desktop package on that computer.

## Update connected services and agents

The sidebar button updates outdated agents, then background services that are behind the app you are using. It skips a computer that is offline, on another release channel, or bundled in a desktop app. Hover the button to see what it will update. A failed service can be retried. Background services that cannot update themselves stay on **Settings → Connections**, which can copy an update or relaunch command.

Background service updates restart the connection. See **Before you update** below.

## Before you update

Background service updates restart the connection and can interrupt active agents and terminal commands. Saved threads, settings, and project files remain.

**Settings → Maintenance → Continue threads after restarts** is on by default.
It resumes supported active threads after an update, crash, or computer
restart. Changes are saved to connected computers that support this setting;
update older background services first. If a supported computer was offline or has a
different value, use **Apply to all** in Settings after it connects.
Fleet ADE must start again on that computer;
the setting does not enable automatic startup. Terminal commands may still be
interrupted, and threads without saved agent resume state need a new message.
A thread that finished its turn to wait on a subagent, a background task, or a
command or monitor the agent said it was waiting on is woken and told that this work
stopped. Other background shells and monitors, such as a dev server and its
watchdog, do not wake it; the thread learns about them with your next message.
A thread is not resumed while it waits for your approval, answer, or secret, or
while it is archived, snoozed, or completed. After three automatic resumes in a row,
the thread waits for your next message.

Updates from the previous orchestration system preserve conversation transcripts but cannot carry
every kind of runtime history forward. Read [Threads from older Fleet ADE versions](./thread-migration.md)
before continuing an important older thread.

## When versions don't match

A client and background service must speak the same orchestration protocol. If they do not, the connection is
refused rather than running half-upgraded:

- An app newer than the background service is blocked before connecting, with a notice telling you to update
  Fleet ADE on the computer named in the notice.
- A background service newer than your app refuses the connection with an update message.

Update the side the notice names, then reconnect.

## Update a connected background service

The offered action depends on how the background service runs:

| Action                     | What to do                                                                                                                                                                                                  |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Update server**          | Keep the client open while it installs and reconnects. Supported background services update remotely. A service bundled in the desktop app is updated by installing a new desktop package on that computer. |
| **Update the desktop app** | The desktop app does not update itself. Build a Windows package on this computer and install it by hand.                                                                                                    |
| **Copy update command**    | Run the command on the named computer to update the detected global npm install or installed `t3` command, then restart the background service with your usual options.                                     |
| **Copy relaunch command**  | Stop the command-line service on that computer and relaunch with the copied command, keeping your usual subcommand and options. This does not update an installed `t3` command.                             |

On that computer, run:

```sh
t3 update <client-version>
```

Replace `<client-version>` with the version shown in the notice. The command
asks before restarting the background service; if you decline, run
`t3 service restart` when you are ready. For a service you started by hand,
stop it and start it again afterwards with your usual options such as `--host`
or `--tailscale-serve`.

If you decline the restart for a background service installed by an older
release, the service can stay down after a crash or reboot until you run
`t3 service restart`.

If you run the service with `npx` rather than an installed `t3`, there is
nothing to update on that computer: stop the service and relaunch it as
`npx t3@<client-version>` with the same subcommand and options.

## If an update fails

Keep the client open until it reconnects or reports a failure. A failed service
update can roll back to the previous version. If the update still fails:

1. Retry the offered action once.
2. Check that you updated the service's computer, not only the device you are using.
3. For a command-line service, stop it and relaunch the exact version shown in the notice.

Only one background service can use a T3 home directory at a time. If startup reports that
another server owns it, stop that server before retrying, or use a separate home
directory and pair with the running service.

## If the desktop app does not start

If the desktop app's server keeps failing at startup, Fleet ADE shows a window
that names the last version that started on this computer. This build does not
download an installer. Copy the error details from that window if you need them.

## Registries and proxies

Each background service checks Fleet ADE releases, and agents installed with npm, through
its own npm, so the checks use npm's configured registry, authentication, and
proxy settings. Agents installed with Homebrew or pnpm check through those
tools.
Configure npm on the background service's computer. If that registry cannot be reached, the
release shows as unavailable; Fleet ADE does not try the public registry instead.
Computers without npm check the public npm registry directly.

## Update agents

**Settings → Agents** shows agent updates for the selected computer.
**Update all** updates every outdated agent on every connected computer
at once. Hover it to see which agents it will update. An agent is left out
when any of its enabled, outdated accounts offers only a manual update command,
or when its accounts use different update commands, such as two accounts that
run different CLI installs. Update those by hand, or point every account of the
agent at the same CLI.

After a successful agent CLI update, Fleet ADE refreshes model discovery for
every enabled account of that agent using its own configuration. Connected
clients receive the refreshed catalogs automatically.

Agent updates do not restart running sessions. An existing session can keep
using the previous CLI until it ends. If discovery fails, check the agent
status and refresh it again. If agent update checks are disabled, enable them in
**Settings → Maintenance** before refreshing to find newer versions.

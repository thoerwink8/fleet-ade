# Remote access

Connect a phone, browser, or another desktop app to Fleet ADE running on a different
computer. That computer must stay running and reachable while you work. Reach it
over the local network, Tailscale, or SSH.

`t3 up` asks nothing when you name `--lan` or `--no-lan`. Choices you do not
name keep their settings, and `--yes` takes the defaults. Without a terminal, a
needed restart runs without asking and stops running agent turns. With nothing
set up and no choice named, `t3 up` stops and names the flags.

`t3 status --json` prints the settings. `t3 up --help` lists every flag with
examples.

## Pair over a LAN or private network

Use direct pairing when the other device can reach that computer's network address.

On a desktop app computer, open **Settings → Connections**, enable **Network access**,
then create a pairing link using an address the other device can reach. Changing
network access restarts the desktop app. You can turn it off in the same place.

For a command-line computer, choose the local network in `t3 up`, or run:

```bash
t3 up --lan
```

For a background service in a terminal, run `t3 serve --lan`. Either way, Fleet ADE then
accepts connections from your local network and tailnet, so a pairing code is
all that keeps other devices on them out.

If a background service is already running, generate a fresh link without restarting it:

```bash
t3 pair
```

Scan the QR code on your phone or paste the pairing link into **Add computer**
in the receiving app. Connection settings are under **Settings → Connections**.
A loopback address such as `127.0.0.1` reaches only the device opening the link.

If your HTTPS endpoint uses a certificate from your own certificate authority,
install that CA on the phone or computer whose browser opens the link, so the
browser trusts it.

On a computer with the desktop app, you can open the printed `t3code://pair`
app link instead. The desktop app asks you to confirm the address, then
adds it.

Pairing authorizes that device for future connections. Use a fresh one-time link
for each new device; you do not need the original pairing link to reconnect. Links
created in Settings can only be copied from the client that created them while
its Connections page stays open. If you leave or reload that page, create
another link to share.
If a link says it was already used, expired, or invalid, create a new link under
**Settings → Connections** on the computer being connected, or run `t3 pair` there.

### Reach one computer several ways

A computer can have more than one route: LAN, Tailscale, another VPN, a public
URL, or SSH. Tailscale shares its `100.64.0.0/10` address range with
other VPNs such as Cloudflare WARP, so an address in that range shows as VPN
unless the computer confirms it is on Tailscale. To add a route, choose **Add
route** in the computer's route list.
A pairing link for a saved computer is refused when it comes from an address
that computer does not have yet; add that address with **Add route** instead.
Pairing again over an address the computer already has still works. A new route
is placed by speed, in that order, and you can reorder routes at any time.

While connected through a paired address, Fleet ADE also learns the
computer's current LAN and Tailscale addresses and adds them as routes, so
pairing once is enough to use the LAN at home. When the
computer's LAN address changes, for example after it joins another Wi-Fi network,
the learned route follows it. The computer must allow network access for its LAN
address to be learned: **Network access** in the desktop app, or the
[local network](./background-service.md#local-network-access) choice in `t3 up`.
You can reorder a learned route, but not remove it; it
goes away with the route it was learned through, or when the computer stops
reporting that address.

Fleet ADE connects over the first route that answers. Away from home, a LAN
address that does not answer is checked briefly and skipped. It is only tried
again, after the other routes, if none of them connect. While connected over a
later route, Fleet ADE checks the earlier ones when your network changes, when you
return to the app, and every minute, and moves back as soon as one works.

Select the route count under the computer's name in **Settings → Connections**
to see its routes. Drag a route to change the order, or remove it. Removing one
route leaves a computer you can still reach another way saved.

Open **Permissions** next to **Routes** to see what your current connection can do on that
computer. For a remote computer, this is in its route details. Permissions
shown there apply only to the route marked **In use**; other routes are not
checked. Routes can have separate sessions and may grant
different permissions.

### Balance new threads across computers

Auto balance is off by default. On web and desktop, enable it in
**Settings → Connections → Load balancing** to automatically choose a computer for
new threads in projects grouped across connected computers. The section
appears once two or more computers are switched on.
Each computer starts at **Normal**. Choose **Prefer** to favor it when it has CPU and
memory available, **Less often** to reduce its share, or **Manual only** to exclude
it from automatic selection. These are preferences, not fixed traffic percentages.
Preferences are saved separately in each client.

The composer checks eligible computers when choosing a draft's computer, then keeps
that choice stable. Choose **Auto balance** again to check current resources, or choose
a specific computer to override it. Choosing a branch or worktree also keeps the draft
on that computer. Existing threads stay where they started. If resource checks are
unavailable or all eligible computers are full, choose a computer manually to continue.

### Tailscale HTTPS

Join both devices to the same tailnet. In the desktop app, enable **Tailscale
HTTPS** in **Settings → Connections**. Turn it off there to remove that route.

To start a command-line server with Tailscale HTTPS:

```bash
t3 serve --tailscale-serve
```

For an already-running background service:

```bash
t3 pair --tailscale
```

The pairing link uses an address such as `https://machine.tailnet.ts.net/`.
The mapping created by `pair --tailscale` persists across restarts. Remove its
default-port mapping with:

```bash
tailscale serve --https=443 --set-path=/ off
```

If that port is already in use, choose another with
`--tailscale-serve-port`. See `t3 pair --help` for other pairing options.

## Desktop-managed SSH

In the desktop app, open **Settings → Connections → Add computer**, choose
**SSH**, and enter a host or SSH alias such as `user@example.com`. Fleet ADE starts
or reuses a background service there and opens the port forward for you. Projects, agent
credentials, and agent work stay on the remote computer.

The remote computer must be Linux or an Apple Silicon Mac with `curl` or `wget`,
`tar`, `sha256sum` or `shasum`, and [agent setup](./install.md#agents).
The first launch downloads Fleet ADE's background service to `~/.t3/runtime` on that computer, so
it takes longer than later ones.
Agent CLIs must be on the `PATH` of a non-interactive login shell there;
check with:

```bash
ssh user@example.com 'sh -lc "command -v claude codex"'
```

If SSH reconnecting fails after an app update, retry the launch once. Removing
the connection stops a background service that Fleet ADE launched; a service that was already
running is left alone.

Each desktop app keeps one session on that computer for its SSH connection and reuses
it when it reconnects. Revoke sessions you no longer use in **Settings →
Connections** on that computer, or on a headless computer with `t3 auth session list` and
`t3 auth session revoke <id>`. A desktop that can still sign in over SSH pairs
again on its next connect.

For Antigravity's Google callback on a remote computer, see
[remote sign-in](./providers-antigravity.md#sign-in-from-a-remote-device).

## Headless browser on a remote computer

HTML previews belong to the computer. Agents check a page with screenshots from a small
headless browser that Fleet ADE keeps for itself, and a remote device sees the same result. It
never uses a browser you installed, and `localhost` addresses reach servers on that computer.

The first preview downloads that browser, about 120 MB, into the T3 home. Some Linux computers need
[setup](#browser-host-setup) before it can start.

### Local servers

The browser lists ports held by processes your terminals and agents started.
Fleet ADE reads which process holds each port and never connects to it, so a
listed port opens as `http://localhost:<port>` and might not be a web page. For
an HTTPS server or a specific path, set the **Preview URL** on the project
script that starts it; Fleet ADE checks that address and opens it as written.

To stop listing ports, set `T3CODE_PORT_DISCOVERY=0` in the environment that
starts the Fleet ADE background service, such as
[`service.env`](./background-service.md#configure-the-service-environment) for
the background service, and restart it. Script preview URLs still appear.

### Browser host setup

macOS, Windows, and Linux desktops run the browser as is. Some Linux computers need
one-time setup: Ubuntu 23.10 and later block the sandbox the browser runs in,
and minimal images and containers lack libraries it loads. When that happens,
the background service says so at startup, and HTML previews show the
command to run on that computer:

```sh
sudo t3 browser setup
```

The background service shows the exact line for how you started it, and keeps your `PATH`
when you started it with `npx` and Node is installed only for your user. Where `t3` is not on your `PATH`, such as with only the
desktop app installed, it names the full path of the app's own `t3` instead. It allows Chrome's sandbox with an AppArmor profile and installs
any missing libraries and system fonts with apt; pages that load without text
can mean the computer has no fonts. It is safe to run again. Without `sudo`, it only
reports what it would change.

The browser runs in Chrome's sandbox by default. Chrome cannot start that sandbox
as root. If your Fleet ADE background service runs as root, run it as a nonroot user to keep
sandboxing enabled. `t3 browser setup` does not fix this root restriction.

If you need to run as root, or cannot enable the sandbox on your computer, set
`T3CODE_SERVER_BROWSER_SANDBOX=0` in the **background service's environment** and restart
the service. This disables Chrome's sandbox. For a manual launch:

```sh
T3CODE_SERVER_BROWSER_SANDBOX=0 t3 serve
```

For a systemd service, add `Environment=T3CODE_SERVER_BROWSER_SANDBOX=0` under
`[Service]` in its configuration, run `sudo systemctl daemon-reload`, then restart
your Fleet ADE service. Setting the variable in an agent's terminal does not change the
environment of an already running background service.

## Connect an outside agent

Claude Code, Codex, ChatGPT and other agents Fleet ADE did not start can drive
threads on a computer through its MCP server. See
[outside agents](./outside-agents.md) for setup.

## Link another computer

Link two computers, such as your laptop and a VPS, and agents on one can work on
the other: launch, message, wait on and stop its threads, answer their
questions, and manage its queues, projects and scheduled tasks.

Linked computers are always enabled on both computers; no Labs switch is needed.

On the computer you will work from, open **Settings → Connections → Linked computers**,
choose **Link**, and pick the other computer or enter its address. The list
holds the computers this app knows. If this
app has an address for that computer and is connected to it with a session that
manages access there, it makes the pairing code itself; otherwise paste one
from that computer's **Settings → Connections**. An address you type always
needs a pasted code. From a terminal, use
`t3 environment link <address> --pairing-code <code> --access <mode>`.

You can also ask an agent to link a computer by name, such as "delegate this to
my vps". It shows a card in the thread where you pick the computer the same way
and the access, then approve. An address the agent gives that this app does
not know for one of your computers also needs a pasted code. Paste one only for
an address you trust: the code is sent there.

- The access you pick is the most agents from this computer may do there. An
  agent also never gets more there than its own mode here.
- Threads a link starts are marked **From** and this computer's name there.
- A full-access link works there like that computer's own agents. Below full
  access, the link's agents can change only threads it started, not that
  computer's own threads, projects or settings, and they skip its project setup
  scripts.
- The link shows up in that computer's **Settings → Connections** like any
  outside agent. Revoke it there to end it. **Remove** on this computer only
  removes it here.
- Links last 30 days. Link again with a new pairing code to renew one.

When one linked computer starts an ordinary thread on another, it attempts to
prove its identity over the link back. If that proof is temporarily unavailable,
the thread can still start without a verified computer identity. Fleet task claims
and threads started with a fleet task require a verified identity instead. On the
remote coordinator, open **Settings → Connections → Linked computers** and
link back to the calling computer using its reachable address and pairing code;
then retry. If the identity conflicts, **Remove** the incorrect link on the remote
coordinator and pair the calling computer again before retrying.
Older clients can still renew or release their existing leases, but must update
before claiming new tasks; pairing again alone does not update the client.

An agent can also hand a task to a linked computer with `delegate_task`: it runs
there as an ordinary thread, in the project with the same repository (or the
one `target.projectId` names), and this thread wakes with its result when it
ends, as for any delegated task. It keeps following the task across restarts.
If the other computer revokes the link, or the link is removed here, the task
fails with that reason.

## See what every computer is doing

Open **机群** from the sidebar or the command palette to read, in one place, the
work every linked computer has reported to this one: what each is working on,
what is waiting for you, and what it last finished. The board reads only what
this computer has recorded, so a computer that has not reported in shows its last
known state rather than a live one. Finished threads stay on the board for 24
hours, then drop off. Nothing on the board changes a computer; to act on a
thread, open it from its row.

## Manage or revoke access

On that computer, **Settings → Connections** lets authorized administrators create
pairing links and revoke client sessions. Revoking an unused link prevents new
pairings; revoke a device's session to remove its existing access. Command-line
management is available through `t3 auth --help`.
When the app connects to more than one computer, choose one at the top of the
page. A desktop app with **Local background service** off can manage a background
service on the same computer this way.

A session with an open connection stays listed after its access credential
expires.

To choose a pairing link's permissions, pass `--scope` once for each scope you want:

```sh
t3 pair --scope orchestration:read
```

The selected scopes replace the default permissions. The same option works with
`t3 auth pairing create` and `t3 auth session issue`; each command's
`--help` lists the available scopes. Without `--scope`, pairing tokens and issued
bearer sessions get every permission, including managing access.
A terminal or a full-access agent on that computer can reach those as well, so a
client that should not manage access also needs to go without `terminal:operate`
and `orchestration:operate`.

To change an existing client's permissions, create a fresh pairing link with the
scopes it needs. In a browser opened directly on the computer, open that link
to replace the browser's current grant. For a saved remote computer
in web or desktop, use **Add computer** with the fresh link or code; pairing
the same computer replaces its saved grant. Reconnecting alone does not change
permissions.

Grouping checkouts does not combine their permissions. Shared project settings
require `orchestration:operate` on every member computer; actions on one
checkout use that checkout's permissions.

`source-control:write` covers direct Git and PR changes made from the
client: pushing, switching or creating branches, cloning, and removing
worktrees. It does not restrict what a task does. Starting a task in a new
worktree still creates that branch and worktree with `orchestration:operate`,
and the agent it runs can use Git however the computer allows.

Settings changes, agent management, computer maintenance, access
management can each be granted separately. New
pairings without `--scope` include all of them. Existing clients keep the
permissions they paired with and can stay connected after an update, but newly
separated features may require pairing again with the permissions they need.
Older clients may show controls that the background service denies. Create a fresh pairing
link to change a client's permissions.

`filesystem:read` allows browsing computer files, opening project files, and viewing
local changes. Add `filesystem:write` to allow editing files or saving plans to
disk. These scopes control direct file access from the client.

Treat pairing links and pairing codes as passwords. Do not include them in
screenshots, logs, or bug reports.

## Using the Desktop App as a Remote Only

If a computer should only drive work running elsewhere, turn off its local background service. In the
desktop app, open **Settings → Connections** and switch off **Local
background service**. Fleet ADE restarts without a local service: no local agents or terminals run, WSL
backends stay off, and other devices can no longer connect to this computer. Your projects,
history, and saved connections are kept, and you keep working through pairing or SSH.
If a [background service](./background-service.md) on this computer uses the same T3 home, the
app still treats it as this computer: **Open in** and file reveal for its projects run here,
whichever connection you reach it through.

Switch **Local background service** back on in the same place to restart with your previous local
settings.

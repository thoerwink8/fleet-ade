# FAQ

## Is Fleet ADE a harness?

No. A harness is what turns an LLM into an agent: it gives the model tools, a way to call them, runs them, and hands the results back. Claude Code is kind of a harness. It is an interface (the TUI, the Code tab in the desktop app) plus a harness underneath (the Anthropic Agent SDK). Codex is the same split: the app plus the Codex App Server. Fleet ADE uses those harnesses. It is not a harness, and it does not work without one.

Chef = LLM. Kitchen = harness. Fleet ADE = the restaurant that lets you bring whatever kitchen you want. Our MCP is a cookbook we hand the kitchen, but the chef won't open it unless you tell them to :) I wrote the long version here: [What is a harness?](https://t3.gg/blog/post/what-is-a-harness)

Bring your own: Claude Code, Codex, Grok Build, or Google Antigravity. [Agent setup](./install.md#agents)

## Why use Fleet ADE instead of Claude Code or the Codex app?

We were inspired by the Codex desktop app, Conductor, Claude Desktop, and Cursor Glass, but none met our bar. What you get:

- Bring your own sub. Claude, Codex, and whatever else you already have installed.
- Best in class remote. Run `t3 up` on any box and drive it from anywhere.
- Use it from a phone. [Mobile setup](./install.md#mobile-app)
- Truly 100% open source. If we go the wrong direction, fork it.

Every harness feels nearly identical in here, so you can stop worrying about harnesses and focus on building :) [Install](./install.md)

## Can I use Fleet ADE with my Claude Code subscription?

Yes.

## How much does Fleet ADE cost?

Nothing. There's no way to pay us to use Fleet ADE. You bring your own sub. It is free and open source (MIT). You still pay your model provider like you already do. [Install](./install.md)

## Why is my Claude 5-hour limit draining so fast?

It shouldn't anymore. Fleet ADE drives Claude through Anthropic's Agent SDK, and Anthropic's 5h meter used to charge Agent SDK usage about 1.7x more than using Claude Code directly. Weekly limits were never affected. Since v0.1.7, Claude in Fleet ADE drains your 5h limit at the same rate as Claude Code. Still seeing it? [Update Fleet ADE](./updating.md) on the computer that runs your agents. [My post on it](https://x.com/theo/status/2114166439813017873) · [Tracking issue](https://github.com/pingdotgg/t3code/issues/24649)

## How do I use Fleet ADE remotely?

Your agents run wherever Fleet ADE runs: your desktop, a server, a VPS. You connect to it from anywhere. Reach the computer over the local network, Tailscale, or SSH. [Remote access](./remote-access.md)

## How do I use Fleet ADE on my phone?

Follow [Mobile setup](./install.md#mobile-app), then connect to your computer with a pairing link or Tailscale. The phone is a remote. Your computer does the work and needs to stay on. [Remote access](./remote-access.md)

## Will I get banned for using my subscription?

No. We work with all of the labs and Fleet ADE is within the TOS of Claude Code, Codex, and Google Antigravity. We worked directly with [SpaceXAI](https://x.com/SpaceXSI/status/2070195830192320600) to collaborate on the Grok Build and Cursor integrations. Everything else uses official ACP bindings.

If it works in Fleet ADE, you can trust it is safe.

## Can I add a bunch of accounts for one agent?

I don't think Fleet ADE is the right place to manage a pile of accounts. If we add an auto-switcher, we are risking TOS bans for our users.

A separate work account is fine. Setup for two: [Codex](./providers-codex.md#use-multiple-accounts) · [Claude](./providers-claude.md#separate-accounts-or-configurations). For a bigger pool, manage them outside Fleet ADE with a self-hosted proxy like [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI). I walked through how I use 6 Claude subs and 3 Codex subs in [this video](https://www.youtube.com/watch?v=D8PikZ1KhUo), and wrote up the setup in [this guide](https://gist.github.com/t3dotgg/59a521d2ee8d70aaf90e280c175072af). Hand it to your agent and it will walk you through it. Early apologies if it gets you banned 💀 After you set up a hub, Fleet ADE can show its pooled limits under Usage. [Connect a hub](./usage.md#connect-a-cliproxyapi-hub)

## Can I use an API key or OpenRouter instead of a subscription?

Yes. Add another agent in Settings and give it its own keys and endpoint. Claude has a full OpenRouter recipe. Your subscription setup stays untouched. [OpenRouter](./providers-claude.md#openrouter) · [Agent accounts](./install.md#agents)

## Does Fleet ADE support local models?

No. Fleet ADE is a serious developer tool. Locally runnable models are not capable of meaningful engineering work.

## Does my code go to Fleet ADE servers?

No. Your code and prompts go from your computer to your model provider (Anthropic, OpenAI, etc.), not to us. That is the same on Tailscale or the local network. Fleet ADE does not send product usage events. [Telemetry](./telemetry.md) explains what is sent and how to turn it off with `T3CODE_TELEMETRY_ENABLED=false`.

## Worktrees are eating my disk. How do I clean them up?

Open **Settings → Code → Cleanup** and turn on automatic worktree cleanup. To run it immediately, use **Delete now** in **Settings → Maintenance**. Worktrees add up fast. One user cleared 500 GB. [Storage cleanup](./project-settings.md#storage-cleanup)

## Does it work on Windows, Mac, and Linux?

Yes, all three. Desktop app, CLI, the works. One catch: there is no `t3` binary for Intel Macs, so use the desktop app there. Windows folks can also run agents inside WSL. [Install](./install.md)

## Why is my agent not showing up?

Almost always, the CLI is not installed or not on the `PATH` of the computer that runs the background service. (Not your phone. The computer.) Log in on that computer first, like `codex login` or `claude auth login`. Still missing? Point **Binary path** at it in agent settings. Version managers love to cause this one. [Agent setup](./install.md#agents)

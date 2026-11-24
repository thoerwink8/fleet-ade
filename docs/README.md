# T3 Code docs

## Using T3 Code

- [Install T3 Code](./user/install.md)
- [FAQ](./user/faq.md)
- [Messages and context](./user/composer.md)
- [Prompt links](./user/prompt-links.md)
- [Files in question answers](./user/question-attachments.md)
- [Working with threads](./user/thread-sidebar.md)
- [Threads from older T3 Code versions](./user/thread-migration.md)
- [Context in portable handoffs](./user/portable-handoffs.md)
- [Activity log](./user/activity-log.md)
- [Permission modes](./user/permission-modes.md)
- [Terminal history](./user/terminal.md)
- [Source control](./user/source-control.md)
- [Project settings](./user/project-settings.md)
- [Appearance and themes](./user/appearance.md)
- [Keyboard shortcuts](./user/keybindings.md)
- [Keyboard focus](./user/keyboard-focus.md)
- [Visual replies](./user/html-renders.md)
- [Text generation models](./user/text-generation.md)
- [Usage and limits](./user/usage.md)
- [Secrets](./user/secrets.md)
- [Telemetry](./user/telemetry.md)
- [Remote access](./user/remote-access.md)
- [Outside agents (MCP)](./user/outside-agents.md)
- [Running in the background](./user/background-service.md)
- [Updating](./user/updating.md)
- [Open source licenses](./user/open-source-licenses.md)
- Provider guides: [Codex](./user/providers-codex.md) · [Claude](./user/providers-claude.md) · [Antigravity](./user/providers-antigravity.md) · [ACP agents](./user/providers-acp.md)

---

## Working on T3 Code

Start with the [development runbook](./operations/development.md).

Internal notes preserve architectural decisions, constraints, and implementation traps that the
source alone does not explain. Most code changes do not need an internal documentation update. Follow the
[documentation rules](../AGENTS.md#documentation) before adding one.

- [Architecture overview](./internals/overview.md)
- [Glossary](./internals/glossary.md)
- [Connection runtime](./internals/connection-runtime.md)
- [Providers](./internals/providers.md)
- [Adding a provider](./internals/adding-a-provider.md)
- [Effect services](./internals/effect-services.md)
- [Web UI](./internals/web-ui.md)
- [Testing](./internals/testing.md)
- [Performance regression checks](./internals/performance-regressions.md)
- [Composer context references](./internals/composer-context-references.md)
- [Composer coordinates and serialization](./internals/composer-editors.md)
- [Context handoffs](./internals/context-handoffs.md)
- [Action names agree across presentations](./internals/consistency-action-names.md)
- [Model classification](./internals/model-manifest.md)
- [Remote environments](./internals/remote.md)
- [Resource telemetry](./internals/resource-telemetry.md)
- [Environment auth](./internals/environment-auth.md)
- [Assistant citations](./internals/assistant-citations.md)
- [Terminal runtime](./internals/terminal-runtime.md)
- [Server updates](./internals/server-updates.md)
- [Legacy orchestration migration](./internals/legacy-orchestration-migration.md)
- [Open source license notices](./internals/open-source-licenses.md)

### Orchestration V2

[Orchestration V2](./orchestration-v2/README.md) describes the server's command, event, and
provider model. Its pages cover the
[core graph and data model](./orchestration-v2/core-graph-and-data-model.md),
[entity IDs and correlation](./orchestration-v2/entity-ids-and-correlation.md),
[feature lifecycles](./orchestration-v2/feature-lifecycles.md),
[the orchestrator MCP server](./orchestration-v2/orchestrator-mcp-server.md),
[provider capabilities](./orchestration-v2/provider-capability-system.md),
[provider switching and context](./orchestration-v2/provider-switching-and-context.md),
[thread lineage and context transfer](./orchestration-v2/thread-lineage-and-context-transfer.md), and
[testing strategy](./orchestration-v2/testing-strategy.md).

### Runbooks

- [Development and local builds](./operations/development.md)
- [France VPS headless ADE (WireGuard)](./operations/france-headless.md)
- [SWE-2 duty: triage and nightly retro](./operations/swe-duty.md)
- [Scenarios: real-app proof for a fix](./operations/scenarios.md)
- [Live background-work verification](./operations/background-verification.md)
- [Release](./operations/release.md)
- [Observability](./operations/observability.md)

### Verification records

Internal fork-verification notes, in Chinese:

- [关一 Linux 测试基线](./验证/关一-Linux测试基线.md)
- [关二 离得开它家](./验证/关二-离得开它家.md)
- [关三① 经 reclaude 起 Claude](./验证/关三①-经reclaude起Claude.md)
- [跳过清单](./验证/跳过清单.md)

# Model manifest

The [bundled manifest](../../apps/server/src/provider/model-manifest.json) is the only
source of model metadata; the server never fetches it. This repo does not follow
the upstream project, so a fetch would hand model classification and compatibility
gates to someone else's repository. Model data changes with a release.

Generic catalog data describes presentation and capabilities. Each provider owns
its adapter schema and dispatch mappings. Providers never read the manifest
itself: the server exposes each driver's entry through the
[`ModelCatalog`](../../packages/provider-core/src/server/ModelCatalog.ts) port,
and compatibility policies stay with the server. Claude uses the manifest for its entire
built-in catalog. Adding a model with an existing capability profile is a JSON
edit; a new profile is needed only for a new capability combination. Codex still
gets its model list from its app server.

A model that needs a newer provider CLI should still be announced as soon as it
ships. Claude entries set `adapter.claudeCode.minVersion`; Codex entries set
`adapter.codex.minVersion`, since Codex's own `model/list` cannot name models
released after the installed build. Snapshots report those models in
`updateRequiredModels`, and the picker tells the user which update unlocks them.

Model data is schema-validated configuration. Tests should cover resolver
and adapter semantics with synthetic model names, so adding a model never requires
tests that repeat the configuration.

## 更新内置模型清单

当维护者提供了新的模型清单地址或文件时，运行 `pnpm models:sync --source <地址或本地 JSON 路径>`。来源相对路径按输入命令时的目录解析；通过 pnpm 运行时使用 `INIT_CWD`。命令会校验来源，打印完整清单差异；只有加上 `--write` 才会原子替换内置文件，且写入内容来自校验后的对象，不保留来源中的多余字段。

跑完后运行会读取内置清单的服务端测试：`apps/server/src/provider/ModelManifest.test.ts`、`apps/server/src/provider/ProviderRegistry.test.ts`，再运行 `vp fmt --check`。用本地副本先审查；命令不会写入不合法或空清单。

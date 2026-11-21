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

## Updating the bundled manifest

Run `pnpm models:sync --source <URL or local JSON path>` when a provider publishes a new manifest. The command validates the source, prints added, removed, and changed models, and only writes the bundled file when `--write` is supplied. Use a local copy first when reviewing a change; the command never writes an invalid or empty manifest.

After writing, run `pnpm exec vp test run scripts/sync-models.test.ts apps/server/src/theirServices.static.test.ts` and inspect the selector with the relevant provider and model name. Review `git diff` to confirm only the intended manifest content changed.

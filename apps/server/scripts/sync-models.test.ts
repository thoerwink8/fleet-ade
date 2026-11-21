// @effect-diagnostics nodeBuiltinImport:off - test reads the bundled JSON fixture.
import * as NodeFS from "node:fs";

import { assert, describe, it } from "@effect/vitest";

import * as ModelManifest from "../src/provider/ModelManifest.ts";

import {
  compareModelManifests,
  decideModelManifestWrite,
  formatModelManifest,
  validateModelManifest,
} from "./sync-models.ts";

const manifest = (
  models: ReadonlyArray<{ readonly slug: string; readonly name: string }>,
  extra: Record<string, unknown> = {},
) =>
  ({
    version: 1,
    currentModels: {},
    providers: {
      synthetic: {
        profiles: {},
        models: models.map((model) => ({ ...model, status: "current" as const })),
      },
    },
    ...extra,
  }) as ModelManifest.ModelManifestData;

describe("compareModelManifests", () => {
  it("reports added, removed, and changed models", () => {
    const diff = compareModelManifests(
      manifest([
        { slug: "kept", name: "Kept" },
        { slug: "removed", name: "Removed" },
        { slug: "changed", name: "Old name" },
      ]),
      manifest([
        { slug: "kept", name: "Kept" },
        { slug: "added", name: "Added" },
        { slug: "changed", name: "New name" },
      ]),
    );

    assert.deepStrictEqual(
      diff.added.map(({ model }) => model.slug),
      ["added"],
    );
    assert.deepStrictEqual(
      diff.removed.map(({ model }) => model.slug),
      ["removed"],
    );
    assert.deepStrictEqual(diff.changed, [
      {
        provider: "synthetic",
        slug: "changed",
        fields: [{ field: "name", from: "Old name", to: "New name" }],
      },
    ]);
  });

  it("reports no differences for equal manifests", () => {
    assert.deepStrictEqual(
      compareModelManifests(
        manifest([{ slug: "same", name: "Same" }]),
        manifest([{ slug: "same", name: "Same" }]),
      ),
      { added: [], removed: [], changed: [], changes: [] },
    );
  });

  it("reports envelope and provider catalog changes", async () => {
    const current = manifest([{ slug: "same", name: "Same" }], {
      updatedAt: "2026-01-01T00:00:00Z",
      compatibility: [{ driver: "codex", t3CodeRange: ">=1.0.0", ranges: [] }],
      currentModels: { synthetic: ["same"] },
      providers: {
        synthetic: {
          profiles: { basic: { adapter: { mode: "old" } } },
          models: [{ slug: "same", name: "Same", status: "current" }],
        },
      },
    });
    const next = manifest([{ slug: "same", name: "Same" }], {
      updatedAt: "2026-01-02T00:00:00Z",
      compatibility: [
        {
          driver: "codex",
          t3CodeRange: ">=1.0.0",
          ranges: [{ range: ">=1.0.0", status: "supported" }],
        },
      ],
      currentModels: { synthetic: ["same", "new"] },
      providers: {
        synthetic: {
          profiles: { basic: { adapter: { mode: "new" } } },
          models: [{ slug: "same", name: "Same", status: "current" }],
        },
      },
    });
    const diff = compareModelManifests(current, next);
    assert.deepStrictEqual(
      diff.changes.map(({ path }) => path),
      ["updatedAt", "compatibility", "currentModels", "providers.synthetic.profiles"],
    );
    assert.equal((await decideModelManifestWrite(current, next, "{}")).write, true);
  });

  it("reports a compatibility-only change", () => {
    const compatibility = [{ driver: "codex", t3CodeRange: ">=1.0.0", ranges: [] }];
    const current = manifest([{ slug: "same", name: "Same" }], { compatibility });
    const next = manifest([{ slug: "same", name: "Same" }], {
      compatibility: [
        {
          driver: "codex",
          t3CodeRange: ">=1.0.0",
          ranges: [{ range: ">=1.0.0", status: "supported" }],
        },
      ],
    });
    assert.deepStrictEqual(
      compareModelManifests(current, next).changes.map(({ path }) => path),
      ["compatibility"],
    );
  });

  it("reports a profile-only change", () => {
    const withProfile = (mode: string) =>
      manifest([{ slug: "same", name: "Same" }], {
        providers: {
          synthetic: {
            profiles: { basic: { adapter: { mode } } },
            models: [{ slug: "same", name: "Same", status: "current" }],
          },
        },
      });
    assert.deepStrictEqual(
      compareModelManifests(withProfile("old"), withProfile("new")).changes.map(({ path }) => path),
      ["providers.synthetic.profiles"],
    );
  });

  it("ignores object key order when deciding whether to write", async () => {
    const current = manifest([{ slug: "same", name: "Same" }], {
      updatedAt: "2026-01-01T00:00:00Z",
      currentModels: { synthetic: ["same"] },
    });
    const reordered = {
      providers: current.providers,
      currentModels: current.currentModels,
      updatedAt: current.updatedAt,
      version: current.version,
    } as ModelManifest.ModelManifestData;
    assert.deepStrictEqual(compareModelManifests(current, reordered), {
      changes: [],
      added: [],
      removed: [],
      changed: [],
    });
    assert.deepStrictEqual(await decideModelManifestWrite(current, reordered, "{}"), {
      write: false,
    });
  });
});

describe("model manifest validation and write decision", () => {
  it("rejects empty and invalid manifests", () => {
    assert.throws(() => validateModelManifest(manifest([])), /来源模型清单不包含任何模型/);
    assert.throws(() => validateModelManifest({}), /来源不是合法的模型清单/);
  });

  it("writes only validated manifest changes", async () => {
    const current = manifest([{ slug: "same", name: "Same" }]);
    const next = manifest([{ slug: "same", name: "Updated" }]);
    assert.deepStrictEqual(await decideModelManifestWrite(current, current, "{}"), {
      write: false,
    });
    assert.deepStrictEqual(await decideModelManifestWrite(current, next, "{}"), {
      write: true,
      text: await formatModelManifest(next, "{}"),
    });
  });

  it("formats source layouts identically and preserves the bundled text", async () => {
    const text = NodeFS.readFileSync(
      new URL("../src/provider/model-manifest.json", import.meta.url),
      "utf8",
    );
    const value = validateModelManifest(JSON.parse(text));
    assert.equal(await formatModelManifest(value, text), text);

    const changed = { ...value, updatedAt: "2026-01-01T00:00:00Z" };
    const compactSource = validateModelManifest(JSON.parse(JSON.stringify(changed)));
    const indentedSource = validateModelManifest(JSON.parse(JSON.stringify(changed, null, 2)));
    assert.equal(
      await formatModelManifest(compactSource, text),
      await formatModelManifest(indentedSource, text),
    );
  });
});

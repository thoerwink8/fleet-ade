import { assert, describe, it } from "@effect/vitest";

import * as ModelManifest from "../apps/server/src/provider/ModelManifest.ts";

import {
  compareModelManifests,
  decideModelManifestWrite,
  validateModelManifest,
} from "./sync-models.ts";

const manifest = (models: ReadonlyArray<{ readonly slug: string; readonly name: string }>) =>
  ({
    version: 1,
    currentModels: {},
    providers: {
      synthetic: {
        profiles: {},
        models: models.map((model) => ({ ...model, status: "current" as const })),
      },
    },
  }) satisfies ModelManifest.ModelManifestData;

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
      { added: [], removed: [], changed: [] },
    );
  });
});

describe("model manifest validation and write decision", () => {
  it("rejects empty and invalid manifests", () => {
    assert.throws(() => validateModelManifest(manifest([])), /contains no models/);
    assert.throws(() => validateModelManifest({}), /not a valid model manifest/);
  });

  it("writes only validated changes and preserves source text", () => {
    const current = manifest([{ slug: "same", name: "Same" }]);
    const next = manifest([{ slug: "same", name: "Updated" }]);
    assert.deepStrictEqual(decideModelManifestWrite(current, current, "unchanged"), {
      write: false,
    });
    assert.deepStrictEqual(decideModelManifestWrite(current, next, "source"), {
      write: true,
      text: "source\n",
    });
  });
});

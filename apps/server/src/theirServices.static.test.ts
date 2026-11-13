import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { bannedHostPattern, dotted, isBannedHost, scanTheirHosts } from "./theirServices.scan.ts";

const scanRoot = process.env.THEIR_SERVICES_SCAN_ROOT?.trim();

it.effect("does not match a lookalike host", () =>
  Effect.sync(() => {
    assert.strictEqual(isBannedHost(dotted("not3", "codes")), false);
    assert.strictEqual(isBannedHost(dotted("ingest", dotted("t3", "codes"))), true);
    assert.strictEqual(isBannedHost(dotted("prod-a1", dotted("t3coderelay", "com"))), true);
    assert.strictEqual(
      bannedHostPattern().test(`see ${dotted("app", dotted("t3", "codes"))} now`),
      true,
    );
  }),
);

it.effect("flags a file that names a banned host", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "their-hosts-" });
    yield* fs.writeFileString(
      path.join(root, "leak.ts"),
      `export const host = "https://${dotted("ingest", dotted("t3", "codes"))}/x";\n`,
    );
    assert.deepStrictEqual(yield* scanTheirHosts(root), ["leak.ts 1"]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("source does not name their hosts", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const root = scanRoot || path.resolve(import.meta.dirname, "../../..");
    assert.deepStrictEqual(yield* scanTheirHosts(root), []);
  }).pipe(Effect.provide(NodeServices.layer)),
);

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { referenceRepos } from "./lib/reference-repos.ts";
import {
  applyReferenceRepoSync,
  planReferenceRepoSync,
  resolveReferenceRepoRef,
} from "./sync-reference-repos.ts";

const effectRepo = referenceRepos[0]!;
const alchemyEffect = referenceRepos[1]!;

const execGit = Effect.fnUntraced(function* (cwd: string, args: ReadonlyArray<string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(ChildProcess.make("git", [...args], { cwd }));
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [
      child.stdout.pipe(Stream.decodeText(), Stream.mkString),
      child.stderr.pipe(Stream.decodeText(), Stream.mkString),
      child.exitCode.pipe(Effect.map(Number)),
    ],
    { concurrency: "unbounded" },
  );
  return { stdout, stderr, exitCode };
}, Effect.scoped);

it.layer(NodeServices.layer)("sync-reference-repos", (it) => {
  it.effect("resolves reference tags from the root catalog", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const rootDir = yield* fs.makeTempDirectoryScoped({
        prefix: "sync-reference-repos-version-",
      });
      yield* fs.writeFileString(
        path.join(rootDir, "pnpm-workspace.yaml"),
        "catalog:\n  alchemy: 2.0.0-beta.84\n  effect: 4.0.0-beta.73\n",
      );

      assert.equal(
        yield* resolveReferenceRepoRef(effectRepo, rootDir, false),
        "effect@4.0.0-beta.73",
      );
      assert.equal(yield* resolveReferenceRepoRef(alchemyEffect, rootDir, false), "v2.0.0-beta.84");
    }),
  );

  it.effect("plans a shallow, tagless clone of the resolved ref", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const rootDir = yield* fs.makeTempDirectoryScoped({
        prefix: "sync-reference-repos-plan-",
      });
      yield* fs.writeFileString(
        path.join(rootDir, "pnpm-workspace.yaml"),
        "catalog:\n  effect: 4.0.0-beta.73\n",
      );

      const plan = yield* planReferenceRepoSync(effectRepo, rootDir, false);
      assert.equal(plan.ref, "effect@4.0.0-beta.73");
      assert.deepStrictEqual(plan.cloneArgs, [
        "clone",
        "--quiet",
        "--depth=1",
        "--no-tags",
        "--single-branch",
        "--branch=effect@4.0.0-beta.73",
        "https://github.com/Effect-TS/effect.git",
      ]);
    }),
  );

  it.effect("strips unmapped 160000 submodule gitlinks when syncing a reference repo", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({
        prefix: "sync-reference-repos-gitlinks-",
      });
      const upstreamDir = path.join(tempDir, "upstream");
      const rootDir = path.join(tempDir, "root");
      yield* fs.makeDirectory(path.join(upstreamDir, "submodules/distilled"), { recursive: true });
      yield* fs.makeDirectory(rootDir, { recursive: true });

      for (const dir of [upstreamDir, rootDir]) {
        assert.equal((yield* execGit(dir, ["init", "--quiet"])).exitCode, 0);
        assert.equal((yield* execGit(dir, ["config", "user.name", "Test"])).exitCode, 0);
        assert.equal(
          (yield* execGit(dir, ["config", "user.email", "test@example.com"])).exitCode,
          0,
        );
      }

      yield* fs.writeFileString(path.join(upstreamDir, "README.md"), "alchemy reference\n");
      // Keep an empty submodule mountpoint in the upstream tree via a gitlink entry.
      assert.equal(
        (yield* execGit(upstreamDir, [
          "update-index",
          "--add",
          "--cacheinfo",
          "160000,e02e9d405b8848909f4f746b61b12a663f631c7c,submodules/distilled",
        ])).exitCode,
        0,
      );
      assert.equal((yield* execGit(upstreamDir, ["add", "README.md"])).exitCode, 0);
      assert.equal((yield* execGit(upstreamDir, ["commit", "--quiet", "-m", "init"])).exitCode, 0);

      // Seed rootDir with an inherited orphan 160000 gitlink and no root .gitmodules.
      yield* fs.makeDirectory(path.join(rootDir, ".repos/alchemy-effect/submodules/distilled"), {
        recursive: true,
      });
      assert.equal(
        (yield* execGit(rootDir, [
          "update-index",
          "--add",
          "--cacheinfo",
          "160000,e02e9d405b8848909f4f746b61b12a663f631c7c,.repos/alchemy-effect/submodules/distilled",
        ])).exitCode,
        0,
      );
      assert.equal(
        (yield* execGit(rootDir, ["commit", "--quiet", "-m", "broken gitlink"])).exitCode,
        0,
      );
      assert.equal((yield* execGit(rootDir, ["submodule", "status"])).exitCode, 128);

      yield* applyReferenceRepoSync(rootDir, {
        repo: alchemyEffect,
        ref: "v2.0.0-beta.84",
        cloneArgs: ["clone", "--quiet", upstreamDir],
      });

      const submoduleStatus = yield* execGit(rootDir, ["submodule", "status"]);
      assert.equal(submoduleStatus.exitCode, 0, submoduleStatus.stderr);
      assert.equal(submoduleStatus.stdout, "");

      const staged = yield* execGit(rootDir, ["ls-files", "--stage", "--", alchemyEffect.prefix]);
      assert.equal(staged.exitCode, 0);
      assert.include(staged.stdout, ".repos/alchemy-effect/README.md");
      assert.notInclude(staged.stdout, "160000 ");
    }),
  );
});

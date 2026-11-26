// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Option from "effect/Option";
import { afterAll, assert, describe, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as TestClock from "effect/testing/TestClock";

import {
  comparisonBase,
  defaultConcurrency,
  gitLines,
  ignoredCheckInputs,
  judgeFilteredVitestStep,
  runSteps,
  shouldRunCssFontWeightTest,
  shouldRunDocsLinks,
  splitTests,
  type Step,
} from "./check-changed.ts";
import { decide, readWorkspace } from "../.github/scripts/ci-changes.cjs";

const GiB = 1024 ** 3;

describe("check:changed", () => {
  it("bounds the default concurrency by the scarcer of cores and available memory", () => {
    assert.strictEqual(defaultConcurrency(32, 128 * GiB), 16);
    assert.strictEqual(defaultConcurrency(32, 20 * GiB), 3);
    assert.strictEqual(defaultConcurrency(4, 15 * GiB), 2);
    assert.strictEqual(defaultConcurrency(4, 2 * GiB), 1);
    assert.strictEqual(defaultConcurrency(1, 64 * GiB), 1);
  });

  it("leaves docs inert", () => {
    const packages = readWorkspace();
    assert.deepStrictEqual(decide(["docs/user/install.md"], packages, false).affected, []);
  });

  it("runs docs-links only when markdown, docs, scanned client/package sources, or the checker change", () => {
    assert.isTrue(shouldRunDocsLinks(["README.md"]));
    assert.isTrue(shouldRunDocsLinks(["docs/user/faq.md"]));
    assert.isTrue(shouldRunDocsLinks(["docs/assets/diagram.png"]));
    assert.isTrue(
      shouldRunDocsLinks(["apps/web/src/components/settings/MultipleAccountsNote.tsx"]),
    );
    assert.isTrue(shouldRunDocsLinks(["packages/shared/src/markdownLinks.ts"]));
    assert.isTrue(shouldRunDocsLinks(["scripts/docs-links.ts"]));
    assert.isFalse(shouldRunDocsLinks(["apps/server/src/ws.ts", "package.json"]));
  });

  it("runs cssFontWeight test when web stylesheets change", () => {
    assert.isTrue(shouldRunCssFontWeightTest(["apps/web/src/index.css"]));
    assert.isTrue(shouldRunCssFontWeightTest(["apps/web/src/styles/fleet-overrides/menu.css"]));
    assert.isFalse(shouldRunCssFontWeightTest(["apps/web/src/App.tsx"]));
    assert.isFalse(shouldRunCssFontWeightTest(["apps/desktop/src/main.css"]));
  });

  it.effect(
    "keeps weighted steps within the budget, in order, and serial steps one at a time",
    () =>
      Effect.gen(function* () {
        const startedAt: Record<string, number> = {};
        let active = 0;
        let maxActive = 0;
        let serialActive = 0;
        let maxSerial = 0;
        const step = (
          name: string,
          options: { weight?: number; serial?: boolean } = {},
        ): Step<never> => {
          const slots = Math.min(options.weight ?? 1, 3);
          return {
            name,
            ...options,
            run: Effect.gen(function* () {
              startedAt[name] = (yield* Clock.currentTimeMillis) / 1000;
              active += slots;
              maxActive = Math.max(maxActive, active);
              if (options.serial) maxSerial = Math.max(maxSerial, ++serialActive);
              yield* Effect.sleep("1 second");
              active -= slots;
              if (options.serial) serialActive--;
              return { ok: true, output: "" };
            }),
          };
        };
        const fiber = yield* runSteps(
          [
            step("light 1"),
            // Above the budget, so it holds every slot rather than never starting.
            step("heavy", { weight: 5 }),
            step("pair", { weight: 2 }),
            step("light 2"),
            step("test 1", { serial: true }),
            step("test 2", { serial: true }),
          ],
          { concurrency: 3, timeoutSeconds: 60 },
        ).pipe(Effect.forkChild);
        yield* TestClock.adjust("10 seconds");
        const results = yield* Fiber.join(fiber);

        assert.deepStrictEqual(
          results.map((result) => result.outcome),
          ["pass", "pass", "pass", "pass", "pass", "pass"],
        );
        assert.strictEqual(maxActive, 3);
        // Lighter steps queued behind the heavy one never start ahead of it.
        assert.deepStrictEqual(startedAt, {
          "light 1": 0,
          heavy: 1,
          pair: 2,
          "light 2": 2,
          "test 1": 3,
          "test 2": 4,
        });
        assert.strictEqual(maxSerial, 1);
      }),
  );

  it.effect("interrupts a step at its timeout and reports TIMEOUT, apart from FAIL", () =>
    Effect.gen(function* () {
      let interrupted = false;
      const fiber = yield* runSteps(
        [
          {
            name: "hangs",
            run: Effect.never.pipe(
              Effect.onInterrupt(() => Effect.sync(() => (interrupted = true))),
            ),
          },
          { name: "fails", run: Effect.succeed({ ok: false, output: "error" }) },
          { name: "passes", run: Effect.succeed({ ok: true, output: "" }) },
        ],
        { concurrency: 3, timeoutSeconds: 10 },
      ).pipe(Effect.forkChild);
      yield* TestClock.adjust("9 seconds");
      assert.isFalse(interrupted);
      yield* TestClock.adjust("1 second");
      const results = yield* Fiber.join(fiber);

      assert.isTrue(interrupted);
      assert.deepStrictEqual(
        results.map(({ name, outcome, time }) => [name, outcome, time]),
        [
          ["hangs", "TIMEOUT", "killed after 10s"],
          ["fails", "FAIL", "0.0s"],
          ["passes", "pass", "0.0s"],
        ],
      );
    }),
  );

  it("judges a -t vitest step from the json report counts", () => {
    const filter = "compiles apps/web/src/components/ui/button.tsx$";
    const note = `过滤没匹配到任何用例\n${filter}`;
    const judge = (
      counts: { readonly numPassedTests: number; readonly numFailedTests: number } | undefined,
      exitOk: boolean,
    ) =>
      judgeFilteredVitestStep({
        reportJson:
          counts === undefined
            ? undefined
            : JSON.stringify({
                ...counts,
                numPendingTests: 4,
                numTotalTests: counts.numPassedTests + counts.numFailedTests + 4,
                success: counts.numFailedTests === 0,
              }),
        exitOk,
        filter,
        output: "vitest output",
      });

    const skipped = judge({ numPassedTests: 0, numFailedTests: 0 }, true);
    assert.strictEqual(skipped.ok, false);
    assert.strictEqual(skipped.output, `vitest output\n${note}`);

    const noneCollected = judgeFilteredVitestStep({
      reportJson: JSON.stringify({
        numPassedTests: 0,
        numFailedTests: 0,
        numTotalTests: 0,
        success: false,
      }),
      exitOk: true,
      filter,
      output: "",
    });
    assert.strictEqual(noneCollected.ok, false);
    assert.strictEqual(noneCollected.output, note);

    const missing = judge(undefined, true);
    assert.strictEqual(missing.ok, false);
    assert.strictEqual(missing.output, `vitest output\n${note}`);

    const passed = judge({ numPassedTests: 2, numFailedTests: 0 }, true);
    assert.strictEqual(passed.ok, true);
    assert.strictEqual(passed.output, "vitest output");

    const crashed = judge({ numPassedTests: 2, numFailedTests: 0 }, false);
    assert.strictEqual(crashed.ok, false);
    assert.strictEqual(crashed.output, "vitest output");

    const failed = judge({ numPassedTests: 1, numFailedTests: 1 }, true);
    assert.strictEqual(failed.ok, false);
    assert.strictEqual(failed.output, "vitest output");

    const allFailed = judge({ numPassedTests: 0, numFailedTests: 3 }, false);
    assert.strictEqual(allFailed.ok, false);
    assert.strictEqual(allFailed.output, "vitest output");
  });

  it("runs the .github/scripts node:test files with node --test, not vitest", () => {
    assert.deepStrictEqual(
      splitTests([
        "apps/server/src/ws.test.ts",
        ".github/scripts/ci-changes.test.cjs",
        ".github\\scripts\\duty.test.cjs",
        "scripts/check-changed.test.ts",
      ]),
      {
        vitestTests: ["apps/server/src/ws.test.ts", "scripts/check-changed.test.ts"],
        nodeTests: [".github/scripts/ci-changes.test.cjs", ".github\\scripts\\duty.test.cjs"],
      },
    );
  });

  it.effect("fails instead of returning an empty file list when git exits nonzero", () => {
    const spawner = (exitCode: number) =>
      ChildProcessSpawner.make(() =>
        Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.encodeText(Stream.make(exitCode === 0 ? "a.ts\nb.ts\n" : "")),
            stderr: Stream.encodeText(
              Stream.make(exitCode === 0 ? "" : "fatal: index file corrupt"),
            ),
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          }),
        ),
      );
    return Effect.gen(function* () {
      const listed = yield* gitLines("/repo", ["ls-files"]).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner(0)),
      );
      assert.deepStrictEqual(listed, ["a.ts", "b.ts"]);
      const error = yield* gitLines("/repo", ["ls-files"]).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner(128)),
        Effect.flip,
      );
      assert.strictEqual(
        error,
        "check:changed: git ls-files exited with 128: fatal: index file corrupt",
      );
    });
  });

  it("opens the built desktop app only for startup, settlement, and sidebar changes", () => {
    const packages = readWorkspace();
    const launches = (file: string) => decide([file], packages, false).outputs.desktop_launch;
    for (const file of [
      "apps/server/src/orchestration-v2/ThreadSettlementService.ts",
      "apps/server/src/persistence/Migrations/054_ProjectionThreadsAutoSettleDisabledAt.ts",
      "apps/web/src/components/sidebar/SidebarThreadRow.tsx",
      "apps/desktop/src/backend/DesktopBackendManager.ts",
      "apps/desktop/src/electron/ElectronProtocol.ts",
      "packages/contracts/src/settings.ts",
      "scripts/fixtures/desktop-launch/statev2.sqlite",
    ]) {
      assert.isTrue(launches(file), file);
    }
    for (const file of [
      "apps/server/src/orchestration-v2/ThreadSettlementService.test.ts",
      "apps/web/src/components/chat/ChatView.tsx",
      "apps/desktop/src/updates/DesktopRemoteUpdates.ts",
      "packages/contracts/src/orchestration.ts",
    ]) {
      assert.isFalse(launches(file), file);
    }
    // A script-only change still builds the app it opens.
    assert.isTrue(decide(["scripts/smoke-desktop-app.ts"], packages, false).outputs.build);
  });

  it.each([
    "packages/shared/src/testing/longTempDir.ts",
    "packages/shared/src/testing/providerEnv.ts",
  ])("tests every package when the shared test setup file %s changes", (file) => {
    assert.strictEqual(decide([file], readWorkspace(), false).outputs.test_packages, "");
  });
});

// Hooks export GIT_DIR and GIT_INDEX_FILE, and user config or the default
// ~/.config/git/ignore can ignore or sign fixture files.
// Git for Windows rejects the null device as a config path, so use an empty file.
const emptyConfigDir = NodeFS.mkdtempSync(
  NodePath.join(NodeOS.tmpdir(), "t3-check-changed-config-"),
);
const emptyConfig = NodePath.join(emptyConfigDir, "empty.gitconfig");
NodeFS.writeFileSync(emptyConfig, "");
afterAll(() => NodeFS.rmSync(emptyConfigDir, { recursive: true, force: true }));
const fixtureConfig = {
  "core.excludesFile": emptyConfig,
  "user.name": "Fixture",
  "user.email": "fixture@example.invalid",
};
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_"))),
  GIT_CONFIG_GLOBAL: emptyConfig,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_COUNT: String(Object.keys(fixtureConfig).length),
  ...Object.fromEntries(
    Object.entries(fixtureConfig).flatMap(([key, value], index) => [
      [`GIT_CONFIG_KEY_${index}`, key],
      [`GIT_CONFIG_VALUE_${index}`, value],
    ]),
  ),
};

// History A -> B -> C, with HEAD at C. Each remote's main points at A or B.
function fixture(remotes: Record<string, "A" | "B">) {
  const root = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-check-changed-")),
  );
  const commits: Record<string, string> = {};
  try {
    const write = (file: string, content: string) => {
      const path = NodePath.join(root, file);
      NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
      NodeFS.writeFileSync(path, content);
    };
    const git = (...args: Array<string>) =>
      NodeChildProcess.execFileSync("git", args, { cwd: root, encoding: "utf8", env }).trim();
    git("init");
    for (const name of ["A", "B", "C"]) {
      write(`${name}.txt`, name);
      git("add", ".");
      git("commit", "-m", name);
      commits[name] = git("rev-parse", "HEAD");
    }
    for (const [remote, commit] of Object.entries(remotes)) {
      git("remote", "add", remote, NodePath.join(root, "missing"));
      git("update-ref", `refs/remotes/${remote}/main`, commits[commit]!);
    }
  } catch (error) {
    NodeFS.rmSync(root, { recursive: true, force: true });
    throw error;
  }
  return {
    commits,
    root,
    [Symbol.dispose]() {
      NodeFS.rmSync(root, { recursive: true, force: true });
    },
  };
}

const inFixture = <A, E>(
  effect: Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner>,
  extraEnv?: Record<string, string>,
) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return yield* effect.pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make((command) =>
          spawner.spawn(ChildProcess.setEnv(command, { ...env, ...extraEnv })),
        ),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.runPromise);
const compare = (root: string, ref: Option.Option<string>) => inFixture(comparisonBase(root, ref));

it.each(["upstream", "team/upstream"])(
  "compares against %s/main when the fork's origin/main lags it",
  async (remote) => {
    using project = fixture({ origin: "A", [remote]: "B" });
    const result = await compare(project.root, Option.none());
    assert.strictEqual(result.base, project.commits.B);
    assert.strictEqual(result.ref, remote + "/main");
  },
);

it("compares against an explicit ref instead of the closest remote main", async () => {
  using project = fixture({ origin: "A", upstream: "B" });
  const result = await compare(project.root, Option.some("origin/main"));
  assert.strictEqual(result.base, project.commits.A);
  assert.strictEqual(result.ref, "origin/main");
});

// The oracle is the pathspec command the input hash used before, so each scenario proves the
// rewritten listing hashes the same ignored inputs.
const oldIgnoredListing = (root: string) =>
  NodeChildProcess.execFileSync(
    "git",
    [
      "ls-files",
      "-o",
      "-i",
      "--exclude-standard",
      "--",
      ":(glob)**/.generated/**",
      ":(glob)**/.astro/**",
      ":(glob)**/*.d.ts",
      ":(glob)**/.env*",
      ":(exclude,glob)**/node_modules/**",
    ],
    { cwd: root, encoding: "utf8", env },
  )
    .split("\n")
    .filter(Boolean)
    .sort();

function ignoredFixture(setup: (write: (file: string, content?: string) => void) => void) {
  const root = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-ignored-inputs-")),
  );
  const write = (file: string, content = "") => {
    const path = NodePath.join(root, file);
    NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
    NodeFS.writeFileSync(path, content);
  };
  try {
    setup(write);
    NodeChildProcess.execFileSync("git", ["init"], { cwd: root, encoding: "utf8", env });
  } catch (error) {
    NodeFS.rmSync(root, { recursive: true, force: true });
    throw error;
  }
  return {
    root,
    write,
    git: (...args: Array<string>) =>
      NodeChildProcess.execFileSync("git", args, { cwd: root, encoding: "utf8", env }),
    [Symbol.dispose]() {
      NodeFS.rmSync(root, { recursive: true, force: true });
    },
  };
}

it("lists the same ignored inputs as the old pathspecs at the root and nested", async () => {
  using project = ignoredFixture((write) => {
    write(".gitignore", "node_modules/\ndist/\n.generated/\n.env*\n*.gen.d.ts\n");
    write(".env.local");
    write("src/types.gen.d.ts");
    write("src/.generated/routes.ts");
    write("dist/index.d.ts");
    write("node_modules/pkg/index.d.ts");
    write("packages/x/src/deep.gen.d.ts");
  });
  const old = oldIgnoredListing(project.root);
  assert.includeMembers(old, [
    ".env.local",
    "dist/index.d.ts",
    "packages/x/src/deep.gen.d.ts",
    "src/types.gen.d.ts",
  ]);
  assert.deepStrictEqual(await inFixture(ignoredCheckInputs(project.root)), old);
});

it("lists the same ignored inputs as the old pathspecs in directories replacing tracked files", async () => {
  using project = ignoredFixture((write) => {
    write(".gitignore", "node_modules/\nreplaced/\nskipped/\n");
  });
  const { git, write } = project;
  write("replaced");
  write("skipped");
  git("init");
  git("add", ".");
  git("commit", "-m", "files that directories replace");
  git("update-index", "--skip-worktree", "skipped");
  for (const file of ["replaced", "skipped"]) {
    NodeFS.rmSync(NodePath.join(project.root, file));
  }
  write("replaced/sub/a.d.ts");
  write("skipped/a.d.ts");
  const old = oldIgnoredListing(project.root);
  assert.includeMembers(old, ["replaced/sub/a.d.ts", "skipped/a.d.ts"]);
  assert.deepStrictEqual(await inFixture(ignoredCheckInputs(project.root)), old);
});

it("lists the same ignored inputs as the old pathspecs in a leftover package folder", async () => {
  using project = ignoredFixture((write) => {
    write(".gitignore", "node_modules/\ndist/\n.generated/\n.env*\n");
    // A package folder left behind by a branch switch: git collapses it, and its
    // node_modules must not be walked.
    write("old/dist/a.d.ts");
    write("old/node_modules/pkg/index.d.ts");
    write("old/src/index.ts");
  });
  const old = oldIgnoredListing(project.root);
  assert.includeMembers(old, ["old/dist/a.d.ts"]);
  assert.deepStrictEqual(await inFixture(ignoredCheckInputs(project.root)), old);
});

it("ignores an unignored file sitting where an index directory is expected", async () => {
  using project = ignoredFixture((write) => {
    write(".gitignore", "node_modules/\n");
    write("path.d.ts/child.ts");
  });
  const { git, write } = project;
  git("add", "path.d.ts/child.ts");
  NodeFS.rmSync(NodePath.join(project.root, "path.d.ts"), { recursive: true });
  write("path.d.ts");
  // The blocker is neither ignored nor inside an ignored directory, so the old
  // pathspecs never listed it even though it matches *.d.ts.
  assert.deepStrictEqual(oldIgnoredListing(project.root), []);
  assert.deepStrictEqual(await inFixture(ignoredCheckInputs(project.root)), []);
});

it("excludes nested repositories inside node_modules from the inputs", async () => {
  using project = ignoredFixture((write) => {
    write(".gitignore", "node_modules/\n");
  });
  const { git } = project;
  NodeFS.mkdirSync(NodePath.join(project.root, "node_modules"), { recursive: true });
  NodeFS.mkdirSync(NodePath.join(project.root, "app/node_modules"), { recursive: true });
  git("-C", "node_modules", "init");
  git("-C", "app/node_modules", "init");
  // The contract change: nothing under any node_modules is a cache input. The
  // old pathspecs listed nested repositories as directory entries even here,
  // but their content is never read by any check, so the inputs are empty.
  assert.deepStrictEqual(oldIgnoredListing(project.root), ["app/node_modules/", "node_modules/"]);
  assert.deepStrictEqual(await inFixture(ignoredCheckInputs(project.root)), []);
});

it("does not walk a nested node_modules inside an ignored directory", async () => {
  using project = ignoredFixture((write) => {
    write(".gitignore", "build/\nnode_modules/\n");
    write("build/normal.d.ts");
    write("build/node_modules/pkg/ignored.d.ts");
  });
  const { git } = project;
  git("-C", "build/node_modules/pkg", "init");
  // git does walk the nested dependency tree and finds the repository root,
  // which the expansion must not reproduce: walking it is what froze Windows.
  assert.deepStrictEqual(oldIgnoredListing(project.root), [
    "build/node_modules/pkg/",
    "build/normal.d.ts",
  ]);
  assert.deepStrictEqual(await inFixture(ignoredCheckInputs(project.root)), ["build/normal.d.ts"]);
});

it("descends into a plain .git file inside an ignored directory as the old pathspecs did", async () => {
  using project = ignoredFixture((write) => {
    write(".gitignore", "build/\n");
    write("build/leaf/.git", "ordinary file\n");
    write("build/leaf/types.d.ts");
  });
  // `.git` must be a directory or a valid `gitdir:` file to stop git; ordinary
  // content makes the directory plain, so the declarations inside count.
  assert.deepStrictEqual(oldIgnoredListing(project.root), ["build/leaf/types.d.ts"]);
  assert.deepStrictEqual(await inFixture(ignoredCheckInputs(project.root)), [
    "build/leaf/types.d.ts",
  ]);
});

it("lists ignored nested repositories outside node_modules as directory entries", async () => {
  using project = ignoredFixture((write) => {
    write(".gitignore", "build/\n");
    write("build/repo/types.d.ts");
  });
  const { git } = project;
  git("-C", "build/repo", "init");
  // A nested repository boundary stands for its content in both listings.
  assert.deepStrictEqual(oldIgnoredListing(project.root), ["build/repo/"]);
  assert.deepStrictEqual(await inFixture(ignoredCheckInputs(project.root)), ["build/repo/"]);
});

it("lists an ignored nested worktree whose .git is a valid gitdir file as a directory entry", async () => {
  using project = ignoredFixture((write) => {
    write(".gitignore", "build/\n");
    write("separate/types.d.ts");
  });
  const { git, write, root } = project;
  git("init", "--separate-git-dir", NodePath.join(root, "separate.git"), "separate");
  write("build/wt/.git", "gitdir: ../../separate.git\n");
  write("build/wt/types.d.ts");
  // A gitdir file pointing at a real git directory is a repository boundary;
  // a garbage or missing target is not and gets descended.
  write("build/notwt/.git", "gitdir: ../missing.git\n");
  write("build/notwt/types.d.ts");
  // `gitdir:` without the space git requires is not a gitfile even when the
  // target would be a valid git directory; the control above keeps the space.
  write("build/nospace/.git", "gitdir:../../separate.git\n");
  write("build/nospace/types.d.ts");
  assert.deepStrictEqual(oldIgnoredListing(project.root), [
    "build/nospace/types.d.ts",
    "build/notwt/types.d.ts",
    "build/wt/",
  ]);
  assert.deepStrictEqual(await inFixture(ignoredCheckInputs(project.root)), [
    "build/nospace/types.d.ts",
    "build/notwt/types.d.ts",
    "build/wt/",
  ]);
});

it("lists an ignored nested linked worktree as a directory entry", async () => {
  using nested = ignoredFixture(() => {});
  nested.write("seed.txt");
  nested.git("add", ".");
  nested.git("commit", "-m", "seed");
  using project = ignoredFixture((write) => {
    write(".gitignore", "build/\n");
  });
  // A real `git worktree add`: the linked worktree's gitdir has a commondir
  // file and no objects of its own, sharing the main repository's store.
  project.git(
    "-C",
    nested.root,
    "worktree",
    "add",
    "--detach",
    NodePath.join(project.root, "build", "wt"),
    "HEAD",
  );
  project.write("build/wt/types.d.ts");
  assert.deepStrictEqual(oldIgnoredListing(project.root), ["build/wt/"]);
  assert.deepStrictEqual(await inFixture(ignoredCheckInputs(project.root)), ["build/wt/"]);
});

it("descends into a nested repository whose HEAD does not parse", async () => {
  using project = ignoredFixture((write) => {
    write(".gitignore", "build/\n");
    write("build/leaf/types.d.ts");
  });
  project.git("-C", "build/leaf", "init");
  NodeFS.writeFileSync(NodePath.join(project.root, "build/leaf/.git/HEAD"), "ordinary file\n");
  project.write("build/leaf/.git/inside.d.ts");
  // HEAD is the boundary test git applies: objects and refs survive, but a
  // HEAD that is neither a reference nor a commit id makes the directory
  // plain. Even then git never descends into the `.git` directory itself.
  assert.deepStrictEqual(oldIgnoredListing(project.root), ["build/leaf/types.d.ts"]);
  assert.deepStrictEqual(await inFixture(ignoredCheckInputs(project.root)), [
    "build/leaf/types.d.ts",
  ]);
});

it("descends into a nested repository missing its object store", async () => {
  using project = ignoredFixture((write) => {
    write(".gitignore", "build/\n");
    write("build/hollow/types.d.ts");
  });
  project.git("-C", "build/hollow", "init");
  NodeFS.rmSync(NodePath.join(project.root, "build/hollow/.git/objects"), {
    recursive: true,
    force: true,
  });
  // A valid HEAD is not enough: without the object store git treats the
  // directory as plain content.
  assert.deepStrictEqual(oldIgnoredListing(project.root), ["build/hollow/types.d.ts"]);
  assert.deepStrictEqual(await inFixture(ignoredCheckInputs(project.root)), [
    "build/hollow/types.d.ts",
  ]);
});

it("opens no dependency directory with readdir or git at any nesting depth", async () => {
  using project = ignoredFixture((write) => {
    write(".gitignore", "build/\nnode_modules/\n");
    write("build/normal.d.ts");
    write("build/node_modules/pkg/deep/deeper/ignored.js");
  });
  const trace = NodePath.join(project.root, "trace.json").replaceAll("\\", "/");
  const run = async () => {
    const visited: Array<string> = [];
    NodeFS.writeFileSync(trace, "");
    const readDirectory = async (absolute: string) => {
      visited.push(NodePath.relative(project.root, absolute).replaceAll("\\", "/"));
      return NodeFSP.readdir(absolute, { withFileTypes: true });
    };
    const inputs = await inFixture(ignoredCheckInputs(project.root, { readDirectory }), {
      GIT_TRACE2_EVENT: trace,
    });
    const directories = NodeFS.readFileSync(trace, "utf8")
      .split(/\r?\n/)
      .filter((line) => line.includes('"read_directory"'))
      .map((line) => {
        const event = JSON.parse(line) as { key?: string; value?: string };
        return /directories-visited/.test(event.key ?? "") ? Number(event.value) : 0;
      })
      .reduce((total, count) => total + count, 0);
    return { inputs, visited, directories };
  };
  const shallow = await run();
  assert.deepStrictEqual(shallow.inputs, ["build/normal.d.ts"]);
  assert.deepStrictEqual(shallow.visited, ["build"]);
  assert.isAbove(shallow.directories, 0);
  // Descending into node_modules is what froze Windows: the dependency tree
  // grows by four levels and neither the readdir list nor the git count may.
  project.write("build/node_modules/pkg/deep/deeper/deepest/more/most/ignored.js");
  const deep = await run();
  assert.deepStrictEqual(deep.inputs, shallow.inputs);
  assert.deepStrictEqual(deep.visited, shallow.visited);
  assert.strictEqual(deep.directories, shallow.directories);
  assert.isFalse(shallow.visited.some((entry) => entry.includes("node_modules")));
});

function launcherFixture() {
  const root = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3 checks & (fixture) ")),
  );
  const write = (file: string, content: string) => {
    const path = NodePath.join(root, file);
    NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
    NodeFS.writeFileSync(path, content);
  };
  for (const file of [
    "scripts/check-changed.ts",
    "scripts/check-changed-command.ts",
    ".github/scripts/ci-changes.cjs",
  ]) {
    write(file, NodeFS.readFileSync(NodePath.join(import.meta.dirname, "..", file), "utf8"));
  }
  write(".gitignore", "node_modules/\nrecords/\n");
  write("pnpm-workspace.yaml", "packages:\n  - packages/*\n");
  write(
    "package.json",
    JSON.stringify({
      type: "module",
      scripts: {
        "knip:check:files": "knip --include files",
        "knip:check:exports": "knip --exports",
      },
    }),
  );
  write("packages/example/package.json", JSON.stringify({ name: "example" }));
  const source = "packages/example/space & (draft) %PATH% ! 研究.ts";
  write(source, "export const value = 1;\n");
  write(
    "node_modules/vite-plus/package.json",
    JSON.stringify({ type: "module", exports: { "./bin": "./cli.js" } }),
  );
  write(
    "node_modules/vite-plus/cli.js",
    `
    import fs from 'node:fs';
    import path from 'node:path';
    const args = process.argv.slice(2);
    fs.writeFileSync(path.join(process.env.RECORDS, process.pid + '.json'), JSON.stringify({ args, cwd: process.cwd() }));
    console.log('fixture stdout: ' + args[0]);
    console.error('fixture stderr: ' + args[0]);
    process.exit(args[0] === process.env.FAIL_STEP ? 23 : 0);
  `,
  );
  // Select the Windows launcher without changing the Effect runtime's host platform.
  write(
    "scripts/check-changed.ts",
    NodeFS.readFileSync(NodePath.join(import.meta.dirname, "check-changed.ts"), "utf8").replace(
      "vitePlusCommand(args, platform)",
      'vitePlusCommand(args, "win32")',
    ),
  );
  for (const name of ["effect", "@effect/platform-node", "@t3tools/shared"]) {
    const dest = NodePath.join(root, "node_modules", name);
    NodeFS.mkdirSync(NodePath.dirname(dest), { recursive: true });
    NodeFS.symlinkSync(
      NodeFS.realpathSync(NodePath.join(import.meta.dirname, "node_modules", name)),
      dest,
      "junction",
    );
  }
  const git = (...args: Array<string>) =>
    NodeChildProcess.execFileSync("git", args, { cwd: root, stdio: "pipe", env });
  git("init");
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "-c",
    "core.hooksPath=",
    "commit",
    "-m",
    "fixture",
  );
  const records = NodePath.join(root, "records");
  NodeFS.mkdirSync(records);
  return {
    root,
    source,
    write,
    run(failStep = "") {
      return NodeChildProcess.spawnSync(process.execPath, ["scripts/check-changed.ts", "HEAD"], {
        cwd: root,
        encoding: "utf8",
        env: { ...env, TEMP: NodeOS.tmpdir(), RECORDS: records, FAIL_STEP: failStep },
      });
    },
    calls: (): Array<{ args: Array<string>; cwd: string }> =>
      NodeFS.readdirSync(records).map((file) =>
        JSON.parse(NodeFS.readFileSync(NodePath.join(records, file), "utf8")),
      ),
    [Symbol.dispose]() {
      NodeFS.rmSync(root, { recursive: true, force: true });
    },
  };
}

it("checks changed source paths through the Windows launcher", () => {
  using project = launcherFixture();
  project.write(project.source, "export const value = 2;\n");
  const result = project.run();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  const calls = project.calls();
  expect(calls.find(({ args }) => args[0] === "lint")).toEqual({
    args: ["lint", "--no-error-on-unmatched-pattern", project.source],
    cwd: project.root,
  });
  expect(calls.some(({ args }) => args[0] === "fmt" && args.includes(project.source))).toBe(true);
  expect(calls.some(({ args }) => args[0] === "run" && args.includes("typecheck"))).toBe(true);
  expect(calls.some(({ args }) => args[0] === "install")).toBe(false);
  expect(result.stdout).toContain("fixture stdout: lint");
  expect(result.stdout).toContain("fixture stderr: lint");
});

it("lints an Astro component and runs knip when only it changed", () => {
  using project = launcherFixture();
  const page = "packages/example/Page.astro";
  project.write(page, "---\nconst title = 1;\n---\n<h1>{title}</h1>\n");
  const result = project.run();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  const calls = project.calls();
  expect(calls.find(({ args }) => args[0] === "lint")?.args).toEqual([
    "lint",
    "--no-error-on-unmatched-pattern",
    page,
  ]);
  const commands = calls.map(({ args }) => args);
  expect(commands).toContainEqual(["exec", "knip", "--include", "files"]);
  expect(commands).toContainEqual(["exec", "knip", "--exports"]);
});

it.each(["install", "lint"])("reports a failing %s step with its output", (step) => {
  using project = launcherFixture();
  project.write(project.source, "export const value = 2;\n");
  project.write(
    "packages/example/package.json",
    JSON.stringify({ name: "example", version: "1.0.1" }),
  );
  const result = project.run(step);
  expect(result.status, result.stdout + result.stderr).toBe(1);
  const install = project.calls().find(({ args }) => args[0] === "install");
  expect(install?.args, result.stdout + result.stderr).toEqual([
    "install",
    "--lockfile-only",
    "--ignore-scripts",
  ]);
  expect(install?.cwd).not.toBe(project.root);
  expect(result.stdout + result.stderr).toContain(`fixture stdout: ${step}`);
  expect(result.stdout + result.stderr).toContain(`fixture stderr: ${step}`);
  expect(result.stdout).toContain(step === "install" ? "FAIL  unused patches" : "FAIL  lint");
  if (step === "lint") expect(result.stdout).toContain("pass  unused patches");
  expect(
    NodeFS.existsSync(NodePath.join(project.root, "node_modules/.cache/check-changed.json")),
  ).toBe(false);
});

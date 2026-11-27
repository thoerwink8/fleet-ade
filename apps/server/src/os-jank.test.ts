// @effect-diagnostics nodeBuiltinImport:off - fixtures build real worktree and repo layouts on disk.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { CommandAvailability, WindowsShellEnvironment } from "@t3tools/shared/shell";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Observe the existing synchronous shell probe without launching the user's login shell.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, it, vi } from "vite-plus/test";

import { fixPath, hydratePosixHome, refreshWindowsPath, resolveBaseDir } from "./os-jank.ts";

vi.mock("node:child_process", { spy: true });

it("hydrates HOME independently of a blank process HOME", () => {
  const originalHome = process.env.HOME;
  const env: NodeJS.ProcessEnv = { HOME: " " };

  try {
    process.env.HOME = " ";
    hydratePosixHome(env);
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  }

  assert.equal(env.HOME, NodeOS.userInfo().homedir);
});

it("preserves an explicitly configured HOME", () => {
  const env: NodeJS.ProcessEnv = { HOME: "/custom/home" };

  hydratePosixHome(env, () => {
    throw new Error("HOME lookup should not run");
  });

  assert.equal(env.HOME, "/custom/home");
});

effectIt.effect("hydrates PATH when the desktop handoff is absent", () =>
  Effect.acquireUseRelease(
    Effect.sync(() =>
      vi
        .spyOn(NodeChildProcess, "execFileSync")
        .mockReturnValue("__T3CODE_ENV_PATH_START__\n/opt/tools/bin\n__T3CODE_ENV_PATH_END__\n"),
    ),
    (probe) =>
      Effect.gen(function* () {
        const env: NodeJS.ProcessEnv = { SHELL: "/bin/bash", PATH: "/usr/bin" };

        yield* fixPath().pipe(
          Effect.provideService(HostProcess.Platform, "linux"),
          Effect.provideService(HostProcess.Environment, env),
          Effect.provide(NodeServices.layer),
        );

        assert.equal(probe.mock.calls.length, 1);
        assert.equal(env.PATH, "/opt/tools/bin:/usr/bin");
      }),
    (probe) => Effect.sync(() => probe.mockRestore()),
  ),
);

const timedOut = (file: string) =>
  Object.assign(new Error(`spawnSync ${file} ETIMEDOUT`), { code: "ETIMEDOUT" });

effectIt.effect("waits longer for a login shell that times out at startup", () =>
  Effect.acquireUseRelease(
    Effect.sync(() =>
      vi.spyOn(NodeChildProcess, "execFileSync").mockImplementation((file, _args, options) => {
        // This profile takes 8 seconds while the machine is under load.
        if ((options?.timeout ?? 0) < 8_000) throw timedOut(String(file));
        return "__T3CODE_ENV_PATH_START__\n/opt/tools/bin\n__T3CODE_ENV_PATH_END__\n";
      }),
    ),
    () =>
      Effect.gen(function* () {
        const env: NodeJS.ProcessEnv = { SHELL: "/bin/zsh", PATH: "/usr/bin" };

        yield* fixPath().pipe(
          Effect.provideService(HostProcess.Platform, "linux"),
          Effect.provideService(HostProcess.Environment, env),
          Effect.provide(NodeServices.layer),
        );

        assert.equal(env.PATH, "/opt/tools/bin:/usr/bin");
      }),
    (probe) => Effect.sync(() => probe.mockRestore()),
  ),
);

effectIt.effect("waits longer for only one hung login shell", () =>
  Effect.acquireUseRelease(
    Effect.sync(() =>
      vi.spyOn(NodeChildProcess, "execFileSync").mockImplementation((file) => {
        throw timedOut(String(file));
      }),
    ),
    (probe) =>
      Effect.gen(function* () {
        const env: NodeJS.ProcessEnv = { SHELL: "/bin/zsh", PATH: "/usr/bin" };

        yield* fixPath().pipe(
          Effect.provideService(HostProcess.Platform, "linux"),
          Effect.provideService(HostProcess.Environment, env),
          Effect.provide(NodeServices.layer),
        );

        const timeouts = probe.mock.calls.map(([, , options]) => options?.timeout);
        assert.equal(timeouts.filter((timeout) => (timeout ?? 0) > 5_000).length, 1);
        assert.equal(env.PATH, "/usr/bin");
      }),
    (probe) => Effect.sync(() => probe.mockRestore()),
  ),
);

effectIt.effect("keeps mise's PATH record with the login shell PATH", () =>
  Effect.acquireUseRelease(
    Effect.sync(() =>
      vi
        .spyOn(NodeChildProcess, "execFileSync")
        .mockReturnValue(
          [
            "__T3CODE_ENV_PATH_START__",
            "/home/me/.local/bin:/mise/installs/claude/latest:/mise/shims",
            "__T3CODE_ENV_PATH_END__",
            "__T3CODE_ENV___MISE_DIFF_START__",
            "mise-diff",
            "__T3CODE_ENV___MISE_DIFF_END__",
          ].join("\n"),
        ),
    ),
    () =>
      Effect.gen(function* () {
        const env: NodeJS.ProcessEnv = { SHELL: "/bin/bash", PATH: "/usr/bin" };

        yield* fixPath().pipe(
          Effect.provideService(HostProcess.Platform, "linux"),
          Effect.provideService(HostProcess.Environment, env),
          Effect.provide(NodeServices.layer),
        );

        assert.equal(env.__MISE_DIFF, "mise-diff");
      }),
    (probe) => Effect.sync(() => probe.mockRestore()),
  ),
);

effectIt.effect("hydrates a missing JAVA_HOME from the login shell and keeps an explicit one", () =>
  Effect.acquireUseRelease(
    Effect.sync(() =>
      vi
        .spyOn(NodeChildProcess, "execFileSync")
        .mockReturnValue(
          [
            "__T3CODE_ENV_PATH_START__",
            "/opt/homebrew/bin",
            "__T3CODE_ENV_PATH_END__",
            "__T3CODE_ENV_JAVA_HOME_START__",
            "/opt/homebrew/opt/openjdk@17",
            "__T3CODE_ENV_JAVA_HOME_END__",
          ].join("\n"),
        ),
    ),
    () =>
      Effect.gen(function* () {
        const missing: NodeJS.ProcessEnv = { SHELL: "/bin/zsh", PATH: "/usr/bin" };
        const explicit: NodeJS.ProcessEnv = {
          SHELL: "/bin/zsh",
          PATH: "/usr/bin",
          JAVA_HOME: "/custom/jdk",
        };

        for (const env of [missing, explicit]) {
          yield* fixPath().pipe(
            Effect.provideService(HostProcess.Platform, "darwin"),
            Effect.provideService(HostProcess.Environment, env),
            Effect.provide(NodeServices.layer),
          );
        }

        assert.equal(missing.JAVA_HOME, "/opt/homebrew/opt/openjdk@17");
        assert.equal(explicit.JAVA_HOME, "/custom/jdk");
      }),
    (probe) => Effect.sync(() => probe.mockRestore()),
  ),
);

effectIt.effect("adds a directory an installer wrote to the registry after launch", () =>
  Effect.gen(function* () {
    const env: NodeJS.ProcessEnv = { Path: "C:\\Tools;C:\\Windows" };
    const installed = "C:\\Users\\me\\AppData\\Local\\cursor-agent";

    yield* refreshWindowsPath().pipe(
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provideService(HostProcess.Environment, env),
      Effect.provideService(WindowsShellEnvironment, () =>
        Effect.succeed({ PATH: `C:\\Windows;${installed}` }),
      ),
    );

    assert.deepEqual(env, { PATH: `C:\\Tools;C:\\Windows;${installed}` });
  }),
);

effectIt.effect("leaves a current Windows PATH alone and skips the probe off Windows", () =>
  Effect.gen(function* () {
    const env: NodeJS.ProcessEnv = { PATH: "C:\\Tools;C:\\Windows" };
    let probes = 0;

    const unchanged = yield* refreshWindowsPath().pipe(
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provideService(HostProcess.Environment, env),
      Effect.provideService(WindowsShellEnvironment, () =>
        Effect.sync(() => {
          probes += 1;
          return { PATH: "C:\\Tools;C:\\Windows" };
        }),
      ),
    );
    const skipped = yield* refreshWindowsPath().pipe(
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HostProcess.Environment, env),
      Effect.provideService(WindowsShellEnvironment, () =>
        Effect.sync(() => {
          probes += 1;
          return {};
        }),
      ),
    );

    assert.strictEqual(unchanged, false);
    assert.strictEqual(skipped, false);
    assert.strictEqual(probes, 1);
    assert.deepEqual(env, { PATH: "C:\\Tools;C:\\Windows" });
  }),
);

effectIt.effect("replaces a Path-spelled Windows PATH instead of adding a second key", () =>
  Effect.gen(function* () {
    const env: NodeJS.ProcessEnv = { Path: "C:\\Windows" };

    yield* fixPath().pipe(
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provideService(HostProcess.Environment, env),
      Effect.provideService(WindowsShellEnvironment, () => Effect.succeed({ PATH: "C:\\Tools" })),
      Effect.provideService(CommandAvailability, () => Effect.succeed(true)),
      Effect.provide(NodeServices.layer),
    );

    assert.deepEqual(env, { PATH: "C:\\Tools;C:\\Windows" });
  }),
);

// regression: a CLI run from a linked worktree without --base-dir resolved to the
// developer's live ~/.t3 and migrated it with the checkout's unreleased schema.
interface BaseDirCaseRoots {
  readonly home: string;
  readonly worktree: string;
  readonly shared: string;
  readonly explicit: string;
}

const baseDirCases: ReadonlyArray<{
  readonly name: string;
  readonly worktree: boolean;
  readonly explicit: string | undefined;
  readonly env: Record<string, string>;
  readonly expected: (roots: BaseDirCaseRoots) => string;
}> = [
  {
    name: "a linked worktree without --base-dir or T3CODE_HOME uses the worktree's .t3",
    worktree: true,
    explicit: undefined,
    env: {},
    expected: (c) => NodePath.join(c.worktree, ".t3"),
  },
  {
    name: "a linked worktree ignores T3CODE_HOME",
    worktree: true,
    explicit: undefined,
    env: { T3CODE_HOME: "<shared>" },
    expected: (c) => NodePath.join(c.worktree, ".t3"),
  },
  {
    name: "--base-dir wins inside a linked worktree",
    worktree: true,
    explicit: "<explicit>",
    env: { T3CODE_HOME: "<shared>" },
    expected: (c) => c.explicit,
  },
  {
    name: "an explicit T3CODE_HOME (dev runner --home-dir) wins inside a linked worktree",
    worktree: true,
    explicit: undefined,
    env: { T3CODE_HOME: "<shared>", T3CODE_HOME_EXPLICIT: "1" },
    expected: (c) => c.shared,
  },
  {
    name: "outside a worktree the default is ~/.t3",
    worktree: false,
    explicit: undefined,
    env: {},
    expected: (c) => NodePath.join(c.home, ".t3"),
  },
  {
    name: "outside a worktree T3CODE_HOME applies",
    worktree: false,
    explicit: undefined,
    env: { T3CODE_HOME: "<shared>" },
    expected: (c) => c.shared,
  },
  {
    name: "outside a worktree --base-dir wins over T3CODE_HOME",
    worktree: false,
    explicit: "<explicit>",
    env: { T3CODE_HOME: "<shared>" },
    expected: (c) => c.explicit,
  },
];

for (const testCase of baseDirCases) {
  effectIt.effect(`resolveBaseDir: ${testCase.name}`, () =>
    Effect.gen(function* () {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-base-dir-test-"));
      const roots: BaseDirCaseRoots = {
        home: NodePath.join(root, "home"),
        worktree: NodePath.join(root, "worktree"),
        shared: NodePath.join(root, "shared"),
        explicit: NodePath.join(root, "explicit"),
      };
      NodeFS.mkdirSync(roots.worktree);
      // A plain repo has a .git directory; only a linked worktree has a .git file.
      if (testCase.worktree) {
        NodeFS.writeFileSync(
          NodePath.join(roots.worktree, ".git"),
          `gitdir: ${NodePath.join(root, "repo", ".git", "worktrees", "worktree")}\n`,
        );
      } else {
        NodeFS.mkdirSync(NodePath.join(roots.worktree, ".git"));
      }
      const substitute = (value: string) =>
        value.replace("<shared>", roots.shared).replace("<explicit>", roots.explicit);
      const env = Object.fromEntries(
        Object.entries(testCase.env).map(([key, value]) => [key, substitute(value)]),
      );

      const baseDir = yield* resolveBaseDir(
        testCase.explicit === undefined ? undefined : substitute(testCase.explicit),
      ).pipe(
        Effect.provideService(HostProcess.WorkingDirectory, roots.worktree),
        Effect.provideService(HostProcess.HomeDirectory, roots.home),
        Effect.provide(
          Layer.mergeAll(ConfigProvider.layer(ConfigProvider.fromEnv({ env })), NodeServices.layer),
        ),
      );

      assert.equal(baseDir, testCase.expected(roots));
    }),
  );
}

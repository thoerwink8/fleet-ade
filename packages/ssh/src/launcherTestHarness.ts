// @effect-diagnostics nodeBuiltinImport:off - Executes the generated remote launcher in an isolated shell with fake commands and clock.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";
import { launchOrReuseRemoteServer, type RemoteT3RunnerOptions } from "./tunnel.ts";

// Capture exactly the script sent over SSH, then run it with fake remote commands.
const captureLauncherFor = Effect.fn("test.captureLauncher")(function* (
  runner: RemoteT3RunnerOptions,
) {
  let script = "";
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (command._tag === "StandardCommand") {
        const stdin = command.options.stdin;
        if (typeof stdin === "object" && "stream" in stdin && Stream.isStream(stdin.stream)) {
          script = yield* stdin.stream.pipe(Stream.decodeText(), Stream.mkString);
        }
      }
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(123),
        stdout: Stream.make(new TextEncoder().encode('{"remotePort":3773}\n')),
        stderr: Stream.empty,
        all: Stream.empty,
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      });
    }),
  );
  yield* launchOrReuseRemoteServer(
    { alias: "test", hostname: "test.invalid", username: null, port: null },
    undefined,
    runner,
  ).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
      ),
    ),
  );
  return script;
});

export const captureLauncher = captureLauncherFor({ nodeScriptPath: "/fake/server.ts" });

export function runLauncher(
  script: string,
  options: { readonly recordedKind?: "managed" | "external" },
) {
  const root = NodeURL.fileURLToPath(new URL("../../../", import.meta.url));
  const home = NodeFS.mkdtempSync(NodePath.join(root, "packages/ssh/.ssh-launcher-test-"));
  try {
    const bin = NodePath.join(home, "bin");
    const runtime = NodePath.join(home, ".t3/runtime");
    NodeFS.mkdirSync(bin);
    NodeFS.mkdirSync(runtime, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(home, "clock"), "0");
    NodeFS.writeFileSync(NodePath.join(home, "events"), "");
    const executable = (name: string, body: string) =>
      NodeFS.writeFileSync(NodePath.join(bin, name), `#!/bin/sh\nset -eu\n${body}\n`, {
        mode: 0o755,
      });
    NodeFS.writeFileSync(
      NodePath.join(home, "clock.cjs"),
      `
const fs = require('node:fs');
Date.now = () => Number(fs.readFileSync(process.env.HOME + '/clock', 'utf8'));
`,
    );
    executable(
      "node",
      `
case "\${2:-}" in
  */server-runtime.json)
    # A started server publishes its runtime record, which the launch waits for.
    # The fake nohup runs in the background, so wait for it instead of racing it.
    if [ -e "$HOME/picked-port" ]; then
      while [ ! -e "$HOME/started-server" ]; do /bin/sleep 0.01; done
    fi
    if [ -e "$HOME/started-server" ]; then
      printf 'record %s\\n' "$(cat "$HOME/clock")" >> "$HOME/events"
      printf '%s 5999' "$(cat "$HOME/started-server")"
      exit 0
    fi
    printf 'runtime %s\\n' "$(cat "$HOME/clock")" >> "$HOME/events"
    exit 1 ;;
  */port)
    printf 'start %s\\n' "$(cat "$HOME/clock")" >> "$HOME/events"
    touch "$HOME/picked-port"
    printf 5999 ;;
  [0-9]*)
    NOW="$(cat "$HOME/clock")"
    printf 'probe %s %s\\n' "$2" "$NOW" >> "$HOME/events"
    [ "$2" = 5999 ] ;;
  *) exec "$TEST_REAL_NODE" --require "$HOME/clock.cjs" "$@" ;;
esac`,
    );
    executable(
      "sleep",
      `awk -v seconds="$1" '{ printf "%.0f", $1 + seconds * 1000 }' "$HOME/clock" > "$HOME/clock.next"
mv "$HOME/clock.next" "$HOME/clock"`,
    );
    executable("nohup", 'printf "%s" "$$" > "$HOME/started-server"');
    // The test process stands in for a recorded server; report the serve command it would run.
    executable(
      "ps",
      `if [ "$*" = "-ww -o args= -p $TEST_SERVER_PID" ]; then
  printf '/bin/sh %s/.t3/ssh-launch/test-target/run-t3.sh serve --host 127.0.0.1 --port 5999\\n' "$HOME"
  exit 0
fi
PATH=/usr/bin:/bin exec ps "$@"`,
    );
    if (options.recordedKind) {
      const state = NodePath.join(home, ".t3/ssh-launch/test-target");
      NodeFS.mkdirSync(state, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(state, "pid"), String(process.pid));
      NodeFS.writeFileSync(NodePath.join(state, "port"), "5999");
      NodeFS.writeFileSync(NodePath.join(state, "managed"), options.recordedKind);
      const runner = script.split("cat >\"$RUNNER_NEXT\" <<'SH'\n")[1]?.split("\nSH\n")[0];
      if (!runner) throw new Error("runner missing");
      NodeFS.writeFileSync(NodePath.join(state, "run-t3.sh"), runner + "\n");
    }
    const result = NodeChildProcess.spawnSync("/bin/sh", ["-s", "--", "test-target"], {
      input: `kill() {
  if [ "$1" = -0 ]; then command kill "$@"; else
    printf 'kill %s\\n' "$*" >> "$HOME/events"
    return 1
  fi
}
${script}`,
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        HOME: home,
        PATH: `${bin}:/usr/bin:/bin`,
        TEST_REAL_NODE: process.execPath,
        TEST_SERVER_PID: String(process.pid),
      },
    });
    if (result.error || result.status !== 0)
      throw new Error(
        `launcher failed: ${result.error ?? result.status}\n${result.stderr}\n${result.stdout}\n${NodeFS.readFileSync(NodePath.join(home, "events"), "utf8")}`,
      );
    return {
      output: JSON.parse(result.stdout.trim()),
      events: NodeFS.readFileSync(NodePath.join(home, "events"), "utf8").trim().split("\n"),
      now: Number(NodeFS.readFileSync(NodePath.join(home, "clock"), "utf8")),
    };
  } finally {
    NodeFS.rmSync(home, { recursive: true, force: true });
  }
}

import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import * as Redacted from "effect/Redacted";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Command } from "effect/process/ChildProcess";
import {
  ChildProcessSpawner,
  make as makeChildProcessSpawner,
} from "effect/process/ChildProcessSpawner";
import { applyAgentNetworkEnvironment } from "@t3tools/provider-core/server/networkEnvironment";

import { currentNetworkSnapshot } from "./snapshot.ts";

function wordText(word: string | Redacted.Redacted<string>): string {
  return Redacted.isRedacted(word) ? Redacted.value(word) : word;
}

function materializeEnv(
  env: Record<string, string | Redacted.Redacted<string> | undefined> | undefined,
  extendEnv: boolean | undefined,
): Record<string, string | undefined> {
  const inherit = env === undefined || extendEnv === true;
  const base: Record<string, string | undefined> = inherit ? { ...process.env } : {};
  if (env) {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) {
        delete base[key];
        continue;
      }
      base[key] = Redacted.isRedacted(value) ? Redacted.value(value) : value;
    }
  }
  return base;
}

function rewriteCommand(command: Command): void {
  if (command._tag === "PipedCommand") {
    rewriteCommand(command.left);
    rewriteCommand(command.right);
    return;
  }
  const snapshot = currentNetworkSnapshot();
  const env = applyAgentNetworkEnvironment({
    hostEnv: materializeEnv(command.options.env, command.options.extendEnv),
    settings: snapshot.settings,
    systemProxy: snapshot.system,
    target: {
      command: command.command,
      args: command.args.map(wordText),
    },
    agents: snapshot.agents,
  });
  (command as { options: Command["options"] }).options = {
    ...command.options,
    env,
    extendEnv: false,
  };
}

const layerNodeSpawner = NodeChildProcessSpawner.layer.pipe(
  Layer.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
);

// Spawn reads command.options when it runs. Rewriting here covers adapters that
// copied the host environment earlier, and it drops a parent proxy Node would inherit.
export const layer = Layer.effect(
  ChildProcessSpawner,
  Effect.gen(function* () {
    const inner = yield* ChildProcessSpawner;
    return makeChildProcessSpawner((command) => {
      rewriteCommand(command);
      return inner.spawn(command);
    });
  }),
).pipe(Layer.provide(layerNodeSpawner));

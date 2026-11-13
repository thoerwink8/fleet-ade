// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeFS from "node:fs";

import * as HostProcess from "@t3tools/shared/HostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** Node 20.12+ cannot spawn Windows launcher scripts without a shell; the SDK cannot use these as executables. */
const WINDOWS_SHIM_EXTENSIONS: ReadonlySet<string> = new Set([".cmd", ".bat", ".ps1"]);

export const CLAUDE_RECLAUDE_MISSING_MESSAGE =
  "未找到 reclaude，Claude 渠道未启用。请先安装 reclaude，或在设置里填写它的完整路径。";

export class ClaudeReclaudeNotFound extends Schema.TaggedError<ClaudeReclaudeNotFound>()(
  "ClaudeReclaudeNotFound",
  {},
) {
  override get message(): string {
    return CLAUDE_RECLAUDE_MISSING_MESSAGE;
  }
}

export const isClaudeReclaudeNotFound = Schema.is(ClaudeReclaudeNotFound);

const isWindowsClaudeLauncherShimPath = (filePath: string): boolean =>
  WINDOWS_SHIM_EXTENSIONS.has(NodePath.win32.extname(filePath).toLowerCase());

export type ExecutableFileCheck = (filePath: string) => boolean;

function isExistingFile(filePath: string): boolean {
  try {
    return NodeFS.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export const ClaudeExecutableFileCheck = Context.Reference<ExecutableFileCheck>(
  "server/provider/Drivers/ClaudeExecutableFileCheck",
  {
    defaultValue: () => isExistingFile,
  },
);

function commandStem(filePath: string): string {
  const trimmed = filePath.trim().replace(/^"(.*)"$/, "$1");
  const base = trimmed.split(/[\\/]/).pop() ?? trimmed;
  return base.replace(/\.(?:exe|cmd|bat|ps1)$/i, "").toLowerCase();
}

function isExplicitPath(filePath: string): boolean {
  return filePath.includes("/") || filePath.includes("\\") || /^[a-zA-Z]:/.test(filePath);
}

/** Locations an installer uses. Never a single machine's home. */
function reclaudeSearchCandidates(platform: NodeJS.Platform, home: string): ReadonlyArray<string> {
  if (platform === "win32") {
    const join = NodePath.win32.join;
    return [
      join(home, ".local", "bin", "reclaude.exe"),
      join(home, ".local", "bin", "reclaude.cmd"),
    ];
  }
  const join = NodePath.posix.join;
  return [
    join(home, ".local", "bin", "reclaude"),
    "/opt/homebrew/bin/reclaude",
    "/usr/local/bin/reclaude",
  ];
}

/**
 * The Claude channel only starts reclaude. A bare `claude`, `claude.exe`, or a stored default
 * of `claude` is looked up as reclaude. A Windows shim is never followed into `claude.exe`.
 */
export const resolveClaudeSdkExecutablePath = Effect.fn("resolveClaudeSdkExecutablePath")(
  function* (
    binaryPath: string,
    environment: NodeJS.ProcessEnv,
  ): Effect.fn.Return<string, ClaudeReclaudeNotFound> {
    const platform = yield* HostProcess.Platform;
    const home = yield* HostProcess.HomeDirectory;
    const resolveExecutable = yield* SpawnExecutableResolution;
    const isFile = yield* ClaudeExecutableFileCheck;

    const accept = (candidate: string | undefined): string | undefined => {
      if (!candidate || commandStem(candidate) !== "reclaude") return undefined;
      if (platform === "win32" && isWindowsClaudeLauncherShimPath(candidate)) {
        const exe = NodePath.win32.join(NodePath.win32.dirname(candidate), "reclaude.exe");
        return isFile(exe) ? exe : undefined;
      }
      return isFile(candidate) ? candidate : undefined;
    };

    const configured = binaryPath.trim();
    if (commandStem(configured) === "reclaude" && isExplicitPath(configured)) {
      const explicit = accept(configured);
      if (explicit) return explicit;
      return yield* new ClaudeReclaudeNotFound();
    }

    const fromPath = accept(resolveExecutable("reclaude", platform, environment));
    if (fromPath) return fromPath;
    for (const candidate of reclaudeSearchCandidates(platform, home)) {
      const found = accept(candidate);
      if (found) return found;
    }
    return yield* new ClaudeReclaudeNotFound();
  },
);

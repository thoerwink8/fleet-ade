import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import {
  CLAUDE_RECLAUDE_MISSING_MESSAGE,
  ClaudeExecutableFileCheck,
  ClaudeReclaudeNotFound,
  resolveClaudeSdkExecutablePath,
} from "./ClaudeExecutable.ts";

const HOME = "C:\\Users\\someone";
const RECLAUDE_EXE = `${HOME}\\.local\\bin\\reclaude.exe`;
const RECLAUDE_CMD = `${HOME}\\.local\\bin\\reclaude.cmd`;
const CLAUDE_EXE =
  "C:\\Users\\someone\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe";

function withResolution(input: {
  readonly platform: NodeJS.Platform;
  readonly home?: string;
  readonly resolve?: (command: string) => string | undefined;
  readonly existingFiles?: ReadonlyArray<string>;
}) {
  const existing = new Set(input.existingFiles ?? []);
  return <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(HostProcess.Platform, input.platform),
      Effect.provideService(HostProcess.HomeDirectory, input.home ?? HOME),
      Effect.provideService(SpawnExecutableResolution, (command) => input.resolve?.(command)),
      Effect.provideService(ClaudeExecutableFileCheck, (filePath) => existing.has(filePath)),
    );
}

describe("resolveClaudeSdkExecutablePath", () => {
  it.effect("resolves the default claude name to reclaude on PATH", () =>
    Effect.gen(function* () {
      expect(
        yield* resolveClaudeSdkExecutablePath("claude", {}).pipe(
          withResolution({
            platform: "win32",
            resolve: (command) => (command === "reclaude" ? RECLAUDE_EXE : CLAUDE_EXE),
            existingFiles: [RECLAUDE_EXE, CLAUDE_EXE],
          }),
        ),
      ).toBe(RECLAUDE_EXE);
    }),
  );

  it.effect("uses the per-user install when PATH has no reclaude", () =>
    Effect.gen(function* () {
      for (const platform of ["win32", "darwin"] as const) {
        const expected = platform === "win32" ? RECLAUDE_EXE : "/Users/someone/.local/bin/reclaude";
        expect(
          yield* resolveClaudeSdkExecutablePath("claude", {}).pipe(
            withResolution({
              platform,
              home: platform === "win32" ? HOME : "/Users/someone",
              resolve: () => CLAUDE_EXE,
              existingFiles: [expected, CLAUDE_EXE],
            }),
          ),
        ).toBe(expected);
      }
    }),
  );

  it.effect("finds a Homebrew reclaude on Mac", () =>
    Effect.gen(function* () {
      expect(
        yield* resolveClaudeSdkExecutablePath("", {}).pipe(
          withResolution({
            platform: "darwin",
            home: "/Users/someone",
            resolve: () => undefined,
            existingFiles: ["/opt/homebrew/bin/reclaude"],
          }),
        ),
      ).toBe("/opt/homebrew/bin/reclaude");
    }),
  );

  it.effect("keeps an explicit reclaude path", () =>
    Effect.gen(function* () {
      const explicit = "D:\\tools\\reclaude.exe";
      expect(
        yield* resolveClaudeSdkExecutablePath(explicit, {}).pipe(
          withResolution({
            platform: "win32",
            resolve: () => CLAUDE_EXE,
            existingFiles: [explicit, CLAUDE_EXE],
          }),
        ),
      ).toBe(explicit);
    }),
  );

  it.effect("prefers reclaude.exe beside a reclaude shim and ignores claude.exe", () =>
    Effect.gen(function* () {
      expect(
        yield* resolveClaudeSdkExecutablePath("claude", {}).pipe(
          withResolution({
            platform: "win32",
            resolve: (command) => (command === "reclaude" ? RECLAUDE_CMD : CLAUDE_EXE),
            existingFiles: [RECLAUDE_CMD, RECLAUDE_EXE, CLAUDE_EXE],
          }),
        ),
      ).toBe(RECLAUDE_EXE);
    }),
  );

  it.effect("fails closed when reclaude is missing and never returns claude", () =>
    Effect.gen(function* () {
      const exit = yield* resolveClaudeSdkExecutablePath("claude", {}).pipe(
        withResolution({
          platform: "win32",
          resolve: () => CLAUDE_EXE,
          existingFiles: [CLAUDE_EXE],
        }),
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failed = exit.cause;
        const message = String(failed);
        expect(message).toContain("ClaudeReclaudeNotFound");
        expect(message).not.toContain(CLAUDE_EXE);
        expect(message).toContain(CLAUDE_RECLAUDE_MISSING_MESSAGE);
      }
      expect(ClaudeReclaudeNotFound).toBeDefined();
    }),
  );
});

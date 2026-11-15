import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as GitHubRest from "@t3tools/source-control-github/server/GitHubRest";

import { judgeColdVerify, type ColdVerifyModelOutput } from "./coldVerifyVerdict.ts";
import {
  COLD_VERIFY_CONTEXT,
  GitHubCommitStatus,
  layer as commitStatusLayer,
} from "./GitHubCommitStatus.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const OTHER_SHA = "89abcdef0123456789abcdef0123456789abcdef01";

const target = {
  host: "github.com",
  owner: "thoerwink8",
  repo: "fleet-ade",
  sha: SHA,
};

const blocking: ColdVerifyModelOutput = {
  verdict: "fail",
  problems: [{ text: "没做到验收条：第 2 条要求的测试没出现" }],
  suggestions: [{ text: "命名可以再短一点" }],
  handovers: [],
};

interface Seen {
  readonly path: string;
  readonly request: unknown;
  readonly status: number;
}

/** 替换现成 GitHubRest，不发网络。登录仍由它走 GitHubCredentials，这里只看写状态拿到的 sha 和失败怎么回。 */
function restOf(answer: (input: GitHubRest.GitHubRestInput) => Effect.Effect<Seen>) {
  const seen: Array<Seen> = [];
  const rest = Layer.succeed(
    GitHubRest.GitHubRest,
    GitHubRest.GitHubRest.of({
      rest: (input) =>
        Effect.gen(function* () {
          const row = yield* answer(input);
          seen.push(row);
          const request = row.request as { readonly state?: string } | undefined;
          return {
            status: row.status,
            headers: {},
            body: JSON.stringify({
              sha: input.path.split("/").at(-1),
              state: request?.state ?? "failure",
              context: COLD_VERIFY_CONTEXT,
              description: null,
            }),
            truncated: false,
            invalidUtf8: false,
          };
        }),
      credential: () => Effect.die("这个测试不读登录"),
      appCredential: () => Effect.die("这个测试不读登录"),
    }),
  );
  return {
    seen,
    layer: commitStatusLayer.pipe(Layer.provide(rest)),
  };
}

describe("GitHubCommitStatus", () => {
  it.effect("状态只写到调用方给的那个 sha，上下文固定 cold-verify", () =>
    Effect.gen(function* () {
      const outcome = judgeColdVerify(blocking);
      const { layer, seen } = restOf((input) =>
        Effect.succeed({ path: input.path, request: input.body, status: 201 }),
      );

      const written = yield* GitHubCommitStatus.use((status) =>
        status.writeColdVerify(target, outcome),
      ).pipe(Effect.provide(layer));

      expect(written).toEqual({
        kind: "written",
        sha: SHA,
        state: "failure",
        description: "验收没过：没做到验收条：第 2 条要求的测试没出现",
      });
      expect(seen).toEqual([
        {
          path: `repos/thoerwink8/fleet-ade/statuses/${SHA}`,
          request: {
            state: "failure",
            context: COLD_VERIFY_CONTEXT,
            description: "验收没过：没做到验收条：第 2 条要求的测试没出现",
          },
          status: 201,
        },
      ]);
      expect(seen[0]?.path).not.toContain(OTHER_SHA);
    }),
  );

  it.effect("写状态的 HTTP 失败留下未写上，不改已经算出的裁决，也不变成已通过", () =>
    Effect.gen(function* () {
      const outcome = judgeColdVerify(blocking);
      expect(outcome.kind).toBe("block");
      const { layer } = restOf(() => Effect.succeed({ path: "", request: undefined, status: 500 }));

      const error = yield* GitHubCommitStatus.use((status) =>
        status.writeColdVerify(target, outcome),
      ).pipe(Effect.provide(layer), Effect.flip);

      expect(outcome.kind).toBe("block");
      expect(error._tag).toBe("CommitStatusWriteError");
      expect(error.sha).toBe(SHA);
      expect(error.reason).toBe("GitHub 回了 HTTP 500");
      expect(error.reason).not.toMatch(/已通过|已验|success/);
    }),
  );
});

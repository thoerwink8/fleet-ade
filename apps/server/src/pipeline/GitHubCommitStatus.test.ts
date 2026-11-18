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
  /** 回包可覆盖，用来造回执对不上的情形。 */
  readonly receipt?: { readonly url?: string };
}

/**
 * GitHub「创建提交状态」的真实回包：sha 只在 url 末段（…/statuses/<sha>），没有 sha 字段。
 * 夹具照这个写，按不存在的字段核对会在这里红。
 */
function receiptOf(input: GitHubRest.GitHubRestInput, row: Seen): string {
  const request = row.request as
    | { readonly state?: string; readonly description?: string }
    | undefined;
  return JSON.stringify({
    url: row.receipt?.url ?? `https://api.github.com/${input.path}`,
    avatar_url: "https://avatars.githubusercontent.com/in/1?v=4",
    id: 18764329190,
    node_id: "SC_kwDOJ1mq2M8AAAAEPi9aJg",
    state: request?.state ?? "failure",
    description: request?.description ?? null,
    target_url: null,
    context: COLD_VERIFY_CONTEXT,
    created_at: "2026-11-18T03:12:41Z",
    updated_at: "2026-11-18T03:12:41Z",
    creator: {
      login: "fleet-ade[bot]",
      id: 1234567,
      node_id: "BOT_kgDOBAkADw",
      type: "Bot",
      site_admin: false,
    },
  });
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
          return {
            status: row.status,
            headers: {},
            body: receiptOf(input, row),
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

  it.effect("回执 url 末段是别的 sha 时判没写上，不拿「回包能解出来」冒充写对了", () =>
    Effect.gen(function* () {
      const outcome = judgeColdVerify(blocking);
      const { layer } = restOf((input) =>
        Effect.succeed({
          path: input.path,
          request: input.body,
          status: 201,
          receipt: {
            url: `https://api.github.com/repos/thoerwink8/fleet-ade/statuses/${OTHER_SHA}`,
          },
        }),
      );

      const error = yield* GitHubCommitStatus.use((status) =>
        status.writeColdVerify(target, outcome),
      ).pipe(Effect.provide(layer), Effect.flip);

      expect(error._tag).toBe("CommitStatusWriteError");
      expect(error.reason).toContain("sha");
      expect(error.reason).not.toMatch(/已通过|已验|success/);
    }),
  );
});

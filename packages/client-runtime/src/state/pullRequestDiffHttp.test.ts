import {
  EnvironmentId,
  ProjectId,
  PullRequestOperationError,
  PullRequestUnavailableError,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { PrimaryConnectionTarget, type PreparedConnection } from "../connection/model.ts";
import * as RpcHttp from "../rpc/http.ts";
import * as PullRequestDiffHttp from "./pullRequestDiffHttp.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-pr-diff"),
  label: "PR Diff",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

const PREPARED: PreparedConnection = {
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  httpBaseUrl: TARGET.httpBaseUrl,
  socketUrl: TARGET.wsBaseUrl,
  httpAuthorization: null,
  target: TARGET,
};

const encodeOperationError = Schema.encodeSync(Schema.toCodecJson(PullRequestOperationError));
const encodeUnavailableError = Schema.encodeSync(Schema.toCodecJson(PullRequestUnavailableError));

const diffInput = {
  projectId: ProjectId.make("project-1"),
  repository: "acme/web",
  number: 42,
} as const;

describe("pullRequestDiffHttp", () => {
  it.effect(
    "preserves rate-limited PullRequestOperationError across HTTP encode and decode",
    () => {
      const wireError = new PullRequestOperationError({
        operation: "diff",
        detail: "github requests to github.com are paused until the rate limit resets.",
        reason: "rate-limited",
        cause: new Error("rate limit exceeded"),
      });
      const fetchFn = ((input: RequestInfo | URL) => {
        expect(String(input)).toContain("/api/pull-requests/diff");
        return Promise.resolve(Response.json(encodeOperationError(wireError), { status: 502 }));
      }) satisfies typeof fetch;

      return Effect.gen(function* () {
        const loader = yield* PullRequestDiffHttp.PullRequestDiffLoader;
        const error = yield* Effect.flip(loader.load(PREPARED, diffInput));
        expect(error._tag).toBe("PullRequestOperationError");
        if (error._tag !== "PullRequestOperationError") return;
        expect(error.operation).toBe("diff");
        expect(error.reason).toBe("rate-limited");
        expect(error.detail).toBe(
          "github requests to github.com are paused until the rate limit resets.",
        );
      }).pipe(
        Effect.provide(
          Layer.provide(PullRequestDiffHttp.layer, RpcHttp.layerRemoteHttpClient(fetchFn)),
        ),
      );
    },
  );

  it.effect("preserves PullRequestUnavailableError across HTTP encode and decode", () => {
    const wireError = new PullRequestUnavailableError({
      reason: "cli-unauthenticated",
      provider: SourceControlProviderKind.make("github"),
      requirement: "Run gh auth login.",
    });
    const fetchFn = (() =>
      Promise.resolve(
        Response.json(encodeUnavailableError(wireError), { status: 503 }),
      )) satisfies typeof fetch;

    return Effect.gen(function* () {
      const loader = yield* PullRequestDiffHttp.PullRequestDiffLoader;
      const error = yield* Effect.flip(loader.load(PREPARED, diffInput));
      expect(error._tag).toBe("PullRequestUnavailableError");
      if (error._tag !== "PullRequestUnavailableError") return;
      expect(error.reason).toBe("cli-unauthenticated");
      expect(error.requirement).toBe("Run gh auth login.");
    }).pipe(
      Effect.provide(
        Layer.provide(PullRequestDiffHttp.layer, RpcHttp.layerRemoteHttpClient(fetchFn)),
      ),
    );
  });
});

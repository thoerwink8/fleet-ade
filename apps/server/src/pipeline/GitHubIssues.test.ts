import { assert, describe, it } from "@effect/vitest";
import * as GitHubAppSignIn from "@t3tools/source-control-github/server/GitHubAppSignIn";
import * as GitHubCredentials from "@t3tools/source-control-github/server/GitHubCredentials";
import * as GitHubQuota from "@t3tools/source-control-github/server/GitHubQuota";
import * as GitHubRequestPolicy from "@t3tools/source-control-github/server/GitHubRequestPolicy";
import * as GitHubRest from "@t3tools/source-control-github/server/GitHubRest";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import { HttpClient, HttpClientResponse } from "effect/http";

import { ELIGIBLE_LABEL, layer, PipelineGitHubIssues, REPOSITORY } from "./GitHubIssues.ts";

interface FixtureIssue {
  readonly number: number;
  readonly title: string;
  readonly body: string | null;
  readonly state: "open" | "closed";
  readonly labels: ReadonlyArray<{ readonly name?: string } | string>;
  readonly pullRequest?: boolean;
}

/** GitHub's issues route returns pull requests too, and ignores nothing the query did not ask for. */
const LISTED: ReadonlyArray<FixtureIssue> = [
  {
    number: 7,
    title: "Eligible",
    body: "## 怎么算做完\n\n- done",
    state: "open",
    labels: [{ name: ELIGIBLE_LABEL }, "other"],
  },
  {
    number: 8,
    title: "Pull request",
    body: "body",
    state: "open",
    labels: [{ name: ELIGIBLE_LABEL }],
    pullRequest: true,
  },
  { number: 9, title: "Unlabeled", body: "body", state: "open", labels: [{ name: "other" }] },
  {
    number: 10,
    title: "Closed",
    body: "body",
    state: "closed",
    labels: [{ name: ELIGIBLE_LABEL }],
  },
  { number: 11, title: "No body", body: null, state: "open", labels: [{ name: ELIGIBLE_LABEL }] },
  { number: 12, title: "Nameless label", body: "body", state: "open", labels: [{}] },
];

const payload = (issue: FixtureIssue) => ({
  number: issue.number,
  title: issue.title,
  body: issue.body,
  state: issue.state,
  labels: issue.labels,
  ...(issue.pullRequest
    ? { pull_request: { url: `https://api.github.com/repos/x/y/pulls/${issue.number}` } }
    : {}),
});

const repositoryPath = `/repos/${REPOSITORY.owner}/${REPOSITORY.name}/issues`;

/** One full page past the 1000-item cap, so the reader must stop instead of trusting a short tail. */
const CAPPED: ReadonlyArray<FixtureIssue> = Array.from({ length: 1001 }, (_, index) => ({
  number: index + 1,
  title: `Issue ${index + 1}`,
  body: "",
  state: "open" as const,
  labels: [{ name: ELIGIBLE_LABEL }],
}));

const carries = (issue: FixtureIssue, label: string) =>
  issue.labels.some((entry) => (typeof entry === "string" ? entry : entry.name) === label);

function harness(options?: {
  readonly signedIn?: boolean;
  readonly status?: number;
  readonly truncated?: boolean;
  readonly capped?: boolean;
  readonly empty?: boolean;
}) {
  const requests: Array<string> = [];
  const signedIn = options?.signedIn ?? true;
  const credentials = Layer.succeed(
    GitHubCredentials.GitHubCredentials,
    GitHubCredentials.GitHubCredentials.of({
      get: () =>
        signedIn
          ? Effect.succeed({
              host: "github.com",
              token: Redacted.make("fixture-token"),
              source: "gh" as const,
              fingerprint: "github.com:fixture",
            })
          : Effect.fail(new GitHubCredentials.GitHubNotSignedInError({ host: "github.com" })),
      saved: () => Effect.succeedNone,
      fingerprint: (host, token) => Effect.succeed(`${host}:${token}`),
      invalidate: () => Effect.void,
    }),
  );
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      requests.push(`${request.method} ${request.url}`);
      const url = new URL(request.url);
      const respond = (response: Response) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, response));
      if (options?.status !== undefined) {
        return respond(
          new Response(JSON.stringify({ message: "nope" }), {
            status: options.status,
            headers: { "content-type": "application/json" },
          }),
        );
      }
      const single = new RegExp(`${repositoryPath}/(\\d+)$`).exec(url.pathname);
      if (single) {
        const issue = LISTED.find((candidate) => candidate.number === Number(single[1]));
        return respond(
          issue === undefined
            ? new Response(JSON.stringify({ message: "missing" }), { status: 404 })
            : new Response(JSON.stringify(payload(issue)), {
                status: 200,
                headers: { "content-type": "application/json" },
              }),
        );
      }
      if (options?.truncated) {
        return respond(new Response("x".repeat(32 * 1024 * 1024 + 1), { status: 200 }));
      }
      const label = url.searchParams.get("labels");
      const openOnly = url.searchParams.get("state") === "open";
      const source = options?.capped ? CAPPED : options?.empty ? [] : LISTED;
      const matched = source.filter(
        (issue) =>
          (!openOnly || issue.state === "open") && (label === null || carries(issue, label)),
      );
      const page = Number(url.searchParams.get("page") ?? "1");
      const size = Number(url.searchParams.get("per_page") ?? "30");
      return respond(
        new Response(JSON.stringify(matched.slice((page - 1) * size, page * size).map(payload)), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }),
  );
  const provided = layer.pipe(
    Layer.provide(GitHubRest.layer),
    Layer.provide(
      Layer.mergeAll(
        credentials,
        http,
        Layer.mock(GitHubAppSignIn.GitHubAppSignIn)({
          enabled: false,
          token: () => Effect.succeedNone,
          invalidate: () => Effect.void,
        }),
      ),
    ),
    Layer.provideMerge(GitHubQuota.layer),
    Layer.provideMerge(SourceControlRateLimit.layer),
  );
  return { layer: provided, requests };
}

const failureTag = (result: Result.Result<unknown, { readonly _tag: string }>) => {
  assert.strictEqual(result._tag, "Failure");
  return result._tag === "Failure" ? result.failure._tag : "";
};

describe("PipelineGitHubIssues", () => {
  it.effect("keeps open labeled issues and drops pull requests, unlabeled, and closed ones", () => {
    const fixture = harness();
    return Effect.gen(function* () {
      const issues = yield* PipelineGitHubIssues;
      const listed = yield* issues.listEligible();
      assert.deepStrictEqual(
        listed.map((issue) => ({
          number: issue.number,
          title: issue.title,
          body: issue.body,
          labels: [...issue.labels],
        })),
        [
          {
            number: 7,
            title: "Eligible",
            body: "## 怎么算做完\n\n- done",
            labels: [ELIGIBLE_LABEL, "other"],
          },
          { number: 11, title: "No body", body: "", labels: [ELIGIBLE_LABEL] },
        ],
      );

      const read = yield* issues.read(7);
      assert.strictEqual(read.title, "Eligible");
      assert.strictEqual(read.body, "## 怎么算做完\n\n- done");

      const pullRequest = yield* Effect.result(issues.read(8));
      assert.strictEqual(failureTag(pullRequest), "GitHubApiNotFoundError");

      const listing = fixture.requests[0] ?? "";
      assert.ok(listing.startsWith(`GET https://api.github.com${repositoryPath}?`));
      assert.ok(listing.includes("state=open"));
      assert.ok(listing.includes(`labels=${encodeURIComponent(ELIGIBLE_LABEL)}`));
      assert.ok(listing.includes("per_page=100"));
    }).pipe(Effect.provide(fixture.layer));
  });

  it.effect("fails when nobody is signed in instead of returning nothing", () =>
    Effect.gen(function* () {
      const issues = yield* PipelineGitHubIssues;
      const listed = yield* Effect.result(issues.listEligible());
      assert.strictEqual(failureTag(listed), "GitHubNotSignedInError");
      const read = yield* Effect.result(issues.read(7));
      assert.strictEqual(failureTag(read), "GitHubNotSignedInError");
    }).pipe(Effect.provide(harness({ signedIn: false }).layer)),
  );

  it.effect("fails on an HTTP error instead of returning nothing", () =>
    Effect.gen(function* () {
      for (const status of [401, 403, 404, 500, 502]) {
        const failing = harness({ status });
        const issues = yield* PipelineGitHubIssues.pipe(Effect.provide(failing.layer));
        const listed = yield* Effect.result(issues.listEligible());
        const read = yield* Effect.result(issues.read(7));
        const expected =
          status === 401
            ? "GitHubApiAuthenticationError"
            : status === 404
              ? "GitHubApiNotFoundError"
              : "GitHubApiResponseError";
        assert.strictEqual(failureTag(listed), expected);
        assert.strictEqual(failureTag(read), expected);
        if (listed._tag === "Failure" && listed.failure._tag === "GitHubApiResponseError") {
          assert.strictEqual(
            (listed.failure as GitHubRequestPolicy.GitHubApiResponseError).status,
            status,
          );
        }
      }
    }),
  );

  it.effect("fails when a page comes back cut off", () =>
    Effect.gen(function* () {
      const issues = yield* PipelineGitHubIssues;
      const listed = yield* Effect.result(issues.listEligible());
      assert.strictEqual(failureTag(listed), "PipelineIssuesIncompleteError");
    }).pipe(Effect.provide(harness({ truncated: true }).layer)),
  );

  it.effect("fails instead of returning a list GitHub cut short at its cap", () =>
    Effect.gen(function* () {
      const issues = yield* PipelineGitHubIssues;
      const listed = yield* Effect.result(issues.listEligible());
      assert.strictEqual(failureTag(listed), "PipelineIssuesIncompleteError");
    }).pipe(Effect.provide(harness({ capped: true }).layer)),
  );

  it.effect("an empty list means no eligible issue exists", () =>
    Effect.gen(function* () {
      const issues = yield* PipelineGitHubIssues;
      assert.deepStrictEqual(yield* issues.listEligible(), []);
    }).pipe(Effect.provide(harness({ empty: true }).layer)),
  );
});

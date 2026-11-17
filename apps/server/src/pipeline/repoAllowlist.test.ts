import { assert, describe, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  ServerSettings as ServerSettingsSchema,
  type ModelSelection,
  type Project,
  type VcsCreateWorktreeInput,
} from "@t3tools/contracts";
import * as GitHubRest from "@t3tools/source-control-github/server/GitHubRest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { PullRequestAdditions, layer as budgetLayer } from "./budget.ts";
import * as ClaimLease from "./claimLease.ts";
import * as DispatchSession from "./DispatchSession.ts";
import { ELIGIBLE_LABEL, layer as issuesLayer, PipelineGitHubIssues } from "./GitHubIssues.ts";
import { layerPortsDefault } from "./intakeGates.ts";
import { PipelineRuns, PipelineUsage, layer as runsLayer } from "./PipelineRuns.ts";
import { LOCAL_LABEL } from "./repoAllowlist.ts";
import { layer as inboxLayer } from "./SessionEndInbox.ts";

const decodeSettings = Schema.decodeUnknownSync(ServerSettingsSchema);
const MODEL: ModelSelection = { instanceId: ProviderInstanceId.make("test-model"), model: "test" };
const ACCEPTANCE = `## 怎么算做完
- 跑通测试
`;

interface GitHubIssue {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly state: "open";
  readonly labels: ReadonlyArray<{ readonly name: string }>;
  readonly user: { readonly login: string; readonly id: number; readonly type: string };
}

interface GitHubCall {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

const githubIssue = (number: number, title: string): GitHubIssue => ({
  number,
  title,
  body: ACCEPTANCE,
  state: "open",
  labels: [{ name: ELIGIBLE_LABEL }],
  user: { login: "thoerwink8", id: 1, type: "User" },
});

const projectFor = (owner: string, name: string): Project => ({
  id: ProjectId.make(`project:${owner}/${name}`),
  title: name,
  workspaceRoot: `/repos/${owner}/${name}`,
  repositoryIdentity: {
    canonicalKey: `github.com/${owner}/${name}`,
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: `https://github.com/${owner}/${name}.git`,
    },
    owner,
    name,
  },
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-11-17T00:00:00.000Z",
  updatedAt: "2026-11-17T00:00:00.000Z",
  deletedAt: null,
});

function github(catalog: Readonly<Record<string, ReadonlyArray<GitHubIssue>>>) {
  const calls: Array<GitHubCall> = [];
  const rest = Layer.succeed(
    GitHubRest.GitHubRest,
    GitHubRest.GitHubRest.of({
      rest: (input) => {
        const method = input.method ?? "GET";
        calls.push({ method, path: input.path, body: input.body });
        const single = /^repos\/([^/]+\/[^/]+)\/issues\/(\d+)$/.exec(input.path);
        if (single) {
          const found = (catalog[single[1] ?? ""] ?? []).find(
            (issue) => issue.number === Number(single[2]),
          );
          return Effect.succeed({
            status: found === undefined ? 404 : 200,
            headers: {},
            body: JSON.stringify(found ?? { message: "missing" }),
            truncated: false,
            invalidUtf8: false,
          });
        }
        const list = /^repos\/([^/]+\/[^/]+)\/issues\?/.exec(input.path);
        const page = new URLSearchParams(input.path.split("?")[1] ?? "").get("page");
        const body = page === "1" || page === null ? (catalog[list?.[1] ?? ""] ?? []) : [];
        return Effect.succeed({
          status: 200,
          headers: {},
          body: JSON.stringify(body),
          truncated: false,
          invalidUtf8: false,
        });
      },
      credential: () => Effect.die("unused"),
      appCredential: () => Effect.die("unused"),
    }),
  );
  return { calls, layer: issuesLayer.pipe(Layer.provide(rest)) };
}

const usageLayer = Layer.succeed(
  PipelineUsage,
  PipelineUsage.of({
    read: () => Effect.succeed([]),
  }),
);

const pipelineLayer = (input: {
  readonly issues: Layer.Layer<PipelineGitHubIssues>;
  readonly repos: ReadonlyArray<string>;
  readonly pipelineRepos?: ReadonlyArray<string>;
  readonly model?: boolean;
}) =>
  runsLayer.pipe(
    Layer.provide(input.issues),
    Layer.provide(usageLayer),
    Layer.provide(
      ServerSettings.layerTest({
        pipelineEnabled: true,
        ...(input.model === true ? { pipelineAuthorModel: [MODEL] } : {}),
        ...(input.pipelineRepos === undefined ? {} : { pipelineRepos: input.pipelineRepos }),
      }),
    ),
    Layer.provide(layerPortsDefault),
    Layer.provide(ClaimLease.layerPort({ repos: input.repos })),
    Layer.provideMerge(SqlitePersistence.layerMemory),
  );

const listPaths = (calls: ReadonlyArray<GitHubCall>) =>
  calls
    .filter((call) => call.method === "GET" && call.path.includes("/issues?"))
    .map((call) => call.path);

describe("repo allowlist", () => {
  it("缺省只有 thoerwink8/fleet-ade，空列表保持为空", () => {
    assert.deepStrictEqual(decodeSettings({}).pipelineRepos, ["thoerwink8/fleet-ade"]);
    assert.equal(decodeSettings({}).pipelineRepos.includes("thoerwink8/fleet-dao"), false);
    assert.deepStrictEqual(decodeSettings({ pipelineRepos: [] }).pipelineRepos, []);
    assert.deepStrictEqual(
      decodeSettings({
        pipelineRepos: [
          " acme/widgets ",
          "nope",
          "acme/widgets",
          "../hidden",
          "thoerwink8/fleet-ade",
        ],
      }).pipelineRepos,
      ["acme/widgets", "thoerwink8/fleet-ade"],
    );
  });

  it.effect("列表为空时列单请求次数是 0", () => {
    const remote = github({
      "thoerwink8/fleet-ade": [githubIssue(7, "fix tests")],
      "nope/hidden": [githubIssue(7, "fix tests")],
    });
    return Effect.gen(function* () {
      yield* (yield* PipelineRuns).tick;
      assert.deepStrictEqual(remote.calls, []);
      assert.strictEqual((yield* (yield* PipelineRuns).list).runs.length, 0);
    }).pipe(
      Effect.provide(
        pipelineLayer({
          issues: remote.layer,
          repos: ["thoerwink8/fleet-ade", "nope/hidden"],
          pipelineRepos: [],
        }),
      ),
    );
  });

  it.effect("多出来的仓才拉「交给 ADE」，认领后只给它贴「本机做」，租约不串仓", () => {
    const remote = github({
      "thoerwink8/fleet-ade": [githubIssue(7, "fix tests")],
      "acme/widgets": [githubIssue(7, "fix tests")],
      "nope/hidden": [githubIssue(7, "fix tests")],
    });
    return Effect.gen(function* () {
      const runs = yield* PipelineRuns;
      yield* runs.tick;
      const lists = listPaths(remote.calls);
      assert.deepStrictEqual(lists.map((path) => path.split("?")[0]).sort(), [
        "repos/acme/widgets/issues",
        "repos/thoerwink8/fleet-ade/issues",
      ]);
      for (const path of lists) {
        assert.ok(path.includes("state=open"));
        assert.ok(path.includes(`labels=${encodeURIComponent(ELIGIBLE_LABEL)}`));
      }
      assert.equal(
        remote.calls.some((call) => call.path.includes("nope/hidden")),
        false,
      );
      const posts = remote.calls.filter((call) => call.method === "POST");
      assert.deepStrictEqual(posts, [
        {
          method: "POST",
          path: "repos/acme/widgets/issues/7/labels",
          body: { labels: [LOCAL_LABEL] },
        },
      ]);
      const listed = yield* runs.list;
      assert.deepStrictEqual(
        listed.runs.map((run) => `${run.repository}#${run.issueNumber}`).sort(),
        ["acme/widgets#7", "thoerwink8/fleet-ade#7"],
      );
      yield* runs.note(7, { status: "merged" }, "acme/widgets");
      const sql = yield* SqlClient.SqlClient;
      const claims = yield* sql<{ readonly repo: string; readonly issue: number }>`
        SELECT repo, issue FROM node_claims ORDER BY repo
      `;
      assert.deepStrictEqual(claims, [{ repo: "thoerwink8/fleet-ade", issue: 7 }]);
      const after = yield* runs.list;
      assert.strictEqual(
        after.runs.find((run) => run.repository === "acme/widgets")?.status,
        "merged",
      );
      assert.strictEqual(
        after.runs.find((run) => run.repository === "thoerwink8/fleet-ade")?.status,
        "claimed",
      );
    }).pipe(
      Effect.provide(
        pipelineLayer({
          issues: remote.layer,
          repos: ["thoerwink8/fleet-ade", "acme/widgets"],
          pipelineRepos: ["thoerwink8/fleet-ade", "acme/widgets"],
        }),
      ),
    );
  });

  it.effect("默认仓工作树分支仍是 pipeline，别的仓是 local", () => {
    const remote = github({
      "thoerwink8/fleet-ade": [githubIssue(7, "fix tests")],
      "acme/widgets": [githubIssue(7, "fix tests")],
    });
    const created = { branches: [] as Array<string> };
    const projects = Layer.succeed(ProjectService.ProjectService, {
      listPage: () =>
        Effect.succeed({
          projects: [projectFor("thoerwink8", "fleet-ade"), projectFor("acme", "widgets")],
          nextCursor: null,
        }),
    } as unknown as ProjectService.ProjectService["Service"]);
    const git = Layer.succeed(GitWorkflowService.GitWorkflowService, {
      fetchWorktreeBaseCommit: () =>
        Effect.succeed({ commitSha: "base", remoteRefName: "origin/main" }),
      createWorktree: (input: VcsCreateWorktreeInput) => {
        const branch = input.newRefName ?? input.refName;
        created.branches.push(branch);
        return Effect.succeed({ worktree: { path: `/worktrees/${branch}`, refName: branch } });
      },
    } as unknown as GitWorkflowService.GitWorkflowService["Service"]);
    const opener = Layer.succeed(DispatchSession.SessionOpener, {
      open: () => Effect.void,
    });
    const session = DispatchSession.layer.pipe(
      Layer.provide(budgetLayer),
      Layer.provide(Layer.succeed(PullRequestAdditions, { read: () => Effect.succeed(0) })),
      Layer.provide(opener),
      Layer.provide(git),
      Layer.provide(projects),
      Layer.provide(inboxLayer),
      Layer.provide(remote.layer),
      Layer.provide(
        ServerSettings.layerTest({
          pipelineEnabled: true,
          pipelineAuthorModel: [MODEL],
          pipelineRepos: ["thoerwink8/fleet-ade", "acme/widgets"],
        }),
      ),
      Layer.provideMerge(
        pipelineLayer({
          issues: remote.layer,
          repos: ["thoerwink8/fleet-ade", "acme/widgets"],
          pipelineRepos: ["thoerwink8/fleet-ade", "acme/widgets"],
          model: true,
        }),
      ),
    );
    return Effect.gen(function* () {
      const runs = yield* PipelineRuns;
      const dispatch = yield* DispatchSession.DispatchSession;
      yield* runs.tick;
      yield* dispatch.tick;
      const opened = (yield* runs.list).runs.find((run) => run.status === "session");
      if (opened === undefined) return yield* Effect.die("expected one open session");
      const first = created.branches[0];
      yield* runs.note(7, { status: "stuck", stuckReason: "取消" }, opened.repository);
      created.branches = [];
      yield* dispatch.tick;
      assert.deepStrictEqual([first, created.branches[0]].sort(), [
        "local/7-fix-tests",
        "pipeline/7-fix-tests",
      ]);
      assert.equal(
        remote.calls.some(
          (call) => call.method === "POST" && call.path.startsWith("repos/thoerwink8/fleet-ade/"),
        ),
        false,
      );
      assert.ok(
        remote.calls.some(
          (call) =>
            call.method === "POST" &&
            call.path === "repos/acme/widgets/issues/7/labels" &&
            JSON.stringify(call.body) === JSON.stringify({ labels: [LOCAL_LABEL] }),
        ),
      );
    }).pipe(Effect.provide(session));
  });
});

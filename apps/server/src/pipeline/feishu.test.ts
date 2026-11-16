import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as ServerSettings from "../serverSettings.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { PipelineGitHubIssues, PipelineIssuesIncompleteError } from "./GitHubIssues.ts";
import { FEISHU_WEBHOOK_VARIABLE, layer as feishuLayer } from "./feishu.ts";
import { PipelineRuns, PipelineUsage, layer as runsLayer } from "./PipelineRuns.ts";

const FAKE_WEBHOOK = "https://feishu.invalid/hook/test";

const acceptance = `## 怎么算做完
- 跑通测试
`;

const requests: Array<{ readonly url: string; readonly body: string }> = [];

const harness = (options: { readonly webhook: string | undefined; readonly status: number }) => {
  requests.length = 0;
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        requests.push({
          url: request.url,
          body:
            request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "",
        });
        return HttpClientResponse.fromWeb(request, new Response(null, { status: options.status }));
      }),
    ),
  );
  const env = Layer.succeed(
    HostProcess.Environment,
    options.webhook === undefined ? {} : { [FEISHU_WEBHOOK_VARIABLE]: options.webhook },
  );
  return runsLayer.pipe(
    Layer.provide(feishuLayer.pipe(Layer.provide(http), Layer.provide(env))),
    Layer.provide(
      Layer.succeed(
        PipelineGitHubIssues,
        PipelineGitHubIssues.of({
          listEligible: () =>
            Effect.succeed([{ number: 7, title: "单 7", body: acceptance, labels: ["交给 ADE"] }]),
          read: () => Effect.fail(new PipelineIssuesIncompleteError({ reason: "capped" })),
        }),
      ),
    ),
    Layer.provide(
      Layer.succeed(PipelineUsage, PipelineUsage.of({ read: () => Effect.succeed([]) })),
    ),
    Layer.provide(ServerSettings.layerTest({ pipelineEnabled: true })),
    Layer.provideMerge(SqlitePersistence.layerMemory),
  );
};

describe("pipeline feishu", () => {
  it.effect("没配环境变量：记没送出、不发请求、运行仍是 stuck", () =>
    Effect.gen(function* () {
      const runs = yield* PipelineRuns;
      yield* runs.tick;
      yield* runs.note(7, { status: "stuck", stuckReason: "检查红" });
      const run = (yield* runs.list).runs[0];
      assert.strictEqual(requests.length, 0);
      assert.strictEqual(run?.status, "stuck");
      assert.ok(run?.notifyNote?.startsWith("没送出"));
    }).pipe(Effect.provide(harness({ webhook: undefined, status: 200 }))),
  );

  it.effect("推一条文本，带仓、单号、原因、PR；同原因第二次不发；原因变了再发", () =>
    Effect.gen(function* () {
      const runs = yield* PipelineRuns;
      yield* runs.tick;
      yield* runs.note(7, { status: "stuck", stuckReason: "检查红", prNumber: 12 });
      assert.strictEqual(requests.length, 1);
      assert.strictEqual(requests[0]?.url, FAKE_WEBHOOK);
      const text = JSON.parse(requests[0]?.body ?? "{}").content.text as string;
      for (const part of ["thoerwink8/fleet-ade", "#7", "检查红", "12"]) {
        assert.ok(text.includes(part), part);
      }
      assert.strictEqual((yield* runs.list).runs[0]?.notifyNote, null);

      yield* runs.note(7, { detail: "again" });
      yield* runs.note(7, { status: "stuck", stuckReason: "检查红" });
      assert.strictEqual(requests.length, 1);

      yield* runs.note(7, { status: "stuck", stuckReason: "超时" });
      assert.strictEqual(requests.length, 2);
    }).pipe(Effect.provide(harness({ webhook: FAKE_WEBHOOK, status: 200 }))),
  );

  it.effect("HTTP 失败：记没送出，运行仍是 stuck，同原因不重试", () =>
    Effect.gen(function* () {
      const runs = yield* PipelineRuns;
      yield* runs.tick;
      yield* runs.note(7, { status: "stuck", stuckReason: "检查红" });
      yield* runs.note(7, { detail: "x" });
      const run = (yield* runs.list).runs[0];
      assert.strictEqual(requests.length, 1);
      assert.strictEqual(run?.status, "stuck");
      assert.strictEqual(run?.stuckReason, "检查红");
      assert.ok(run?.notifyNote?.startsWith("没送出"));
    }).pipe(Effect.provide(harness({ webhook: FAKE_WEBHOOK, status: 500 }))),
  );
});

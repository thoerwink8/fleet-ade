import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientRequest } from "effect/http";

/** The only place the webhook address comes from. */
export const FEISHU_WEBHOOK_VARIABLE = "FLEET_FEISHU_WEBHOOK";

export interface StuckMessage {
  readonly repository: string;
  readonly issueNumber: number;
  readonly reason: string;
  readonly prNumber: number | null;
}

/** `note` is what the stuck list shows when the push did not go out. */
export type FeishuOutcome =
  | { readonly delivered: true }
  | { readonly delivered: false; readonly note: string };

export class PipelineFeishu extends Context.Service<
  PipelineFeishu,
  {
    readonly send: (message: StuckMessage) => Effect.Effect<FeishuOutcome>;
    readonly sendText: (text: string) => Effect.Effect<FeishuOutcome>;
  }
>()("t3/pipeline/feishu/PipelineFeishu") {}

const formatText = (message: StuckMessage): string =>
  [
    `流水线卡住：${message.repository} #${message.issueNumber}`,
    `原因：${message.reason}`,
    ...(message.prNumber === null ? [] : [`PR：#${message.prNumber}`]),
  ].join("\n");

const make = Effect.gen(function* () {
  const http = yield* HttpClient.HttpClient;
  const environment = yield* HostProcess.Environment;
  const deliver = (text: string) => {
    const webhook = environment[FEISHU_WEBHOOK_VARIABLE]?.trim() ?? "";
    if (webhook.length === 0) {
      return Effect.succeed({
        delivered: false,
        note: `没送出：没配 \`${FEISHU_WEBHOOK_VARIABLE}\``,
      } as const);
    }
    const request = HttpClientRequest.post(webhook).pipe(
      HttpClientRequest.bodyJsonUnsafe({
        msg_type: "text",
        content: { text },
      }),
    );
    return http.execute(request).pipe(
      Effect.timeout("15 seconds"),
      Effect.map((response): FeishuOutcome =>
        response.status >= 200 && response.status < 300
          ? { delivered: true }
          : { delivered: false, note: `没送出：HTTP ${response.status}` },
      ),
      Effect.orElseSucceed((): FeishuOutcome => ({ delivered: false, note: "没送出：请求失败" })),
    );
  };
  const send = Effect.fn("PipelineFeishu.send")(function* (message: StuckMessage) {
    return yield* deliver(formatText(message));
  });
  const sendText = Effect.fn("PipelineFeishu.sendText")(function* (text: string) {
    return yield* deliver(text);
  });
  return PipelineFeishu.of({ send, sendText });
});

export const layer = Layer.effect(PipelineFeishu, make);

import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlError from "effect/sql/SqlError";
import { FetchHttpClient } from "effect/http";

import { PipelineFeishu, layer as feishuLayer } from "./feishu.ts";
const SECTION_LIMIT = 15;

const BEIJING_SHIFT_MS = 8 * 60 * 60 * 1000;
const DUE_MINUTE = 8 * 60 + 30;

export interface BriefStuckRun {
  readonly issueNumber: number;
  readonly title: string;
  readonly reason: string;
}

export interface DailyBriefResult {
  readonly key: string | null;
  readonly sent: boolean;
  /** Why this attempt was not delivered. Null when not due, already delivered, or just delivered. */
  readonly reason: string | null;
}

/** Beijing calendar day, and whether today's 08:30 slot is due. */
export function beijingBriefSlot(now: DateTime.DateTime): {
  readonly day: string;
  readonly due: boolean;
} {
  const iso = DateTime.formatIso(DateTime.add(now, { milliseconds: BEIJING_SHIFT_MS }));
  const hour = Number(iso.slice(11, 13));
  const minute = Number(iso.slice(14, 16));
  return { day: iso.slice(0, 10), due: hour * 60 + minute >= DUE_MINUTE };
}

export class DailyBriefUnread extends Schema.TaggedError<DailyBriefUnread>()(
  "DailyBriefUnread",
  {},
) {}

export class DailyBriefSource extends Context.Service<
  DailyBriefSource,
  { readonly stuck: Effect.Effect<ReadonlyArray<BriefStuckRun>, DailyBriefUnread> }
>()("t3/pipeline/dailyBrief/DailyBriefSource") {}

export type BriefSendOutcome =
  | { readonly delivered: true }
  | { readonly delivered: false; readonly reason: string };

export class DailyBriefSend extends Context.Service<
  DailyBriefSend,
  { readonly send: (text: string) => Effect.Effect<BriefSendOutcome> }
>()("t3/pipeline/dailyBrief/DailyBriefSend") {}

export class DailyBrief extends Context.Service<
  DailyBrief,
  { readonly run: Effect.Effect<DailyBriefResult, SqlError.SqlError> }
>()("t3/pipeline/dailyBrief") {}

const StuckRow = Schema.Struct({
  issueNumber: Schema.Int,
  title: Schema.String,
  reason: Schema.NullOr(Schema.String),
});
const decodeStuck = Schema.decodeUnknownEffect(Schema.Array(StuckRow));

const formatBrief = (
  day: string,
  stuck: Exit.Exit<ReadonlyArray<BriefStuckRun>, DailyBriefUnread>,
): string => {
  const head = `【每日简报】${day}\n卡住的运行`;
  if (Exit.isFailure(stuck)) return `${head}\n没查成`;
  const lines = stuck.value.map((run) => `#${run.issueNumber} ${run.title}（${run.reason}）`);
  const shown = lines.slice(0, SECTION_LIMIT);
  const rest = lines.length - shown.length;
  const list = shown.length === 0 ? "没有卡住的" : shown.join("\n");
  return `${head}\n${list}${rest > 0 ? `\n另 ${rest} 条` : ""}`;
};

const layerSource = Layer.effect(
  DailyBriefSource,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const readStuck = Effect.fn("DailyBriefSource.stuck")(function* () {
      const rows = yield* sql<{
        readonly issueNumber: number;
        readonly title: string;
        readonly reason: string | null;
      }>`
        SELECT issue_number AS issueNumber, title, stuck_reason AS reason
        FROM pipeline_runs
        WHERE status = 'stuck'
        ORDER BY updated_at DESC, id DESC
      `;
      const decoded = yield* decodeStuck(rows);
      return decoded.map((row) => ({
        issueNumber: row.issueNumber,
        title: row.title,
        reason: row.reason ?? "",
      }));
    });
    return DailyBriefSource.of({
      stuck: readStuck().pipe(Effect.mapError(() => new DailyBriefUnread())),
    });
  }),
);

const layerSend = Layer.effect(
  DailyBriefSend,
  Effect.gen(function* () {
    const feishu = yield* PipelineFeishu;
    const send = Effect.fn("DailyBriefSend.send")(function* (text: string) {
      const outcome = yield* feishu.sendText(text);
      return outcome.delivered
        ? { delivered: true as const }
        : { delivered: false as const, reason: outcome.note };
    });
    return DailyBriefSend.of({ send });
  }),
);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const source = yield* DailyBriefSource;
  const deliver = yield* DailyBriefSend;
  const read = Effect.fn("DailyBrief.run")(function* () {
    const slot = beijingBriefSlot(yield* DateTime.now);
    if (!slot.due) return { key: null, sent: false, reason: null };
    const existing = yield* sql<{ readonly day: string }>`
      SELECT day FROM pipeline_daily_brief WHERE day = ${slot.day}
    `;
    if (existing.length > 0) return { key: slot.day, sent: false, reason: null };
    const stuck = yield* Effect.exit(source.stuck);
    const delivery = yield* deliver.send(formatBrief(slot.day, stuck));
    if (!delivery.delivered) return { key: null, sent: false, reason: delivery.reason };
    yield* sql`
      INSERT INTO pipeline_daily_brief (day) VALUES (${slot.day})
      ON CONFLICT (day) DO NOTHING
    `;
    return { key: slot.day, sent: true, reason: null };
  });
  return DailyBrief.of({ run: read() });
});

export const layer = Layer.effect(DailyBrief, make);

/** Feishu-backed brief. The HTTP client stays open so tests can fail a delivery. */
export const layerFeishu = layer.pipe(
  Layer.provide(layerSource),
  Layer.provide(layerSend.pipe(Layer.provide(feishuLayer))),
);

export const layerLive = layerFeishu.pipe(Layer.provide(FetchHttpClient.layer));

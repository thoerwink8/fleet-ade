import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import {
  encodeThreadMessagePreviewJson,
  isPreviewEligibleMessageSql,
  JAVASCRIPT_TRIM_WHITESPACE,
  SHELL_MESSAGE_PREVIEW_SQL_PREFIX_CHARS,
  summarizeThreadMessagePreview,
} from "../../orchestration-v2/threadMessagePreview.ts";

/**
 * Materialize single-line plain-text message previews on thread rows so shell
 * snapshots read O(threads) without scanning or json_extracting message history.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE orchestration_v2_projection_threads ADD COLUMN latest_message_preview_json TEXT`;
  yield* sql`ALTER TABLE orchestration_v2_projection_threads ADD COLUMN latest_message_preview_updated_at TEXT`;
  yield* sql`ALTER TABLE orchestration_v2_projection_threads ADD COLUMN latest_message_preview_message_id TEXT`;

  const candidates = yield* sql<{
    readonly thread_id: string;
    readonly message_id: string;
    readonly role: "user" | "assistant";
    readonly updated_at: string;
    readonly text_prefix: string;
  }>`
    WITH ranked AS (
      SELECT
        message.thread_id,
        message.message_id,
        message.role,
        message.updated_at,
        substr(
          trim(coalesce(json_extract(message.payload_json, '$.text'), ''), ${JAVASCRIPT_TRIM_WHITESPACE}),
          1,
          ${SHELL_MESSAGE_PREVIEW_SQL_PREFIX_CHARS}
        ) AS text_prefix,
        ROW_NUMBER() OVER (
          PARTITION BY message.thread_id
          ORDER BY message.updated_at DESC, message.message_id DESC
        ) AS rn
      FROM orchestration_v2_projection_messages message
      WHERE ${isPreviewEligibleMessageSql(sql, "message")}
    )
    SELECT thread_id, message_id, role, updated_at, text_prefix
    FROM ranked
    WHERE rn <= 5
    ORDER BY thread_id ASC, rn ASC
  `;

  const resolvedThreads = new Set<string>();
  for (const row of candidates) {
    if (resolvedThreads.has(row.thread_id)) continue;
    const summary = summarizeThreadMessagePreview(row.role, row.text_prefix);
    if (summary === null) continue;
    resolvedThreads.add(row.thread_id);
    const previewJson = yield* Effect.orDie(encodeThreadMessagePreviewJson(summary));
    yield* sql`
      UPDATE orchestration_v2_projection_threads
      SET
        latest_message_preview_json = ${previewJson},
        latest_message_preview_updated_at = ${row.updated_at},
        latest_message_preview_message_id = ${row.message_id}
      WHERE thread_id = ${row.thread_id}
    `;
  }
});

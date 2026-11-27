import * as SqlClient from "effect/sql/SqlClient";
import * as Effect from "effect/Effect";

/**
 * Bots become the only record of the commander mark. One bot per marked thread
 * still live or in the trash, and no thread payload carries `commander` anymore.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS orchestration_v2_projection_bots (
      bot_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      current_thread_id TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS orchestration_v2_projection_bots_current_thread_idx
    ON orchestration_v2_projection_bots(current_thread_id)
    WHERE status <> 'retired'
  `;
  // Tombstones of purged threads are skipped: a deleted thread counts only while
  // it can come back from the trash.
  yield* sql`
    INSERT OR IGNORE INTO orchestration_v2_projection_bots (
      bot_id,
      status,
      current_thread_id,
      updated_at,
      payload_json
    )
    SELECT
      'bot:commander:' || thread_id,
      'active',
      thread_id,
      created_at,
      json_object(
        'id', 'bot:commander:' || thread_id,
        'name', COALESCE(NULLIF(title, ''), 'Commander'),
        'status', 'active',
        'currentThreadId', thread_id,
        'createdAt', created_at,
        'updatedAt', created_at
      )
    FROM orchestration_v2_projection_threads
    WHERE json_extract(payload_json, '$.commander') = 1
      AND (
        deleted_at IS NULL
        OR EXISTS (
          SELECT 1 FROM orchestration_v2_projection_thread_trash
          WHERE orchestration_v2_projection_thread_trash.thread_id =
            orchestration_v2_projection_threads.thread_id
        )
      )
  `;
  yield* sql`
    UPDATE orchestration_v2_projection_threads
    SET payload_json = json_remove(payload_json, '$.commander')
    WHERE json_extract(payload_json, '$.commander') IS NOT NULL
  `;
});

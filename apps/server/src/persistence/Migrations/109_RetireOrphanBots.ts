import * as SqlClient from "effect/sql/SqlClient";
import * as Effect from "effect/Effect";

/**
 * Bots created before purges retired them can point at threads that no longer exist,
 * or at tombstones of already purged threads. Those orphans retire here: a trashed
 * thread still counts as a home because it can come back, and its bot retires when
 * the purge lands instead.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    UPDATE orchestration_v2_projection_bots
    SET
      status = 'retired',
      payload_json = json_set(payload_json, '$.status', 'retired')
    WHERE status <> 'retired'
      AND (
        NOT EXISTS (
          SELECT 1 FROM orchestration_v2_projection_threads
          WHERE orchestration_v2_projection_threads.thread_id =
            orchestration_v2_projection_bots.current_thread_id
        )
        OR (
          EXISTS (
            SELECT 1 FROM orchestration_v2_projection_threads
            WHERE orchestration_v2_projection_threads.thread_id =
              orchestration_v2_projection_bots.current_thread_id
              AND orchestration_v2_projection_threads.deleted_at IS NOT NULL
          )
          AND NOT EXISTS (
            SELECT 1 FROM orchestration_v2_projection_thread_trash
            WHERE orchestration_v2_projection_thread_trash.thread_id =
              orchestration_v2_projection_bots.current_thread_id
          )
        )
      )
  `;
});

import * as SqlClient from "effect/sql/SqlClient";
import * as Effect from "effect/Effect";

/** Recoverable thread deletions, projected only from new lifecycle events. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE orchestration_v2_projection_thread_trash (
      thread_id TEXT PRIMARY KEY REFERENCES orchestration_v2_projection_threads(thread_id) ON DELETE CASCADE,
      project_id TEXT NOT NULL,
      deleted_at TEXT NOT NULL,
      purge_due_at INTEGER NOT NULL,
      cascade_root_id TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX orchestration_v2_projection_thread_trash_purge_due_idx
    ON orchestration_v2_projection_thread_trash(purge_due_at)
  `;
  yield* sql`
    CREATE INDEX orchestration_v2_projection_thread_trash_cascade_root_idx
    ON orchestration_v2_projection_thread_trash(cascade_root_id)
  `;
});

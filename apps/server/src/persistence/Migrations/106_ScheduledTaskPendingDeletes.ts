import * as SqlClient from "effect/sql/SqlClient";
import * as Effect from "effect/Effect";

/** Deleting a task first marks it for a short undo window; the server purges at due_at. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS scheduled_task_pending_deletes (
      task_id TEXT PRIMARY KEY REFERENCES scheduled_tasks(task_id) ON DELETE CASCADE,
      marked_at TEXT NOT NULL,
      due_at INTEGER NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_scheduled_task_pending_deletes_due
    ON scheduled_task_pending_deletes(due_at)
  `;
});

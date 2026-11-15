import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // One row per finished run. A later, different terminal state is a conflict, never a rewrite.
  yield* sql`
    CREATE TABLE IF NOT EXISTS pipeline_session_end_inbox (
      run_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      status TEXT NOT NULL,
      ended_at TEXT NOT NULL,
      head_sha TEXT,
      head_lookup TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS pipeline_session_end_conflicts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      kept_status TEXT NOT NULL,
      rejected_status TEXT NOT NULL,
      ended_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pipeline_session_end_conflicts_run
    ON pipeline_session_end_conflicts (run_id, rejected_status)
  `;

  // Last orchestration sequence already applied, so a restart does not replay finished runs.
  yield* sql`
    CREATE TABLE IF NOT EXISTS pipeline_session_end_cursor (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      sequence INTEGER NOT NULL
    )
  `;
});

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // One row per run. A later issue fills the nullable columns; the columns stay.
  yield* sql`
    CREATE TABLE IF NOT EXISTS pipeline_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repository TEXT NOT NULL,
      issue_number INTEGER NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      stuck_reason TEXT,
      thread_id TEXT,
      pr_number INTEGER,
      head_sha TEXT,
      updated_at TEXT NOT NULL,
      session_started_at TEXT,
      session_ended_at TEXT,
      magpie_account TEXT,
      usage_state TEXT NOT NULL,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cache_tokens INTEGER,
      converted_cost TEXT,
      commit_count INTEGER,
      ci_queue_ms INTEGER
    )
  `;

  // Merged, and stuck-after-cancel, are finished, so the issue can run again.
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pipeline_runs_one_active
    ON pipeline_runs (repository, issue_number)
    WHERE NOT (
      status = 'merged' OR (status = 'stuck' AND stuck_reason = '取消')
    )
  `;

  // The latest tick only. A failed read is recorded here and creates no run.
  yield* sql`
    CREATE TABLE IF NOT EXISTS pipeline_tick (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      at TEXT NOT NULL,
      outcome TEXT NOT NULL,
      detail TEXT
    )
  `;
});

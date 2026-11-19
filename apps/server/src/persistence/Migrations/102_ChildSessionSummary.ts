import * as SqlClient from "effect/sql/SqlClient";
import * as Effect from "effect/Effect";

/** One derived row per direct child thread; feeds the commander bar and the phone. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE child_session_summary (
      thread_id TEXT PRIMARY KEY,
      parent_thread_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      phase TEXT NOT NULL,
      reason TEXT NOT NULL,
      conclusion TEXT,
      needs_you INTEGER NOT NULL DEFAULT 0,
      activity TEXT NOT NULL,
      goal_summary TEXT NOT NULL,
      goal TEXT NOT NULL,
      avoid TEXT NOT NULL,
      files_json TEXT NOT NULL DEFAULT '[]',
      latest_command TEXT,
      branch TEXT,
      pr_number INTEGER,
      pr_state TEXT,
      run_status TEXT NOT NULL,
      role TEXT NOT NULL,
      grandchild_count INTEGER NOT NULL DEFAULT 0,
      grandchild_note TEXT,
      created_at_ms INTEGER NOT NULL,
      activity_at_ms INTEGER NOT NULL,
      idle_eligible INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX child_session_summary_parent_idx
    ON child_session_summary(parent_thread_id, created_at_ms, thread_id)
  `;
});

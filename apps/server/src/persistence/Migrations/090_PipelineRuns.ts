import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // One row per run. A later issue fills values; the columns stay.
  yield* sql`
    CREATE TABLE IF NOT EXISTS pipeline_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repository TEXT NOT NULL,
      issue_number INTEGER NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL CHECK (
        status IN (
          'claimed', 'session', 'pr-open', 'checks', 'verify', 'mergeable', 'merged', 'stuck'
        )
      ),
      stuck_reason TEXT CHECK (
        stuck_reason IS NULL OR stuck_reason IN (
          '会话失败', '检查红', '超时', '超预算', '冷验收不过', '交人', '取消', '没配模型'
        )
      ),
      thread_id TEXT,
      pr_number INTEGER,
      head_sha TEXT,
      updated_at TEXT NOT NULL,
      session_started_at TEXT,
      session_ended_at TEXT,
      model_account TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cache_tokens INTEGER,
      converted_cost REAL,
      usage_note TEXT CHECK (usage_note IS NULL OR usage_note = '读不到'),
      commit_count INTEGER,
      ci_queue_ms INTEGER,
      detail TEXT,
      CHECK (
        (status = 'stuck' AND stuck_reason IS NOT NULL)
        OR (status <> 'stuck' AND stuck_reason IS NULL)
      ),
      CHECK (
        (
          usage_note IS NULL
          AND input_tokens IS NULL
          AND output_tokens IS NULL
          AND cache_tokens IS NULL
          AND converted_cost IS NULL
        )
        OR (
          usage_note = '读不到'
          AND input_tokens IS NULL
          AND output_tokens IS NULL
          AND cache_tokens IS NULL
          AND converted_cost IS NULL
          AND model_account IS NULL
        )
        OR (
          usage_note IS NULL
          AND input_tokens IS NOT NULL
          AND output_tokens IS NOT NULL
          AND cache_tokens IS NOT NULL
          AND converted_cost IS NOT NULL
        )
      )
    )
  `;

  // Merged, and stuck after a person cancels, are the only states that free the issue.
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pipeline_runs_one_active
    ON pipeline_runs (repository, issue_number)
    WHERE NOT (status = 'merged' OR (status = 'stuck' AND stuck_reason = '取消'))
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS pipeline_tick (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      at TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK (outcome IN ('ok', 'failed')),
      detail TEXT
    )
  `;
});

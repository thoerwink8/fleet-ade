import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));

const insertTask = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO scheduled_tasks ${sql.insert({
    task_id: "task:pre-migration",
    title: "Nightly",
    prompt: "Check the build",
    enabled: 1,
    schedule_json: '{"type":"interval","everyMs":60000}',
    project_id: "project:test",
    thread_id: "thread:bound",
    thread_mode: "continue",
    workspace_strategy_json: '{"type":"root"}',
    model_selection_json: '{"instanceId":"codex","model":"gpt-5"}',
    runtime_mode: "full-access",
    interaction_mode: "default",
    created_by: "user",
    creation_source: "web",
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
    next_run_at: "2026-10-01T01:00:00.000Z",
    last_run_at: null,
    last_run_status: "never",
    last_run_error: null,
    run_count: 0,
  })}`;
});

layer("110_ScheduledTaskBotId", (it) => {
  it.effect("adds a nullable bot_id and keeps existing rows bound to their thread", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 109 });
      yield* insertTask;
      yield* runMigrations();

      const [row] = yield* sql<{
        readonly task_id: string;
        readonly thread_id: string | null;
        readonly bot_id: string | null;
      }>`
        SELECT task_id, thread_id, bot_id FROM scheduled_tasks WHERE task_id = 'task:pre-migration'
      `;
      assert.strictEqual(row?.thread_id, "thread:bound");
      assert.strictEqual(row?.bot_id, null);

      // The column accepts a binding and stays nullable.
      yield* sql`UPDATE scheduled_tasks SET bot_id = 'bot:commander' WHERE task_id = 'task:pre-migration'`;
      const [updated] = yield* sql<{ readonly bot_id: string | null }>`
        SELECT bot_id FROM scheduled_tasks WHERE task_id = 'task:pre-migration'
      `;
      assert.strictEqual(updated?.bot_id, "bot:commander");
    }),
  );
});

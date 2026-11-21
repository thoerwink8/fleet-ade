import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));

layer("103_ProjectionThreadMessagePreview", (it) => {
  it.effect(
    "backfills stripped plain-text previews while excluding wakes and rolled-back runs",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 102 });

        const insertThread = (id: string) => sql`
        INSERT INTO orchestration_v2_projection_threads (
          thread_id, project_id, title, default_provider, provider_instance_id,
          runtime_mode, interaction_mode, active_provider_thread_id,
          created_at, updated_at, archived_at, deleted_at, payload_json
        ) VALUES (
          ${id}, 'project-1', ${id}, 'codex', 'codex',
          'full-access', 'default', NULL,
          '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', NULL, NULL, '{}'
        )
      `;
        const insertRun = (id: string, threadId: string, ordinal: number, status: string) => sql`
        INSERT INTO orchestration_v2_projection_runs (
          run_id, thread_id, ordinal, provider, provider_instance_id, provider_thread_id,
          status, requested_at, completed_at, payload_json
        ) VALUES (
          ${id}, ${threadId}, ${ordinal}, 'codex', 'codex', NULL,
          ${status}, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', '{}'
        )
      `;
        const insertMessage = (
          id: string,
          threadId: string,
          runId: string | null,
          role: "user" | "assistant",
          updatedAt: string,
          payload: Record<string, unknown>,
        ) => sql`
        INSERT INTO orchestration_v2_projection_messages (
          message_id, thread_id, run_id, node_id, role, streaming,
          created_at, updated_at, payload_json, search_text
        ) VALUES (
          ${id}, ${threadId}, ${runId}, NULL, ${role}, 0,
          ${updatedAt}, ${updatedAt}, ${JSON.stringify(payload)}, ''
        )
      `;

        yield* insertThread("thread-md");
        yield* insertThread("thread-empty");
        yield* insertRun("run-ok", "thread-md", 1, "completed");
        yield* insertRun("run-rb", "thread-md", 2, "rolled_back");

        yield* insertMessage(
          "m-1",
          "thread-md",
          "run-ok",
          "assistant",
          "2026-10-01T00:00:01.000Z",
          {
            createdBy: "agent",
            text: "### 结论\n已修复 **重连问题**，详见 [文档](https://example.com)",
          },
        );
        yield* insertMessage(
          "m-2",
          "thread-md",
          "run-rb",
          "assistant",
          "2026-10-01T00:00:02.000Z",
          {
            createdBy: "agent",
            text: "rolled back reply",
          },
        );
        yield* insertMessage("m-3", "thread-md", "run-ok", "user", "2026-10-01T00:00:03.000Z", {
          createdBy: "agent",
          notification: { source: { kind: "background_command" }, outcome: "completed" },
          text: "Background command finished",
        });

        yield* runMigrations();

        const rows = yield* sql<{
          readonly thread_id: string;
          readonly latest_message_preview_json: string | null;
        }>`
        SELECT thread_id, latest_message_preview_json
        FROM orchestration_v2_projection_threads
        ORDER BY thread_id
      `;
        assert.deepStrictEqual(rows, [
          { thread_id: "thread-empty", latest_message_preview_json: null },
          {
            thread_id: "thread-md",
            latest_message_preview_json: JSON.stringify({
              role: "assistant",
              text: "结论 已修复 重连问题，详见 文档",
            }),
          },
        ]);
      }),
  );
});

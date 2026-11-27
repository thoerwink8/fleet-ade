import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import Migration0109 from "./109_RetireOrphanBots.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));

const botPayload = (input: { id: string; threadId: string; status?: string }) =>
  JSON.stringify({
    id: input.id,
    name: input.id,
    status: input.status ?? "active",
    currentThreadId: input.threadId,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  });

layer("109_RetireOrphanBots", (it) => {
  const insertThread = (input: { id: string; deletedAt: string | null; inTrash?: boolean }) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO orchestration_v2_projection_threads (
          thread_id, project_id, title, default_provider, provider_instance_id,
          runtime_mode, interaction_mode, active_provider_thread_id,
          created_at, updated_at, archived_at, deleted_at, payload_json
        ) VALUES (
          ${input.id}, 'project-1', ${input.id}, 'codex', 'codex',
          'full-access', 'default', NULL,
          '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z',
          NULL, ${input.deletedAt}, '{}'
        )
      `;
      if (input.inTrash === true) {
        yield* sql`
          INSERT INTO orchestration_v2_projection_thread_trash (
            thread_id, project_id, deleted_at, purge_due_at, cascade_root_id
          ) VALUES (
            ${input.id}, 'project-1', ${input.deletedAt}, 1000000, ${input.id}
          )
        `;
      }
    });

  const insertBot = (input: { id: string; threadId: string; status?: string }) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO orchestration_v2_projection_bots (
          bot_id, status, current_thread_id, updated_at, payload_json
        ) VALUES (
          ${input.id}, ${input.status ?? "active"}, ${input.threadId},
          '2026-10-01T00:00:00.000Z', ${botPayload(input)}
        )
      `;
    });

  const readBots = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql<{
      readonly bot_id: string;
      readonly status: string;
      readonly payload_status: string;
    }>`
      SELECT bot_id, status, json_extract(payload_json, '$.status') AS payload_status
      FROM orchestration_v2_projection_bots
      ORDER BY bot_id
    `;
  });

  it.effect("retires only orphan bots and stays idempotent", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 108 });

      // Live thread: the bot keeps its home.
      yield* insertThread({ id: "thread-live", deletedAt: null });
      // Trashed thread: it can come back, so the bot stays active until the purge.
      yield* insertThread({
        id: "thread-trashed",
        deletedAt: "2026-10-03T00:00:00.000Z",
        inTrash: true,
      });
      // Tombstone-only thread: purged already, the bot is an orphan.
      yield* insertThread({ id: "thread-tombstone", deletedAt: "2026-10-04T00:00:00.000Z" });
      // No thread row at all: the thread is gone entirely.
      yield* insertBot({ id: "bot-live", threadId: "thread-live" });
      yield* insertBot({ id: "bot-trashed", threadId: "thread-trashed" });
      yield* insertBot({ id: "bot-tombstone", threadId: "thread-tombstone" });
      yield* insertBot({ id: "bot-missing", threadId: "thread-gone" });
      yield* insertBot({ id: "bot-already-retired", threadId: "thread-gone", status: "retired" });

      yield* runMigrations();

      const bots = yield* readBots;
      assert.deepStrictEqual(
        bots.map((bot) => [bot.bot_id, bot.status, bot.payload_status]),
        [
          // Already retired rows are untouched: the migration only flips non-retired orphans.
          ["bot-already-retired", "retired", "retired"],
          ["bot-live", "active", "active"],
          ["bot-missing", "retired", "retired"],
          ["bot-tombstone", "retired", "retired"],
          ["bot-trashed", "active", "active"],
        ],
      );

      // Running the migration body again must not error or change rows.
      yield* Migration0109;
      const botsAgain = yield* readBots;
      assert.deepStrictEqual(botsAgain, bots);
    }),
  );
});

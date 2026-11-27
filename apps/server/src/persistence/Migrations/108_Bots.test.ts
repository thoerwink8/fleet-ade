import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import Migration0108 from "./108_Bots.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));

type ThreadFixture = {
  readonly id: string;
  readonly title: string;
  readonly deletedAt: string | null;
  readonly inTrash?: boolean;
  readonly payload: Record<string, unknown>;
};

layer("108_Bots", (it) => {
  const insertFixtures = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const insertThread = (fixture: ThreadFixture) => sql`
      INSERT INTO orchestration_v2_projection_threads (
        thread_id, project_id, title, default_provider, provider_instance_id,
        runtime_mode, interaction_mode, active_provider_thread_id,
        created_at, updated_at, archived_at, deleted_at, payload_json
      ) VALUES (
        ${fixture.id}, 'project-1', ${fixture.title}, 'codex', 'codex',
        'full-access', 'default', NULL,
        '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z',
        ${fixture.id === "thread-archived-commander" ? "2026-10-02T00:00:00.000Z" : null},
        ${fixture.deletedAt}, ${JSON.stringify(fixture.payload)}
      )
    `;
    const insertTrash = (threadId: string, deletedAt: string) => sql`
      INSERT INTO orchestration_v2_projection_thread_trash (
        thread_id, project_id, deleted_at, purge_due_at, cascade_root_id
      ) VALUES (
        ${threadId}, 'project-1', ${deletedAt}, 1000000, ${threadId}
      )
    `;

    yield* insertThread({
      id: "thread-commander",
      title: "指挥线程",
      deletedAt: null,
      payload: { commander: true, title: "指挥线程" },
    });
    yield* insertThread({
      id: "thread-archived-commander",
      title: "Archived commander",
      deletedAt: null,
      payload: { commander: true },
    });
    yield* insertThread({
      id: "thread-trash-commander",
      title: "Trashed commander",
      deletedAt: "2026-10-03T00:00:00.000Z",
      inTrash: true,
      payload: { commander: true },
    });
    yield* insertThread({
      id: "thread-tombstone-commander",
      title: "Tombstone commander",
      deletedAt: "2026-10-04T00:00:00.000Z",
      payload: { commander: true },
    });
    yield* insertThread({
      id: "thread-plain",
      title: "Plain",
      deletedAt: null,
      payload: { title: "Plain" },
    });
    yield* insertThread({
      id: "thread-unmarked",
      title: "Unmarked",
      deletedAt: null,
      payload: { commander: false },
    });
    yield* insertTrash("thread-trash-commander", "2026-10-03T00:00:00.000Z");
  });

  const readBots = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql<{
      readonly bot_id: string;
      readonly status: string;
      readonly current_thread_id: string;
      readonly payload_json: string;
    }>`
      SELECT bot_id, status, current_thread_id, payload_json
      FROM orchestration_v2_projection_bots
      ORDER BY bot_id
    `;
  });

  it.effect("backfills one bot per marked live or trashed thread and strips the legacy flag", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 107 });
      yield* insertFixtures;
      yield* runMigrations();

      const bots = yield* readBots;
      assert.deepStrictEqual(
        bots.map((bot) => [bot.bot_id, bot.status, bot.current_thread_id]),
        [
          ["bot:commander:thread-archived-commander", "active", "thread-archived-commander"],
          ["bot:commander:thread-commander", "active", "thread-commander"],
          ["bot:commander:thread-trash-commander", "active", "thread-trash-commander"],
        ],
      );
      const named = bots.find((bot) => bot.bot_id === "bot:commander:thread-commander");
      assert.isDefined(named);
      assert.deepStrictEqual(JSON.parse(named!.payload_json), {
        id: "bot:commander:thread-commander",
        name: "指挥线程",
        status: "active",
        currentThreadId: "thread-commander",
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-01T00:00:00.000Z",
      });

      const payloads = yield* sql<{
        readonly thread_id: string;
        readonly commander: unknown;
      }>`
        SELECT thread_id, json_extract(payload_json, '$.commander') AS commander
        FROM orchestration_v2_projection_threads
        ORDER BY thread_id
      `;
      assert.deepStrictEqual(
        payloads.map((row) => [row.thread_id, row.commander]),
        [
          ["thread-archived-commander", null],
          ["thread-commander", null],
          ["thread-plain", null],
          ["thread-tombstone-commander", null],
          ["thread-trash-commander", null],
          ["thread-unmarked", null],
        ],
      );

      // Running the migration body again must not error or duplicate rows.
      yield* Migration0108;
      const botsAgain = yield* readBots;
      assert.strictEqual(botsAgain.length, bots.length);
    }),
  );
});

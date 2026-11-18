import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

layer("101_AuthPeerEnvironmentBinding", (it) => {
  it.effect("revokes older duplicate active peer sessions before creating the unique index", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 100 });
      yield* sql`ALTER TABLE auth_sessions ADD COLUMN peer_link INTEGER NOT NULL DEFAULT 0`;
      yield* sql`ALTER TABLE auth_sessions ADD COLUMN peer_environment_id TEXT`;
      yield* sql`
        INSERT INTO auth_sessions (
          session_id,
          subject,
          scopes,
          method,
          issued_at,
          expires_at,
          peer_link,
          peer_environment_id
        )
        VALUES
          (
            'peer-session-old',
            'peer',
            '[]',
            'mcp-oauth',
            '2026-05-29T00:00:00.000Z',
            '2026-05-30T00:00:00.000Z',
            1,
            'peer-environment-1'
          ),
          (
            'peer-session-new',
            'peer',
            '[]',
            'mcp-oauth',
            '2026-05-29T01:00:00.000Z',
            '2026-05-30T01:00:00.000Z',
            1,
            'peer-environment-1'
          )
      `;

      yield* runMigrations({ toMigrationInclusive: 101 });

      const rows = yield* sql<{
        readonly sessionId: string;
        readonly revokedAt: string | null;
      }>`
        SELECT session_id AS "sessionId", revoked_at AS "revokedAt"
        FROM auth_sessions
        WHERE peer_environment_id = 'peer-environment-1'
        ORDER BY session_id
      `;
      assert.strictEqual(rows.length, 2);
      assert.isNotNull(rows.find((row) => row.sessionId === "peer-session-old")?.revokedAt);
      assert.isNull(rows.find((row) => row.sessionId === "peer-session-new")?.revokedAt);

      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND name = 'idx_auth_sessions_active_peer_environment'
      `;
      assert.deepStrictEqual(indexes, [{ name: "idx_auth_sessions_active_peer_environment" }]);
    }),
  );
});

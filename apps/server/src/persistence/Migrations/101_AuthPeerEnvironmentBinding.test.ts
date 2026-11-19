import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

layer("101_AuthPeerEnvironmentBinding", (it) => {
  it.effect("preserves duplicate peer sessions while adding the peer-link marker", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 100 });
      yield* sql`
        INSERT INTO auth_sessions (
          session_id,
          subject,
          scopes,
          method,
          issued_at,
          expires_at
        )
        VALUES
          ('peer-session-old', 'peer', '[]', 'bearer-access-token', '2026-05-29T00:00:00.000Z', '2026-05-30T00:00:00.000Z'),
          ('peer-session-new', 'peer', '[]', 'bearer-access-token', '2026-05-29T01:00:00.000Z', '2026-05-30T00:00:00.000Z')
      `;

      yield* runMigrations({ toMigrationInclusive: 101 });

      const rows = yield* sql<{ readonly sessionId: string; readonly peerLink: number }>`
        SELECT session_id AS "sessionId", peer_link AS "peerLink"
        FROM auth_sessions
        WHERE session_id LIKE 'peer-session-%'
        ORDER BY session_id
      `;
      assert.deepStrictEqual(rows, [
        { sessionId: "peer-session-new", peerLink: 0 },
        { sessionId: "peer-session-old", peerLink: 0 },
      ]);
    }),
  );
});

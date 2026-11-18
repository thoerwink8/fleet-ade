import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const pairingColumns = yield* sql<{
    readonly name: string;
  }>`PRAGMA table_info(auth_pairing_links)`;
  if (!pairingColumns.some((column) => column.name === "peer_environment_id")) {
    yield* sql`ALTER TABLE auth_pairing_links ADD COLUMN peer_environment_id TEXT`;
  }

  const sessionColumns = yield* sql<{ readonly name: string }>`PRAGMA table_info(auth_sessions)`;
  if (!sessionColumns.some((column) => column.name === "peer_link")) {
    yield* sql`ALTER TABLE auth_sessions ADD COLUMN peer_link INTEGER NOT NULL DEFAULT 0`;
  }
  if (!sessionColumns.some((column) => column.name === "peer_environment_id")) {
    yield* sql`ALTER TABLE auth_sessions ADD COLUMN peer_environment_id TEXT`;
  }
  // Keep the newest active peer session per environment; ties use session_id, and older rows are revoked.
  yield* sql`
    UPDATE auth_sessions AS duplicate
    SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE duplicate.peer_link = 1
      AND duplicate.peer_environment_id IS NOT NULL
      AND duplicate.revoked_at IS NULL
      AND EXISTS (
        SELECT 1
        FROM auth_sessions AS keeper
        WHERE keeper.peer_link = 1
          AND keeper.peer_environment_id = duplicate.peer_environment_id
          AND keeper.revoked_at IS NULL
          AND (
            keeper.issued_at > duplicate.issued_at
            OR (keeper.issued_at = duplicate.issued_at AND keeper.session_id > duplicate.session_id)
          )
      )
  `;

  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_sessions_active_peer_environment
    ON auth_sessions(peer_environment_id)
    WHERE peer_link = 1 AND peer_environment_id IS NOT NULL AND revoked_at IS NULL
  `;
});

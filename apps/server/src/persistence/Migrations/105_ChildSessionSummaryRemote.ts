import * as SqlClient from "effect/sql/SqlClient";
import * as Effect from "effect/Effect";

/** Cross-machine child summary metadata, git refs, and per-row staleness. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE child_session_summary ADD COLUMN environment_id TEXT`;
  yield* sql`ALTER TABLE child_session_summary ADD COLUMN environment_label TEXT`;
  yield* sql`ALTER TABLE child_session_summary ADD COLUMN title TEXT`;
  yield* sql`ALTER TABLE child_session_summary ADD COLUMN repo TEXT`;
  yield* sql`ALTER TABLE child_session_summary ADD COLUMN commit_sha TEXT`;
  yield* sql`ALTER TABLE child_session_summary ADD COLUMN stale INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE child_session_summary ADD COLUMN stale_reason TEXT`;
});

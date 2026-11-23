import * as SqlClient from "effect/sql/SqlClient";
import * as Effect from "effect/Effect";

/** Assist cache, hand-back text, and patrol memory. Separate from the derived child row. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE command_assist_state (
      thread_id TEXT PRIMARY KEY,
      state_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
});

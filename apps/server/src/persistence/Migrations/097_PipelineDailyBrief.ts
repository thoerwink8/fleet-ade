import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // One row per Beijing date. A day before 08:30 does not write today's key.
  yield* sql`
    CREATE TABLE IF NOT EXISTS pipeline_daily_brief (
      day TEXT PRIMARY KEY
    )
  `;
});

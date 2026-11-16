import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // One automatic retry for the whole run. A later stuck note must not clear it.
  yield* sql`
    ALTER TABLE pipeline_runs ADD COLUMN renewed_once INTEGER NOT NULL DEFAULT 0
  `;
});

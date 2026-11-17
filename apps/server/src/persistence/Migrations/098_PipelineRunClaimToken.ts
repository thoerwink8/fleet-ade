import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Fence for one pipeline claim. Null means the release was settled or this run
  // never stored a token. leaseUntil is not copied here.
  yield* sql`
    ALTER TABLE pipeline_runs ADD COLUMN claim_token TEXT
  `;
});

import * as SqlClient from "effect/sql/SqlClient";
import * as Effect from "effect/Effect";

// Batch commands commit several threads under one receipt; replay returns the recorded per-item outcome.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE orchestration_command_receipts
    ADD COLUMN result TEXT
  `;
});

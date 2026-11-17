import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Reason last announced for a stuck run, and the note shown when it did not arrive.
  yield* sql`ALTER TABLE pipeline_runs ADD COLUMN notified_reason TEXT`;
  yield* sql`ALTER TABLE pipeline_runs ADD COLUMN notify_note TEXT`;
});

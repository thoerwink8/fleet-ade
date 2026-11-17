import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // A failed read is the phrase, and the number stays null. Zero is a real measurement.
  yield* sql`
    ALTER TABLE pipeline_runs ADD COLUMN commit_note TEXT
    CHECK (commit_note IS NULL OR commit_note = '没查成')
  `;
  yield* sql`
    ALTER TABLE pipeline_runs ADD COLUMN ci_queue_note TEXT
    CHECK (ci_queue_note IS NULL OR ci_queue_note = '没查成')
  `;
});

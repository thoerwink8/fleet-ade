import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Review guides and per-file viewed state no longer exist; their tables were never read again. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DROP TABLE IF EXISTS pull_request_files_viewed`;
  yield* sql`DROP TABLE IF EXISTS pull_request_review_guides`;
});

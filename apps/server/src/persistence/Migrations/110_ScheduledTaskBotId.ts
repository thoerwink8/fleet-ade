import * as SqlClient from "effect/sql/SqlClient";
import * as Effect from "effect/Effect";

/**
 * Tasks bind to either a thread or a bot, never both. A bot-bound task resolves
 * its thread at run time, so its `thread_id` is only the record of where the
 * last run went. Rows before this migration keep their thread binding.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN bot_id TEXT`;
});

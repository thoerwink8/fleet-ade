import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE pipeline_runs ADD COLUMN controller_thread_id TEXT`;
  yield* sql`ALTER TABLE pipeline_runs ADD COLUMN accepted_head_sha TEXT`;
  yield* sql`ALTER TABLE pipeline_runs ADD COLUMN controller_verdict TEXT
    CHECK (controller_verdict IS NULL OR controller_verdict IN ('accepted', 'rejected'))`;
  yield* sql`CREATE INDEX idx_pipeline_runs_worker ON pipeline_runs (thread_id)`;
  yield* sql`CREATE INDEX idx_pipeline_runs_controller ON pipeline_runs (controller_thread_id)`;
});

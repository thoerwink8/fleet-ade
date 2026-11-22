import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));

layer("104_DropPullRequestReviewState", (it) => {
  it.effect("drops the review guide and viewed-file tables and keeps the rest", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 103 });
      const tables = () =>
        sql<{ readonly name: string }>`
          SELECT name FROM sqlite_master
          WHERE type = 'table'
            AND name IN ('pull_request_files_viewed', 'pull_request_review_guides', 'pipeline_runs')
          ORDER BY name
        `.pipe(Effect.map((rows) => rows.map((row) => row.name)));
      assert.deepStrictEqual(yield* tables(), [
        "pipeline_runs",
        "pull_request_files_viewed",
        "pull_request_review_guides",
      ]);

      assert.deepStrictEqual(yield* runMigrations(), [[104, "DropPullRequestReviewState"]]);
      assert.deepStrictEqual(yield* tables(), ["pipeline_runs"]);
    }),
  );
});

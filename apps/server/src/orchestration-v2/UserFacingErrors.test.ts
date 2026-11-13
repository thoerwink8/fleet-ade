import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import { SqlError, classifySqliteError } from "effect/sql/SqlError";

import { toPersistenceSqlError } from "../persistence/Errors.ts";
import { userFacingDispatchErrorMessage } from "./UserFacingErrors.ts";

describe("userFacingDispatchErrorMessage", () => {
  it.effect("explains a real database open failure through dispatch and persistence wrappers", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-database-error-" });
      const cause = yield* Effect.void.pipe(
        Effect.provide(
          NodeSqliteClient.layer({ filename: path.join(directory, "missing", "state.sqlite") }),
        ),
        Effect.flip,
      );
      const message = userFacingDispatchErrorMessage({
        message: "Failed to dispatch orchestration command message.dispatch (command-1).",
        cause: toPersistenceSqlError("OrchestrationEventStore.append:query")(cause),
      });

      assert.include(message, "无法打开数据库文件（SQLITE_CANTOPEN）");
      assert.notInclude(message, "Failed to dispatch");
      assert.include(message, "运行服务器的机器");
      assert.include(message, "磁盘空间");
      assert.include(message, "数据和临时目录存在且可写");
      assert.include(message, "然后重试");
      assert.notInclude(message, directory);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("explains a full database and allows a retry after capacity is restored", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE entries (payload BLOB)`;
      yield* sql`PRAGMA max_page_count = 2`;
      const cause = yield* sql`INSERT INTO entries VALUES (zeroblob(16384))`.pipe(Effect.flip);
      const message = userFacingDispatchErrorMessage({ cause });

      assert.include(message, "数据库或磁盘已满（SQLITE_FULL）");
      assert.include(message, "运行服务器的机器上腾出空间，然后重试");
      assert.include(message, "数据库大小限制");

      yield* sql`PRAGMA max_page_count = 100`;
      yield* sql`INSERT INTO entries VALUES (zeroblob(16384))`;
      const rows = yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM entries`;
      assert.equal(rows[0]?.count, 1);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("gives server permission guidance for a real read-only failure", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE entries (payload TEXT)`;
      yield* sql`PRAGMA query_only = ON`;
      const cause = yield* sql`INSERT INTO entries VALUES ('private-message')`.pipe(Effect.flip);
      const message = userFacingDispatchErrorMessage(cause);

      assert.include(message, "数据库是只读的（SQLITE_READONLY）");
      assert.include(message, "数据目录可写");
      assert.notInclude(message, "private-message");
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it("keeps unknown SQL failures contextual without exposing driver text or parameters", () => {
    const cause = Object.assign(new Error("private-query-data"), { errcode: 1 });
    const error = new SqlError({ reason: classifySqliteError(cause) });
    const message = userFacingDispatchErrorMessage({
      cause: toPersistenceSqlError("OrchestrationEventStore.append:query")(error),
    });

    assert.include(message, "无法完成这次数据库请求");
    assert.include(message, "服务器日志");
    assert.notInclude(message, "private-query-data");
  });
});

// @effect-diagnostics nodeBuiltinImport:off
import * as NodeSqlite from "node:sqlite";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { assert, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as CoordinatorTerm from "./coordinatorTerm.ts";

const FLEET = "fleet-1";

const memoryLayer = CoordinatorTerm.layer.pipe(
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);

const open = (filename: string) =>
  Effect.gen(function* () {
    const context = yield* CoordinatorTerm.layer.pipe(
      Layer.provideMerge(NodeSqliteClient.layer({ filename })),
      Layer.build,
    );
    return {
      terms: Context.get(context, CoordinatorTerm.CoordinatorTerm),
      sql: Context.get(context, SqlClient.SqlClient),
    };
  });

const inTransaction = (db: NodeSqlite.DatabaseSync) => {
  try {
    db.exec("BEGIN");
  } catch (cause) {
    return cause instanceof Error && cause.message.includes("transaction");
  }
  db.exec("ROLLBACK");
  return false;
};

const file = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "coordinator-term-" });
  return path.join(directory, "ledger.sqlite");
});

it.effect(
  "同一期望任期的两次 handover 只有一次成功；去掉事务时第二次会在交错写入下破坏唯一性",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const filename = yield* file;
        const holder = new NodeSqlite.DatabaseSync(filename);
        const prepare = NodeSqlite.DatabaseSync.prototype.prepare;
        let committed = false;
        // node:sqlite runs a statement to completion, so Effect.all cannot interleave two handovers.
        // A read that is not inside the write transaction lets the other connection commit first.
        NodeSqlite.DatabaseSync.prototype.prepare = function (sql, ...rest) {
          const statement = prepare.call(this, sql, ...rest);
          if (
            !/from fleet_coordinator_terms/i.test(String(sql)) ||
            /^\s*(update|insert)/i.test(String(sql))
          ) {
            return statement;
          }
          const db = this;
          const flexible = statement as unknown as {
            all: (...args: ReadonlyArray<unknown>) => ReadonlyArray<unknown>;
          };
          const all = flexible.all.bind(statement);
          flexible.all = (...args) => {
            const rows = all(...args);
            if (!committed && rows.length === 0 && !inTransaction(db)) {
              committed = true;
              holder.exec("BEGIN IMMEDIATE");
              holder.exec(
                "INSERT INTO fleet_coordinator_terms (fleet_id, term, coordinator_id) VALUES ('fleet-1', 1, 'coord-b')",
              );
              holder.exec("COMMIT");
            }
            return rows;
          };
          return statement;
        };
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            NodeSqlite.DatabaseSync.prototype.prepare = prepare;
            holder.close();
          }),
        );
        const left = yield* open(filename);
        const right = yield* open(filename);
        const results = yield* Effect.all(
          [left.terms.handover(FLEET, "coord-a", 0), right.terms.handover(FLEET, "coord-b", 0)],
          { concurrency: "unbounded" },
        );
        expect(results.map((result) => result._tag).toSorted()).toEqual(["current", "stale"]);
        const handed = results.find((result) => result._tag === "current");
        const stale = results.find((result) => result._tag === "stale");
        assert(handed?._tag === "current");
        assert(stale?._tag === "stale");
        expect(handed).toEqual({ _tag: "current", term: 1, coordinatorId: "coord-a" });
        expect(stale).toEqual({ _tag: "stale", term: 1, coordinatorId: "coord-a" });
        expect(yield* left.terms.read(FLEET)).toEqual({ term: 1, coordinatorId: "coord-a" });
        expect(yield* left.sql`SELECT term, coordinator_id FROM fleet_coordinator_terms`).toEqual([
          { term: 1, coordinator_id: "coord-a" },
        ]);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("observe 更小任期是 stale 且库不变，更大则采纳，同任期按协调者 ID 字典序收敛", () =>
  Effect.gen(function* () {
    const terms = yield* CoordinatorTerm.CoordinatorTerm;
    const sql = yield* SqlClient.SqlClient;
    expect(yield* terms.read(FLEET)).toEqual({ term: 0, coordinatorId: null });
    expect(yield* terms.observe(FLEET, 0, "coord-a")).toEqual(
      CoordinatorTerm.ObserveResult.stale({ term: 0, coordinatorId: null }),
    );
    expect(yield* sql`SELECT fleet_id, term, coordinator_id FROM fleet_coordinator_terms`).toEqual(
      [],
    );

    expect(yield* terms.observe(FLEET, 3, "coord-a")).toEqual(
      CoordinatorTerm.ObserveResult.current({ term: 3, coordinatorId: "coord-a" }),
    );
    const stored = yield* sql<{
      readonly term: number;
      readonly coordinator_id: string;
    }>`SELECT term, coordinator_id FROM fleet_coordinator_terms`;
    expect(stored).toEqual([{ term: 3, coordinator_id: "coord-a" }]);

    expect(yield* terms.observe(FLEET, 3, "coord-a")).toEqual(
      CoordinatorTerm.ObserveResult.current({ term: 3, coordinatorId: "coord-a" }),
    );
    expect(yield* terms.observe(FLEET, 1, "coord-b")).toEqual(
      CoordinatorTerm.ObserveResult.stale({ term: 3, coordinatorId: "coord-a" }),
    );
    expect(yield* terms.observe(FLEET, 3, "coord-0")).toEqual(
      CoordinatorTerm.ObserveResult.stale({ term: 3, coordinatorId: "coord-a" }),
    );
    expect(yield* sql`SELECT term, coordinator_id FROM fleet_coordinator_terms`).toEqual(stored);
    expect(yield* terms.observe(FLEET, 3, "coord-c")).toEqual(
      CoordinatorTerm.ObserveResult.current({ term: 3, coordinatorId: "coord-c" }),
    );
    expect(yield* sql`SELECT term, coordinator_id FROM fleet_coordinator_terms`).toEqual([
      { term: 3, coordinator_id: "coord-c" },
    ]);
    expect(yield* terms.observe(FLEET, 3, "coord-b")).toEqual(
      CoordinatorTerm.ObserveResult.stale({ term: 3, coordinatorId: "coord-c" }),
    );
    expect(yield* terms.observe(FLEET, 4, "coord-a")).toEqual(
      CoordinatorTerm.ObserveResult.current({ term: 4, coordinatorId: "coord-a" }),
    );
    expect(yield* terms.read(FLEET)).toEqual({ term: 4, coordinatorId: "coord-a" });
    yield* sql`UPDATE fleet_coordinator_terms SET term = 0, coordinator_id = 'coord-z' WHERE fleet_id = ${FLEET}`;
    expect(yield* terms.observe(FLEET, 0, "coord-a")).toEqual(
      CoordinatorTerm.ObserveResult.stale({ term: 0, coordinatorId: "coord-z" }),
    );
    expect(yield* sql`SELECT term, coordinator_id FROM fleet_coordinator_terms`).toEqual([
      { term: 0, coordinator_id: "coord-z" },
    ]);
  }).pipe(Effect.provide(memoryLayer)),
);

it.effect("关掉数据库再用同一文件重开，read 仍是最大任期和对应协调者", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const filename = yield* file;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const { terms, sql } = yield* open(filename);
          expect(yield* terms.handover(FLEET, "coord-a", 0)).toEqual(
            CoordinatorTerm.HandoverResult.current({ term: 1, coordinatorId: "coord-a" }),
          );
          expect(yield* terms.handover(FLEET, "coord-c", 0)).toEqual(
            CoordinatorTerm.HandoverResult.stale({ term: 1, coordinatorId: "coord-a" }),
          );
          expect(yield* terms.observe(FLEET, 4, "coord-b")).toEqual(
            CoordinatorTerm.ObserveResult.current({ term: 4, coordinatorId: "coord-b" }),
          );
          expect(yield* terms.observe(FLEET, 2, "coord-c")).toEqual(
            CoordinatorTerm.ObserveResult.stale({ term: 4, coordinatorId: "coord-b" }),
          );
          expect(yield* sql`SELECT term, coordinator_id FROM fleet_coordinator_terms`).toEqual([
            { term: 4, coordinator_id: "coord-b" },
          ]);
        }),
      );
      const { terms } = yield* open(filename);
      expect(yield* terms.read(FLEET)).toEqual({ term: 4, coordinatorId: "coord-b" });
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

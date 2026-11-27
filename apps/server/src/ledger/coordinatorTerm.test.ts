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

const file = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "coordinator-term-" });
  return path.join(directory, "ledger.sqlite");
});

it.effect("两个并发 handover 用同一个 expectedTerm，只有一个成功", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const filename = yield* file;
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
      expect(handed.term).toBe(1);
      expect(handed.coordinatorId === "coord-a" || handed.coordinatorId === "coord-b").toBe(true);
      expect(stale).toEqual({
        _tag: "stale",
        term: handed.term,
        coordinatorId: handed.coordinatorId,
      });
      const stored = { term: handed.term, coordinatorId: handed.coordinatorId };
      expect(yield* left.terms.read(FLEET)).toEqual(stored);
      expect(yield* right.terms.read(FLEET)).toEqual(stored);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("observe 更小任期是 stale 且库不变，更大则采纳，同任期不同协调者是 conflict", () =>
  Effect.gen(function* () {
    const terms = yield* CoordinatorTerm.CoordinatorTerm;
    const sql = yield* SqlClient.SqlClient;
    expect(yield* terms.read(FLEET)).toEqual({ term: 0, coordinatorId: null });
    expect(yield* terms.observe(FLEET, 0, "coord-a")).toEqual(
      CoordinatorTerm.ObserveResult.conflict({ term: 0, coordinatorId: null }),
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
    expect(yield* terms.observe(FLEET, 3, "coord-c")).toEqual(
      CoordinatorTerm.ObserveResult.conflict({ term: 3, coordinatorId: "coord-a" }),
    );
    expect(yield* sql`SELECT term, coordinator_id FROM fleet_coordinator_terms`).toEqual(stored);
    expect(yield* terms.read(FLEET)).toEqual({ term: 3, coordinatorId: "coord-a" });
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

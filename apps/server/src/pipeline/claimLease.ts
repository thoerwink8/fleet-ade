import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as NodeClaims from "../ledger/nodeClaims.ts";
import * as NodeReads from "../ledger/nodeReads.ts";

/** The pipeline's holder id. A node token's id is a different holder. */
const PIPELINE_CLAIMED_BY = "pipeline";

export type ClaimWrite = NodeClaims.ClaimRequest & { readonly leaseUntil: string };

export type ClaimResult =
  | { readonly status: 200; readonly code: "ok"; readonly leaseUntil: string }
  | { readonly status: 404; readonly code: "unknown_repo" }
  | { readonly status: 409; readonly code: "engine_has_it" | "not_claimed" }
  | { readonly status: 503; readonly code: "local_claims_not_wired" | "local_claims_unreadable" };

export interface ClaimAttempt {
  readonly write: ClaimWrite;
  readonly result: ClaimResult;
}

export interface ClaimLease {
  readonly apply: (write: ClaimWrite) => Effect.Effect<ClaimResult>;
  readonly attempts: Effect.Effect<ReadonlyArray<ClaimAttempt>>;
}

export class ClaimLeasePort extends Context.Service<ClaimLeasePort, ClaimLease>()(
  "t3/pipeline/claimLease/ClaimLeasePort",
) {}

export const claimForRun = Effect.fn("claimLease.claimForRun")(function* (
  port: ClaimLease,
  input: { readonly repo: string; readonly issue: number; readonly title: string },
) {
  const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
  return yield* port.apply({
    action: "claim",
    repo: input.repo,
    issue: input.issue,
    title: input.title,
    leaseUntil: NodeClaims.leaseUntilFrom(nowMs),
  });
});

/** A finished run must be claimable again. Finish matches the holder and expiry this run wrote. */
export const releaseClaim = Effect.fn("claimLease.releaseClaim")(function* (
  port: ClaimLease,
  input: { readonly repo: string; readonly issue: number; readonly leaseUntil: string },
) {
  yield* port.apply({
    action: "finish",
    repo: input.repo,
    issue: input.issue,
    outcome: "released",
    leaseUntil: input.leaseUntil,
  });
});

const unavailable: ClaimResult = { status: 503, code: "local_claims_unreadable" };

const writer = (sql: SqlClient.SqlClient) =>
  Effect.fn("claimLease.apply")(function* (write: ClaimWrite) {
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    return yield* NodeClaims.apply(sql, { ...write, claimedBy: PIPELINE_CLAIMED_BY }, nowMs).pipe(
      Effect.map((outcome) =>
        outcome.status === 200
          ? ({ status: 200, code: "ok", leaseUntil: write.leaseUntil } as const)
          : outcome.code === "unknown_repo"
            ? ({ status: 404, code: "unknown_repo" } as const)
            : ({ status: 409, code: "engine_has_it" } as const),
      ),
      Effect.catchCause(() => Effect.succeed(unavailable)),
    );
  });

/** Test double. `repos` replaces the ledger's repos table; `wired: false` is the unmounted port. */
export const layerPort = (options?: {
  readonly repos?: ReadonlyArray<string>;
  readonly wired?: boolean;
}) =>
  Layer.effect(
    ClaimLeasePort,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* NodeReads.migrate;
      for (const repo of options?.repos ?? []) {
        const [owner, name] = repo.split("/");
        if (owner === undefined || name === undefined) continue;
        yield* sql`INSERT OR IGNORE INTO repos (owner, name) VALUES (${owner}, ${name})`;
      }
      const seen = yield* Ref.make<ReadonlyArray<ClaimAttempt>>([]);
      const record = Effect.fn("claimLease.apply")(function* (write: ClaimWrite) {
        const result =
          options?.wired === false
            ? ({ status: 503, code: "local_claims_not_wired" } as const)
            : yield* writer(sql)(write);
        yield* Ref.set(seen, [{ write, result }]);
        return result;
      });
      return ClaimLeasePort.of({ apply: record, attempts: Ref.get(seen) });
    }),
  );
/** Production: the pipeline and POST /api/nodes/claims open the same ledger file and the same writer. */
export const layerLive = Layer.unwrap(
  Effect.gen(function* () {
    const { stateDir } = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    return Layer.effect(
      ClaimLeasePort,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* NodeReads.migrate;
        return ClaimLeasePort.of({ apply: writer(sql), attempts: Effect.succeed([]) });
      }),
    ).pipe(
      Layer.provide(NodeSqliteClient.layer({ filename: path.join(stateDir, "ledger.sqlite") })),
    );
  }),
);

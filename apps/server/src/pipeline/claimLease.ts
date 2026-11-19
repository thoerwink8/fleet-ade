import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";

import * as ServerConfig from "../config.ts";
import * as NodeClaims from "../ledger/nodeClaims.ts";
import * as NodeReads from "../ledger/nodeReads.ts";

/** The pipeline's holder id. A node token's id is a different holder. */
const PIPELINE_CLAIMED_BY = "pipeline";

export type ClaimWrite =
  | (Extract<NodeClaims.ClaimRequest, { readonly action: "claim" }> & {
      readonly leaseUntil: string;
      readonly token: string;
    })
  | (Extract<NodeClaims.ClaimRequest, { readonly action: "renew" }> & {
      readonly leaseUntil: string;
    })
  | (Extract<NodeClaims.ClaimRequest, { readonly action: "finish" }> & {
      readonly token: string;
    });

export type ClaimResult =
  | { readonly status: 200; readonly code: "ok"; readonly leaseUntil: string | null }
  | { readonly status: 404; readonly code: "unknown_repo" }
  | { readonly status: 409; readonly code: "engine_has_it" | "not_claimed" }
  | { readonly status: 503; readonly code: "local_claims_not_wired" | "local_claims_unreadable" };

export interface ClaimAttempt {
  readonly write: ClaimWrite;
  readonly result: ClaimResult;
}

export interface ClaimLease {
  readonly apply: (write: ClaimWrite) => Effect.Effect<ClaimResult>;
  /** The ledger's repo registry follows the pipeline's repo whitelist. */
  readonly register: (repos: ReadonlyArray<string>) => Effect.Effect<void, SqlError.SqlError>;
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
  const token = SecureRandom.uuidV4Unsafe();
  const result = yield* port.apply({
    action: "claim",
    repo: input.repo,
    issue: input.issue,
    title: input.title,
    leaseUntil: NodeClaims.leaseUntilFrom(nowMs),
    token,
  });
  if (result.status !== 200) return result;
  return { ...result, token };
});

/** Finish deletes by holder and this run's token. Expiry is not part of the release. */
export const releaseClaim = Effect.fn("claimLease.releaseClaim")(function* (
  port: ClaimLease,
  input: { readonly repo: string; readonly issue: number; readonly token: string },
) {
  return yield* port.apply({
    action: "finish",
    repo: input.repo,
    issue: input.issue,
    outcome: "released",
    token: input.token,
  });
});

const unavailable: ClaimResult = { status: 503, code: "local_claims_unreadable" };

const writer = (sql: SqlClient.SqlClient) =>
  Effect.fn("claimLease.apply")(function* (write: ClaimWrite) {
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    const claimedBy = PIPELINE_CLAIMED_BY;
    const input: NodeClaims.ClaimInput =
      write.action === "claim"
        ? {
            action: "claim",
            repo: write.repo,
            issue: write.issue,
            title: write.title,
            claimedBy,
            leaseUntil: write.leaseUntil,
            ...(write.token === undefined ? {} : { token: write.token }),
          }
        : write.action === "renew"
          ? {
              action: "renew",
              repo: write.repo,
              issue: write.issue,
              claimedBy,
              leaseUntil: write.leaseUntil,
            }
          : {
              action: "finish",
              repo: write.repo,
              issue: write.issue,
              outcome: write.outcome,
              reason: write.reason,
              claimedBy,
              token: write.token,
            };
    return yield* NodeClaims.apply(sql, input, nowMs).pipe(
      Effect.map((outcome) =>
        outcome.status === 200
          ? ({
              status: 200,
              code: "ok",
              leaseUntil: outcome.leaseUntil,
            } as const)
          : outcome.code === "unknown_repo"
            ? ({ status: 404, code: "unknown_repo" } as const)
            : outcome.code === "not_claimed"
              ? ({ status: 409, code: "not_claimed" } as const)
              : ({ status: 409, code: "engine_has_it" } as const),
      ),
      Effect.catchTags({
        SqlError: (cause) =>
          Effect.logError("Failed to read local claims", cause).pipe(Effect.as(unavailable)),
      }),
    );
  });
/** Node claims and notes check the ledger's registry, so it has to hold the repos the pipeline serves. */
export const registerRepos = Effect.fn("claimLease.registerRepos")(function* (
  sql: SqlClient.SqlClient,
  repos: ReadonlyArray<string>,
) {
  for (const repo of repos) {
    const [owner, name] = repo.split("/");
    if (owner === undefined || name === undefined) continue;
    yield* sql`INSERT OR IGNORE INTO repos (owner, name) VALUES (${owner}, ${name})`;
  }
});

/** Test double. `wired: false` is the unmounted port. */
export const layerPort = (options?: { readonly wired?: boolean }) =>
  Layer.effect(
    ClaimLeasePort,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* NodeReads.migrate;
      const seen = yield* Ref.make<ReadonlyArray<ClaimAttempt>>([]);
      const record = Effect.fn("claimLease.apply")(function* (write: ClaimWrite) {
        const result =
          options?.wired === false
            ? ({ status: 503, code: "local_claims_not_wired" } as const)
            : yield* writer(sql)(write);
        yield* Ref.set(seen, [{ write, result }]);
        return result;
      });
      return ClaimLeasePort.of({
        apply: record,
        register: Effect.fn("ClaimLeasePort.register")((repos) => registerRepos(sql, repos)),
        attempts: Ref.get(seen),
      });
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
        return ClaimLeasePort.of({
          apply: writer(sql),
          register: Effect.fn("ClaimLeasePort.register")((repos) => registerRepos(sql, repos)),
          attempts: Effect.succeed([]),
        });
      }),
    ).pipe(
      Layer.provide(NodeSqliteClient.layer({ filename: path.join(stateDir, "ledger.sqlite") })),
    );
  }),
);

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as NodeReads from "../ledger/nodeReads.ts";

/** Same duration as POST /api/nodes/claims. */
const LOCAL_LEASE_MS = 2 * 60 * 60_000;

export interface ClaimWrite {
  readonly action: "claim" | "release";
  readonly repo: string;
  readonly issue: number;
  readonly title: string;
  readonly leaseUntil: string;
}

export type ClaimResult =
  | { readonly status: 200; readonly code: "ok"; readonly leaseUntil: string }
  | { readonly status: 404; readonly code: "unknown_repo" }
  | { readonly status: 409; readonly code: "engine_has_it" }
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
  const leaseUntil = DateTime.formatIso(
    DateTime.add(yield* DateTime.now, { milliseconds: LOCAL_LEASE_MS }),
  );
  return yield* port.apply({
    action: "claim",
    repo: input.repo,
    issue: input.issue,
    title: input.title,
    leaseUntil,
  });
});

const CLAIMED_BY = "local";

const leaseHeld = (leaseUntil: string, nowMs: number) => {
  const until = Date.parse(leaseUntil);
  return Number.isNaN(until) || until > nowMs;
};

/** A finished run must be claimable again; the old lease otherwise blocks it. */
export const releaseClaim = Effect.fn("claimLease.releaseClaim")(function* (
  port: ClaimLease,
  input: { readonly repo: string; readonly issue: number },
) {
  yield* port.apply({
    action: "release",
    repo: input.repo,
    issue: input.issue,
    title: "",
    leaseUntil: "1970-01-01T00:00:00.000Z",
  });
});

const unavailable: ClaimResult = { status: 503, code: "local_claims_unreadable" };

export const layerPort = (options?: {
  readonly repos?: ReadonlyArray<string>;
  readonly wired?: boolean;
}) =>
  Layer.effect(
    ClaimLeasePort,
    Effect.gen(function* () {
      const repos =
        options?.repos === undefined
          ? undefined
          : new Set(options.repos.map((repo) => repo.toLowerCase()));
      const wired = options?.wired ?? true;
      const seen = yield* Ref.make<ReadonlyArray<ClaimAttempt>>([]);
      const sql = yield* SqlClient.SqlClient;
      if (wired) yield* NodeReads.migrate;
      const apply = Effect.fn("claimLease.apply")(function* (write: ClaimWrite) {
        const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
        const attempt = sql.withTransaction(
          Effect.gen(function* () {
            const [owner, name] = write.repo.split("/");
            const registered =
              repos === undefined
                ? (yield* sql`SELECT owner FROM repos
                WHERE lower(owner) = lower(${owner}) AND lower(name) = lower(${name}) LIMIT 1`)
                    .length > 0
                : repos.has(write.repo.toLowerCase());
            if (!registered) return { status: 404, code: "unknown_repo" } as const;
            if (write.action === "release") {
              yield* sql`DELETE FROM node_claims
                WHERE lower(repo) = lower(${write.repo}) AND issue = ${write.issue}`;
              return { status: 200, code: "ok", leaseUntil: write.leaseUntil } as const;
            }
            const held = yield* sql<{ readonly leaseUntil: string }>`
            SELECT lease_until AS leaseUntil FROM node_claims
            WHERE lower(repo) = lower(${write.repo}) AND issue = ${write.issue}
          `;
            if (held.some((row) => leaseHeld(row.leaseUntil, nowMs))) {
              return { status: 409, code: "engine_has_it" } as const;
            }
            yield* sql`DELETE FROM node_claims
            WHERE lower(repo) = lower(${write.repo}) AND issue = ${write.issue}`;
            yield* sql`INSERT INTO node_claims
            (repo, issue, claimed_by, lease_until, executor, state, fencing)
            VALUES (${write.repo}, ${write.issue}, ${CLAIMED_BY}, ${write.leaseUntil}, 'local', 'running', NULL)`;
            return { status: 200, code: "ok", leaseUntil: write.leaseUntil } as const;
          }),
        );
        const result: ClaimResult = wired
          ? yield* attempt.pipe(Effect.catchCause(() => Effect.succeed(unavailable)))
          : { status: 503, code: "local_claims_not_wired" };
        yield* Ref.update(seen, (rows) => [...rows, { write, result }]);
        return result;
      });
      return ClaimLeasePort.of({ apply, attempts: Ref.get(seen) });
    }),
  );

export const layerLive = Layer.unwrap(
  Effect.gen(function* () {
    const { stateDir } = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    return layerPort().pipe(
      Layer.provide(NodeSqliteClient.layer({ filename: path.join(stateDir, "ledger.sqlite") })),
    );
  }),
);

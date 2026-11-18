import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeReads from "./nodeReads.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as ServerConfig from "../config.ts";
// @effect-diagnostics nodeBuiltinImport:off -- joins the ledger file under the state directory.
import * as NodePath from "node:path";
import {
  FleetClaim,
  FleetClaimClaimInput,
  FleetClaimClaimResult,
  FleetClaimsError,
  FleetClaimKey,
  FleetClaimLeaseInput,
  FleetClaimLeaseResult,
} from "@t3tools/contracts";

interface ClaimRow {
  readonly fleet_id: string;
  readonly repo: string;
  readonly issue: number;
  readonly task_id: string;
  readonly claimed_by: string;
  readonly lease_until: string;
  readonly attempt: number;
  readonly fencing: string;
  readonly idempotency_key: string | null;
}

const isFleetClaimsError = Schema.is(FleetClaimsError);

const LEASE_MS = 90_000;

export class FleetClaims extends Context.Service<
  FleetClaims,
  {
    readonly claim: (
      input: FleetClaimClaimInput,
    ) => Effect.Effect<FleetClaimClaimResult, FleetClaimsError>;
    readonly renew: (
      input: FleetClaimLeaseInput,
    ) => Effect.Effect<FleetClaimLeaseResult, FleetClaimsError>;
    readonly release: (
      input: FleetClaimLeaseInput,
    ) => Effect.Effect<FleetClaimLeaseResult, FleetClaimsError>;
  }
>()("t3/ledger/FleetClaims") {}
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const random = yield* SecureRandom.SecureRandom;
  yield* NodeReads.migrate;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(node_claims)`;
  const columnNames = new Set(columns.map((column) => column.name));
  if (!columnNames.has("fleet_id"))
    yield* sql`ALTER TABLE node_claims ADD COLUMN fleet_id TEXT NOT NULL DEFAULT 'legacy'`;
  if (!columnNames.has("task_id"))
    yield* sql`ALTER TABLE node_claims ADD COLUMN task_id TEXT NOT NULL DEFAULT 'root'`;
  if (!columnNames.has("attempt"))
    yield* sql`ALTER TABLE node_claims ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1`;
  if (!columnNames.has("idempotency_key"))
    yield* sql`ALTER TABLE node_claims ADD COLUMN idempotency_key TEXT`;
  yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_node_claims_fleet_key ON node_claims (fleet_id, repo, issue, task_id)`;
  const error = (cause: unknown) =>
    new FleetClaimsError({
      reason: "storage",
      message: "Fleet claims storage is unavailable.",
      cause,
    });
  const read = (key: FleetClaimKey) =>
    sql<ClaimRow>`SELECT fleet_id, repo, issue, task_id, claimed_by, lease_until, attempt, fencing, idempotency_key FROM node_claims WHERE fleet_id = ${key.fleetId} AND repo = ${key.repo} AND issue = ${key.issue} AND task_id = ${key.taskId}`.pipe(
      Effect.mapError(error),
    );
  const registered = (repo: string) => {
    const [owner, name] = repo.split("/");
    return sql`SELECT 1 FROM repos WHERE owner = ${owner} AND name = ${name} LIMIT 1`.pipe(
      Effect.mapError(error),
      Effect.map((rows) => rows.length > 0),
    );
  };
  const toClaim = (row: ClaimRow): FleetClaim => ({
    fleetId: row.fleet_id,
    repo: row.repo,
    issue: row.issue,
    taskId: row.task_id,
    holder: row.claimed_by,
    attempt: row.attempt,
    fencing: row.fencing,
    leaseUntil: row.lease_until,
  });
  const claim = Effect.fn("FleetClaims.claim")(function* (input: FleetClaimClaimInput) {
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const leaseUntil = DateTime.formatIso(DateTime.makeUnsafe(now + LEASE_MS));
    const fence = yield* random.randomBytes(16).pipe(
      Effect.map((bytes) => Buffer.from(bytes).toString("hex")),
      Effect.mapError(error),
    );
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          if (!(yield* registered(input.repo))) {
            return yield* new FleetClaimsError({
              reason: "unknown-repo",
              message: "The repository is not registered for this environment.",
            });
          }
          const current = (yield* read(input))[0];
          if (current !== undefined && Date.parse(current.lease_until) > now) {
            if (
              current.claimed_by === input.holder &&
              current.idempotency_key === input.idempotencyKey
            ) {
              return { outcome: "claimed" as const, claim: toClaim(current) };
            }
            return { outcome: "already-held" as const, claim: null };
          }
          const attempt = (current?.attempt ?? 0) + 1;
          yield* sql`INSERT INTO node_claims (fleet_id, repo, issue, task_id, claimed_by, lease_until, executor, state, fencing, attempt, idempotency_key) VALUES (${input.fleetId}, ${input.repo}, ${input.issue}, ${input.taskId}, ${input.holder}, ${leaseUntil}, 'fleet', 'running', ${fence}, ${attempt}, ${input.idempotencyKey}) ON CONFLICT(fleet_id, repo, issue, task_id) DO UPDATE SET claimed_by = excluded.claimed_by, lease_until = excluded.lease_until, executor = excluded.executor, state = excluded.state, fencing = excluded.fencing, attempt = excluded.attempt, idempotency_key = excluded.idempotency_key`;
          return {
            outcome: "claimed" as const,
            claim: toClaim({
              fleet_id: input.fleetId,
              repo: input.repo,
              issue: input.issue,
              task_id: input.taskId,
              claimed_by: input.holder,
              lease_until: leaseUntil,
              attempt,
              fencing: fence,
              idempotency_key: input.idempotencyKey,
            }),
          };
        }),
      )
      .pipe(Effect.mapError((cause) => (isFleetClaimsError(cause) ? cause : error(cause))));
  });
  const renew = Effect.fn("FleetClaims.renew")(function* (input: FleetClaimLeaseInput) {
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const leaseUntil = DateTime.formatIso(DateTime.makeUnsafe(now + LEASE_MS));
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const current = (yield* read(input))[0];
          if (
            current === undefined ||
            current.claimed_by !== input.holder ||
            current.attempt !== input.attempt ||
            current.fencing !== input.fencing ||
            Date.parse(current.lease_until) <= now
          ) {
            return { outcome: "stale" as const, claim: null };
          }
          yield* sql`UPDATE node_claims SET lease_until = ${leaseUntil} WHERE fleet_id = ${input.fleetId} AND repo = ${input.repo} AND issue = ${input.issue} AND task_id = ${input.taskId} AND attempt = ${input.attempt} AND fencing = ${input.fencing}`;
          return {
            outcome: "renewed" as const,
            claim: toClaim({ ...current, lease_until: leaseUntil }),
          };
        }),
      )
      .pipe(Effect.mapError(error));
  });
  const release = Effect.fn("FleetClaims.release")(function* (input: FleetClaimLeaseInput) {
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const current = (yield* read(input))[0];
          if (
            current === undefined ||
            current.claimed_by !== input.holder ||
            current.attempt !== input.attempt ||
            current.fencing !== input.fencing
          ) {
            return { outcome: "stale" as const, claim: null };
          }
          yield* sql`DELETE FROM node_claims WHERE fleet_id = ${input.fleetId} AND repo = ${input.repo} AND issue = ${input.issue} AND task_id = ${input.taskId} AND attempt = ${input.attempt} AND fencing = ${input.fencing}`;
          return { outcome: "released" as const, claim: null };
        }),
      )
      .pipe(Effect.mapError(error));
  });
  return FleetClaims.of({ claim, renew, release });
});

export const layer = Layer.unwrap(
  Effect.map(ServerConfig.ServerConfig, ({ stateDir }) =>
    Layer.effect(FleetClaims, make).pipe(
      Layer.provide(SecureRandom.layerWebCrypto),
      Layer.provide(NodeSqliteClient.layer({ filename: NodePath.join(stateDir, "ledger.sqlite") })),
    ),
  ),
);

export const layerForTest = Layer.effect(FleetClaims, make).pipe(
  Layer.provide(SecureRandom.layerWebCrypto),
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);

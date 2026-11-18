import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  EnvironmentId,
  FLEET_LEASE_TTL_MS,
  FleetClaim,
  FleetClaimClaimInput,
  FleetClaimClaimResult,
  FleetClaimHeartbeatInput,
  FleetClaimHeartbeatItemResult,
  FleetClaimHeartbeatResult,
  FleetClaimsError,
  FleetClaimKey,
  FleetClaimLeaseInput,
  FleetClaimLeaseResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
// @effect-diagnostics nodeBuiltinImport:off -- joins the ledger file under the state directory.
import * as NodePath from "node:path";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as NodeClaims from "./nodeClaims.ts";
import * as NodeReads from "./nodeReads.ts";

interface ClaimRow {
  readonly fleet_id: string;
  readonly repo: string;
  readonly issue: number;
  readonly task_id: string;
  readonly claimed_by: string;
  readonly holder_environment: string | null;
  readonly lease_until: string;
  readonly attempt: number;
  readonly fencing: string | null;
  readonly state: string | null;
  readonly claim_idempotency_key: string | null;
  readonly renew_idempotency_key: string | null;
  readonly renew_lease_until: string | null;
  readonly release_idempotency_key: string | null;
}

/** Session is who called. Environment is the machine, and renewal trusts only that. */
export interface FleetCaller {
  readonly sessionId: string;
  readonly environmentId: string;
}

export class FleetClaims extends Context.Service<
  FleetClaims,
  {
    readonly claim: (
      caller: FleetCaller,
      input: FleetClaimClaimInput,
    ) => Effect.Effect<FleetClaimClaimResult, FleetClaimsError>;
    readonly renew: (
      caller: FleetCaller,
      input: FleetClaimLeaseInput,
    ) => Effect.Effect<FleetClaimLeaseResult, FleetClaimsError>;
    readonly release: (
      caller: FleetCaller,
      input: FleetClaimLeaseInput,
    ) => Effect.Effect<FleetClaimLeaseResult, FleetClaimsError>;
    readonly heartbeat: (
      environmentId: string,
      input: FleetClaimHeartbeatInput,
    ) => Effect.Effect<FleetClaimHeartbeatResult, FleetClaimsError>;
    readonly revoke: (environmentId: string) => Effect.Effect<void, FleetClaimsError>;
  }
>()("t3/ledger/FleetClaims") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const environment = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const fleetId = yield* environment.getEnvironmentId;
  yield* NodeReads.migrate;

  const storageError = (cause: unknown) =>
    new FleetClaimsError({
      reason: "storage",
      message: "Fleet claims storage is unavailable.",
      cause,
    });
  const canonicalRepo = Effect.fn("FleetClaims.canonicalRepo")(function* (repo: string) {
    if (!NodeClaims.REPO.test(repo)) {
      return yield* new FleetClaimsError({
        reason: "unknown-repo",
        message: "The repository is not registered for this environment.",
      });
    }
    const [owner, name] = repo.split("/");
    const rows = yield* sql<{ readonly owner: string; readonly name: string }>`
      SELECT owner, name FROM repos
      WHERE lower(owner) = lower(${owner}) AND lower(name) = lower(${name})
      LIMIT 1
    `.pipe(Effect.mapError(storageError));
    const registered = rows[0];
    if (registered === undefined) {
      return yield* new FleetClaimsError({
        reason: "unknown-repo",
        message: "The repository is not registered for this environment.",
      });
    }
    return `${registered.owner}/${registered.name}`;
  });
  const read = (key: FleetClaimKey) =>
    sql<ClaimRow>`
      SELECT fleet_id, repo, issue, task_id, claimed_by, holder_environment, lease_until, attempt,
        fencing, state, claim_idempotency_key, renew_idempotency_key, renew_lease_until,
        release_idempotency_key
      FROM node_claims
      WHERE repo = ${key.repo} AND issue = ${key.issue} AND task_id = ${key.taskId}
    `.pipe(Effect.mapError(storageError));
  const toClaim = (row: ClaimRow): FleetClaim => ({
    fleetId: row.fleet_id,
    repo: row.repo,
    issue: row.issue,
    taskId: row.task_id,
    holder: row.claimed_by,
    attempt: row.attempt,
    fencing: row.fencing ?? String(row.attempt),
    leaseUntil: row.lease_until,
    ...(row.holder_environment === null ? {} : { holderEnvironment: row.holder_environment }),
  });
  const sameEnvironment = (row: ClaimRow, caller: FleetCaller) =>
    row.holder_environment === caller.environmentId ||
    (row.holder_environment === null && row.claimed_by === caller.sessionId);
  const itemResult = (
    item: {
      readonly repo: string;
      readonly issue: number;
      readonly taskId: string;
      readonly attempt: number;
      readonly fencing: string;
    },
    outcome: FleetClaimHeartbeatItemResult["outcome"],
    claim: FleetClaim | null,
  ): FleetClaimHeartbeatItemResult => ({
    repo: item.repo,
    issue: item.issue,
    taskId: item.taskId,
    attempt: item.attempt,
    outcome,
    claim,
  });

  const claim = Effect.fn("FleetClaims.claim")(function* (
    caller: FleetCaller,
    input: FleetClaimClaimInput,
  ) {
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const leaseUntil = DateTime.formatIso(DateTime.makeUnsafe(now + FLEET_LEASE_TTL_MS));
    const repo = yield* canonicalRepo(input.repo);
    const key = { ...input, repo };
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const current = (yield* read(key))[0];
          const active =
            current !== undefined &&
            current.state === "running" &&
            Date.parse(current.lease_until) > now;
          if (
            current !== undefined &&
            sameEnvironment(current, caller) &&
            current.claim_idempotency_key === input.idempotencyKey
          ) {
            return active
              ? { outcome: "claimed" as const, claim: toClaim(current) }
              : { outcome: "stale" as const, claim: null };
          }
          if (active) {
            return {
              outcome: "already-held" as const,
              claim: sameEnvironment(current, caller) ? toClaim(current) : null,
            };
          }
          const attempt = (current?.attempt ?? 0) + 1;
          const fencing = String(attempt);
          yield* sql`
            INSERT INTO node_claims (
              fleet_id, repo, issue, task_id, claimed_by, holder_environment, lease_until, executor,
              state, fencing, attempt, claim_idempotency_key, renew_idempotency_key,
              renew_lease_until, release_idempotency_key
            ) VALUES (
              ${fleetId}, ${repo}, ${input.issue}, ${input.taskId}, ${caller.sessionId},
              ${caller.environmentId}, ${leaseUntil}, 'fleet', 'running', ${fencing}, ${attempt},
              ${input.idempotencyKey}, NULL, NULL, NULL
            ) ON CONFLICT(repo, issue, task_id) DO UPDATE SET
              fleet_id = excluded.fleet_id, claimed_by = excluded.claimed_by,
              holder_environment = excluded.holder_environment,
              lease_until = excluded.lease_until, executor = excluded.executor,
              state = excluded.state, fencing = excluded.fencing, attempt = excluded.attempt,
              claim_idempotency_key = excluded.claim_idempotency_key,
              renew_idempotency_key = NULL, renew_lease_until = NULL, release_idempotency_key = NULL
          `;
          return {
            outcome: "claimed" as const,
            claim: {
              fleetId,
              repo,
              issue: input.issue,
              taskId: input.taskId,
              holder: caller.sessionId,
              holderEnvironment: caller.environmentId,
              attempt,
              fencing,
              leaseUntil,
            },
          };
        }),
      )
      .pipe(Effect.mapError(storageError));
  });

  const renew = Effect.fn("FleetClaims.renew")(function* (
    caller: FleetCaller,
    input: FleetClaimLeaseInput,
  ) {
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const leaseUntil = DateTime.formatIso(DateTime.makeUnsafe(now + FLEET_LEASE_TTL_MS));
    const repo = yield* canonicalRepo(input.repo);
    const key = { ...input, repo };
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const current = (yield* read(key))[0];
          const matches =
            current !== undefined &&
            sameEnvironment(current, caller) &&
            current.attempt === input.attempt &&
            current.fencing === input.fencing;
          const active =
            matches && current.state === "running" && Date.parse(current.lease_until) > now;
          if (!active || current === undefined) return { outcome: "stale" as const, claim: null };
          if (
            current.renew_idempotency_key === input.idempotencyKey &&
            current.renew_lease_until !== null
          ) {
            return {
              outcome: "renewed" as const,
              claim: toClaim({ ...current, lease_until: current.renew_lease_until }),
            };
          }
          yield* sql`
            UPDATE node_claims SET lease_until = ${leaseUntil},
              renew_idempotency_key = ${input.idempotencyKey}, renew_lease_until = ${leaseUntil}
            WHERE repo = ${repo} AND issue = ${input.issue} AND task_id = ${input.taskId}
              AND attempt = ${input.attempt} AND fencing = ${input.fencing} AND state = 'running'
              AND (
                holder_environment = ${caller.environmentId}
                OR (holder_environment IS NULL AND claimed_by = ${caller.sessionId})
              )
          `;
          return {
            outcome: "renewed" as const,
            claim: toClaim({
              ...current,
              holder_environment: current.holder_environment ?? caller.environmentId,
              lease_until: leaseUntil,
              renew_idempotency_key: input.idempotencyKey,
              renew_lease_until: leaseUntil,
            }),
          };
        }),
      )
      .pipe(Effect.mapError(storageError));
  });

  const release = Effect.fn("FleetClaims.release")(function* (
    caller: FleetCaller,
    input: FleetClaimLeaseInput,
  ) {
    const repo = yield* canonicalRepo(input.repo);
    const key = { ...input, repo };
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const current = (yield* read(key))[0];
          const matches =
            current !== undefined &&
            sameEnvironment(current, caller) &&
            current.attempt === input.attempt &&
            current.fencing === input.fencing;
          if (!matches || current.state !== "running") {
            return { outcome: "stale" as const, claim: null };
          }
          yield* sql`
            UPDATE node_claims SET state = 'released', release_idempotency_key = ${input.idempotencyKey}
            WHERE repo = ${repo} AND issue = ${input.issue} AND task_id = ${input.taskId}
              AND attempt = ${input.attempt} AND fencing = ${input.fencing} AND state = 'running'
              AND (
                holder_environment = ${caller.environmentId}
                OR (holder_environment IS NULL AND claimed_by = ${caller.sessionId})
              )
          `;
          return { outcome: "released" as const, claim: null };
        }),
      )
      .pipe(Effect.mapError(storageError));
  });

  const heartbeat = Effect.fn("FleetClaims.heartbeat")(function* (
    environmentId: string,
    input: FleetClaimHeartbeatInput,
  ) {
    const revoked = yield* sql<{ readonly environment_id: string }>`
      SELECT environment_id FROM fleet_revoked_environments WHERE environment_id = ${environmentId}
    `.pipe(Effect.mapError(storageError));
    if (revoked.length > 0) {
      return {
        sequence: input.sequence,
        results: input.leases.map((item) => itemResult(item, "revoked", null)),
      };
    }
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const nowIso = DateTime.formatIso(DateTime.makeUnsafe(now));
    const leaseUntil = DateTime.formatIso(DateTime.makeUnsafe(now + FLEET_LEASE_TTL_MS));
    const canonical = yield* Effect.forEach(input.leases, (item) =>
      Effect.map(canonicalRepo(item.repo), (repo) => ({ ...item, repo })),
    );
    const results = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const decided: Array<FleetClaimHeartbeatItemResult> = [];
          for (const item of canonical) {
            const key = { repo: item.repo, issue: item.issue, taskId: item.taskId };
            const current = (yield* read(key))[0];
            if (current === undefined) {
              decided.push(itemResult(item, "not-claimed", null));
              continue;
            }
            if (current.attempt > item.attempt) {
              decided.push(itemResult(item, "taken-over", null));
              continue;
            }
            if (current.attempt < item.attempt) {
              decided.push(itemResult(item, "not-claimed", null));
              continue;
            }
            if (current.holder_environment !== environmentId) {
              decided.push(itemResult(item, "not-owned", null));
              continue;
            }
            if (current.fencing !== item.fencing) {
              decided.push(itemResult(item, "taken-over", null));
              continue;
            }
            if (current.state === "released") {
              decided.push(itemResult(item, "released", null));
              continue;
            }
            if (current.state !== "running") {
              decided.push(itemResult(item, "not-claimed", null));
              continue;
            }
            if (Date.parse(current.lease_until) <= now) {
              decided.push(itemResult(item, "expired", null));
              continue;
            }
            const updated = yield* sql<{ readonly attempt: number }>`
              UPDATE node_claims SET lease_until = ${leaseUntil},
                renew_idempotency_key = NULL, renew_lease_until = NULL
              WHERE repo = ${item.repo} AND issue = ${item.issue} AND task_id = ${item.taskId}
                AND holder_environment = ${environmentId} AND attempt = ${item.attempt}
                AND fencing = ${item.fencing}
                AND state = 'running' AND lease_until > ${nowIso}
              RETURNING attempt
            `;
            if (updated.length === 0) {
              const raced = (yield* read(key))[0];
              decided.push(
                itemResult(
                  item,
                  raced !== undefined && raced.attempt > item.attempt ? "taken-over" : "expired",
                  null,
                ),
              );
              continue;
            }
            decided.push(
              itemResult(item, "renewed", toClaim({ ...current, lease_until: leaseUntil })),
            );
          }
          return decided;
        }),
      )
      .pipe(Effect.mapError(storageError));
    return { sequence: input.sequence, results };
  });

  const revoke = Effect.fn("FleetClaims.revoke")(function* (environmentId: string) {
    yield* sql`
      INSERT INTO fleet_revoked_environments (environment_id) VALUES (${environmentId})
      ON CONFLICT(environment_id) DO NOTHING
    `.pipe(Effect.mapError(storageError));
  });

  return FleetClaims.of({ claim, renew, release, heartbeat, revoke });
});

export const layer = Layer.unwrap(
  Effect.map(ServerConfig.ServerConfig, ({ stateDir }) =>
    Layer.effect(FleetClaims, make).pipe(
      Layer.provide(NodeSqliteClient.layer({ filename: NodePath.join(stateDir, "ledger.sqlite") })),
    ),
  ),
);

export const layerForTest = (filename = ":memory:", fleetId = "coordinator") =>
  Layer.effect(FleetClaims, make).pipe(
    Layer.provide(
      Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(EnvironmentId.make(fleetId)),
      }),
    ),
    Layer.provideMerge(NodeSqliteClient.layer({ filename })),
  );

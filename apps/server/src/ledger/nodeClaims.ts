import * as Option from "effect/Option";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

/** Same duration as the old POST /api/nodes/claims. */
const LOCAL_LEASE_MS = 2 * 60 * 60_000;

/** The pipeline's holder id. A node token's id is a different holder. */
export type ClaimRequest =
  | {
      readonly action: "claim";
      readonly repo: string;
      readonly issue: number;
      readonly title: string;
    }
  | { readonly action: "renew"; readonly repo: string; readonly issue: number }
  | {
      readonly action: "finish";
      readonly repo: string;
      readonly issue: number;
      readonly outcome: "done" | "failed" | "released";
      readonly reason?: string | undefined;
    };

export type ClaimInput =
  | {
      readonly action: "claim";
      readonly repo: string;
      readonly issue: number;
      readonly title: string;
      readonly claimedBy: string;
      readonly leaseUntil: string;
      /** Internal fence stored in fencing. Absent on HTTP claims. */
      readonly token?: string | undefined;
    }
  | {
      readonly action: "renew";
      readonly repo: string;
      readonly issue: number;
      readonly claimedBy: string;
      readonly leaseUntil: string;
    }
  | {
      readonly action: "finish";
      readonly repo: string;
      readonly issue: number;
      readonly outcome: "done" | "failed" | "released";
      readonly reason?: string | undefined;
      readonly claimedBy: string;
      /** Absent on HTTP finish, which deletes by holder. Present means fencing must match. */
      readonly token?: string | undefined;
    };

export type ClaimOutcome =
  | { readonly status: 200; readonly code: "ok"; readonly leaseUntil: string | null }
  | { readonly status: 404; readonly code: "unknown_repo" }
  | { readonly status: 409; readonly code: "engine_has_it" | "not_claimed" };

export const leaseUntilFrom = (nowMs: number) =>
  DateTime.formatIso(DateTime.add(DateTime.makeUnsafe(nowMs), { milliseconds: LOCAL_LEASE_MS }));

const REPO = /^[\w.-]+\/[\w.-]+$/;

const Repo = Schema.String.check(Schema.isPattern(REPO));
const Issue = Schema.Int.check(Schema.isGreaterThan(0));
const Reason = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500));

const ClaimRequestSchema = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("claim"),
    repo: Repo,
    issue: Issue,
    title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
  }),
  Schema.Struct({ action: Schema.Literal("renew"), repo: Repo, issue: Issue }),
  Schema.Struct({
    action: Schema.Literal("finish"),
    repo: Repo,
    issue: Issue,
    outcome: Schema.Literals(["done", "failed", "released"]),
    reason: Schema.optional(Reason),
  }),
]);

const decodeClaimRequest = Schema.decodeUnknownOption(ClaimRequestSchema);

/** Same body as `pnpm work claim`. Extra fields fail the decode. */
export const parseClaimRequest = (body: unknown): ClaimRequest | undefined =>
  Option.getOrUndefined(decodeClaimRequest(body));

const leaseHeld = (leaseUntil: string, nowMs: number) => {
  const until = Date.parse(leaseUntil);
  return Number.isNaN(until) || until > nowMs;
};

/** The only writer of legacy node claims. Fleet claims use FleetClaims through the coordinator. */
export const apply = Effect.fn("nodeClaims.apply")(function* (
  sql: SqlClient.SqlClient,
  input: ClaimInput,
  nowMs: number,
) {
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      if (!REPO.test(input.repo)) return { status: 404, code: "unknown_repo" } as const;
      const [owner, name] = input.repo.split("/");
      const registered = yield* sql`
        SELECT owner FROM repos
        WHERE lower(owner) = lower(${owner}) AND lower(name) = lower(${name})
        LIMIT 1
      `;
      if (registered.length === 0) return { status: 404, code: "unknown_repo" } as const;
      const held = (yield* sql`
        SELECT claimed_by AS claimedBy, lease_until AS leaseUntil FROM node_claims
        WHERE fleet_id = 'legacy' AND task_id = 'root'
          AND lower(repo) = lower(${input.repo}) AND issue = ${input.issue} AND state = 'running'
      `) as readonly { readonly claimedBy: string; readonly leaseUntil: string }[];
      if (input.action === "finish") {
        const token = input.token;
        const removed = yield* sql`
          DELETE FROM node_claims
          WHERE fleet_id = 'legacy' AND task_id = 'root'
            AND lower(repo) = lower(${input.repo}) AND issue = ${input.issue}
            AND claimed_by = ${input.claimedBy}
            ${token !== undefined ? sql`AND fencing = ${token}` : sql``}
          RETURNING issue
        `;
        if (removed.length === 0) return { status: 409, code: "not_claimed" } as const;
        return { status: 200, code: "ok", leaseUntil: null } as const;
      }
      if (input.action === "renew") {
        if (
          held.some((row) => row.claimedBy !== input.claimedBy && leaseHeld(row.leaseUntil, nowMs))
        ) {
          return { status: 409, code: "engine_has_it" } as const;
        }
        if (
          !held.some((row) => row.claimedBy === input.claimedBy && leaseHeld(row.leaseUntil, nowMs))
        ) {
          return { status: 409, code: "not_claimed" } as const;
        }
        yield* sql`
          UPDATE node_claims SET lease_until = ${input.leaseUntil}
          WHERE fleet_id = 'legacy' AND task_id = 'root'
            AND lower(repo) = lower(${input.repo}) AND issue = ${input.issue}
            AND claimed_by = ${input.claimedBy}
        `;
        return { status: 200, code: "ok", leaseUntil: input.leaseUntil } as const;
      }
      if (held.some((row) => leaseHeld(row.leaseUntil, nowMs))) {
        return { status: 409, code: "engine_has_it" } as const;
      }
      yield* sql`
        DELETE FROM node_claims WHERE fleet_id = 'legacy' AND task_id = 'root'
          AND lower(repo) = lower(${input.repo}) AND issue = ${input.issue}
      `;
      yield* sql`
        INSERT INTO node_claims (
          fleet_id, repo, issue, task_id, claimed_by, lease_until, executor, state, fencing, attempt,
          claim_idempotency_key, renew_idempotency_key, renew_lease_until, release_idempotency_key 
        ) VALUES (
          'legacy', ${input.repo}, ${input.issue}, 'root', ${input.claimedBy}, ${input.leaseUntil},
          'local', 'running', ${input.token ?? null}, 1, NULL, NULL, NULL, NULL 
        )
      `;
      return { status: 200, code: "ok", leaseUntil: input.leaseUntil } as const;
    }),
  );
});

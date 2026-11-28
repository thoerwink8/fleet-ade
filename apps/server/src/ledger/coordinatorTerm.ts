import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

type TermSnapshot = {
  readonly term: number;
  readonly coordinatorId: string | null;
};

/** One fleet has one coordinator term row, addressed by this key on every machine. */
export const FLEET_TERM_KEY = "fleet";

export type ObserveResult = Data.TaggedEnum<{
  current: TermSnapshot;
  stale: TermSnapshot;
}>;
export const ObserveResult = Data.taggedEnum<ObserveResult>();

export type HandoverResult = Data.TaggedEnum<{
  current: {
    readonly term: number;
    readonly coordinatorId: string;
  };
  stale: TermSnapshot;
}>;
export const HandoverResult = Data.taggedEnum<HandoverResult>();

export class CoordinatorTermStorageError extends Schema.TaggedError<
  CoordinatorTermStorageError,
  { readonly brand: unique symbol }
>()("CoordinatorTermStorageError", {
  fleetId: Schema.optional(Schema.String),
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return "Coordinator term storage failed.";
  }
}

const isCoordinatorTermStorageError = Schema.is(CoordinatorTermStorageError);

export class CoordinatorTerm extends Context.Service<
  CoordinatorTerm,
  {
    readonly read: (fleetId: string) => Effect.Effect<TermSnapshot, CoordinatorTermStorageError>;
    readonly observe: (
      fleetId: string,
      term: number,
      coordinatorId: string,
      caller?: { readonly environmentId: string },
    ) => Effect.Effect<ObserveResult, CoordinatorTermStorageError>;
    readonly handover: (
      fleetId: string,
      toCoordinatorId: string,
      expectedTerm: number,
    ) => Effect.Effect<HandoverResult, CoordinatorTermStorageError>;
  }
>()("t3/ledger/coordinatorTerm") {}

interface TermRow {
  readonly term: number;
  readonly coordinator_id: string;
}

const snapshotOf = (row: TermRow | undefined): TermSnapshot =>
  row === undefined
    ? { term: 0, coordinatorId: null }
    : { term: row.term, coordinatorId: row.coordinator_id };

const migrate = Effect.fn("CoordinatorTerm.migrate")(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.withTransaction(
    sql`
      CREATE TABLE IF NOT EXISTS fleet_coordinator_terms (
        fleet_id TEXT PRIMARY KEY,
        term INTEGER NOT NULL CHECK (term >= 0),
        coordinator_id TEXT NOT NULL
      )
    `,
  );
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* migrate().pipe(Effect.mapError((cause) => new CoordinatorTermStorageError({ cause })));

  const load = (fleetId: string) =>
    sql<TermRow>`
      SELECT term, coordinator_id
      FROM fleet_coordinator_terms
      WHERE fleet_id = ${fleetId}
    `.pipe(Effect.map((rows) => rows[0]));

  const guard = (fleetId: string) => (cause: unknown) =>
    isCoordinatorTermStorageError(cause)
      ? cause
      : new CoordinatorTermStorageError({ fleetId, cause });

  const read = Effect.fn("CoordinatorTerm.read")(function* (fleetId: string) {
    return yield* load(fleetId).pipe(Effect.map(snapshotOf), Effect.mapError(guard(fleetId)));
  });

  const observe = Effect.fn("CoordinatorTerm.observe")(function* (
    fleetId: string,
    term: number,
    coordinatorId: string,
    caller?: { readonly environmentId: string },
  ) {
    const contention = {
      ...(caller === undefined ? {} : { callerEnvironmentId: caller.environmentId }),
      term,
    };
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const stored = snapshotOf(yield* load(fleetId));
          // Term 0 means there is no coordinator yet, so it is never adopted.
          if (term === 0 && stored.term === 0) return ObserveResult.stale(stored);
          if (stored.term === term && stored.coordinatorId === coordinatorId) {
            return ObserveResult.current(stored);
          }
          // Ties on term are broken by coordinator id inside the compare-and-swap, for
          // eventual convergence only; JavaScript string order does not match SQLite's.
          const written = yield* sql<{ readonly term: number }>`
            INSERT INTO fleet_coordinator_terms (fleet_id, term, coordinator_id)
            VALUES (${fleetId}, ${term}, ${coordinatorId})
            ON CONFLICT(fleet_id) DO UPDATE SET
              term = excluded.term,
              coordinator_id = excluded.coordinator_id
            WHERE fleet_coordinator_terms.term < excluded.term
              OR (
                fleet_coordinator_terms.term = excluded.term
                AND fleet_coordinator_terms.coordinator_id < excluded.coordinator_id
              )
            RETURNING term
          `;
          if (written[0] !== undefined) {
            if (stored.term === term && stored.coordinatorId !== coordinatorId) {
              yield* Effect.logWarning("coordinator term contended at equal term", {
                storedCoordinatorId: stored.coordinatorId,
                observedCoordinatorId: coordinatorId,
                ...contention,
                outcome: "current",
              });
            }
            return ObserveResult.current({ term, coordinatorId });
          }
          // The failed compare-and-swap already holds the write lock, so this row is the one it refused.
          const latest = snapshotOf(yield* load(fleetId));
          if (latest.term === term && latest.coordinatorId === coordinatorId) {
            return ObserveResult.current(latest);
          }
          if (latest.term === term && latest.coordinatorId !== coordinatorId) {
            yield* Effect.logWarning("coordinator term contended at equal term", {
              storedCoordinatorId: latest.coordinatorId,
              observedCoordinatorId: coordinatorId,
              ...contention,
              outcome: "stale",
            });
          }
          return ObserveResult.stale(latest);
        }),
      )
      .pipe(Effect.mapError(guard(fleetId)));
  });

  const handover = Effect.fn("CoordinatorTerm.handover")(function* (
    fleetId: string,
    toCoordinatorId: string,
    expectedTerm: number,
  ) {
    const nextTerm = expectedTerm + 1;
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const updated = yield* sql<{ readonly term: number }>`
            UPDATE fleet_coordinator_terms
            SET term = ${nextTerm}, coordinator_id = ${toCoordinatorId}
            WHERE fleet_id = ${fleetId} AND term = ${expectedTerm}
            RETURNING term
          `;
          if (updated[0] !== undefined) {
            return HandoverResult.current({ term: nextTerm, coordinatorId: toCoordinatorId });
          }
          const row = yield* load(fleetId);
          // The lock is already held, so a missing row stays missing until this insert commits.
          if (row === undefined && expectedTerm === 0) {
            yield* sql`
              INSERT INTO fleet_coordinator_terms (fleet_id, term, coordinator_id)
              VALUES (${fleetId}, ${nextTerm}, ${toCoordinatorId})
            `;
            return HandoverResult.current({ term: nextTerm, coordinatorId: toCoordinatorId });
          }
          return HandoverResult.stale(snapshotOf(row));
        }),
      )
      .pipe(Effect.mapError(guard(fleetId)));
  });

  return CoordinatorTerm.of({ read, observe, handover });
});

export const layer = Layer.effect(CoordinatorTerm, make);

import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

export type TermSnapshot = {
  readonly term: number;
  readonly coordinatorId: string | null;
};

export type ObserveResult = Data.TaggedEnum<{
  current: TermSnapshot;
  stale: TermSnapshot;
  conflict: TermSnapshot;
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

class CoordinatorTermStorageError extends Schema.TaggedError<
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

const observeUnchanged = (
  stored: TermSnapshot,
  term: number,
  coordinatorId: string,
): ObserveResult | undefined => {
  if (term < stored.term) return ObserveResult.stale(stored);
  if (term > stored.term) return undefined;
  return coordinatorId === stored.coordinatorId
    ? ObserveResult.current(stored)
    : ObserveResult.conflict(stored);
};

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
  ) {
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const stored = snapshotOf(yield* load(fleetId));
          const unchanged = observeUnchanged(stored, term, coordinatorId);
          if (unchanged !== undefined) return unchanged;
          const written =
            stored.coordinatorId === null
              ? yield* sql<{ readonly term: number }>`
                  INSERT INTO fleet_coordinator_terms (fleet_id, term, coordinator_id)
                  SELECT ${fleetId}, ${term}, ${coordinatorId}
                  WHERE NOT EXISTS (
                    SELECT 1 FROM fleet_coordinator_terms WHERE fleet_id = ${fleetId}
                  )
                  RETURNING term
                `
              : yield* sql<{ readonly term: number }>`
                  UPDATE fleet_coordinator_terms
                  SET term = ${term}, coordinator_id = ${coordinatorId}
                  WHERE fleet_id = ${fleetId} AND term < ${term}
                  RETURNING term
                `;
          if (written[0] !== undefined) return ObserveResult.current({ term, coordinatorId });
          const latest = snapshotOf(yield* load(fleetId));
          const raced = observeUnchanged(latest, term, coordinatorId);
          if (raced !== undefined) return raced;
          return yield* new CoordinatorTermStorageError({
            fleetId,
            cause: new Error("Coordinator term compare-and-swap did not persist."),
          });
        }),
      )
      .pipe(Effect.mapError(guard(fleetId)));
  });

  const handover = Effect.fn("CoordinatorTerm.handover")(function* (
    fleetId: string,
    toCoordinatorId: string,
    expectedTerm: number,
  ) {
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const row = yield* load(fleetId);
          const stored = snapshotOf(row);
          if (stored.term !== expectedTerm) return HandoverResult.stale(stored);
          const nextTerm = expectedTerm + 1;
          const written =
            row === undefined
              ? yield* sql<{ readonly term: number }>`
                  INSERT INTO fleet_coordinator_terms (fleet_id, term, coordinator_id)
                  SELECT ${fleetId}, ${nextTerm}, ${toCoordinatorId}
                  WHERE NOT EXISTS (
                    SELECT 1 FROM fleet_coordinator_terms WHERE fleet_id = ${fleetId}
                  )
                  RETURNING term
                `
              : yield* sql<{ readonly term: number }>`
                  UPDATE fleet_coordinator_terms
                  SET term = ${nextTerm}, coordinator_id = ${toCoordinatorId}
                  WHERE fleet_id = ${fleetId} AND term = ${expectedTerm}
                  RETURNING term
                `;
          if (written[0] === undefined)
            return HandoverResult.stale(snapshotOf(yield* load(fleetId)));
          return HandoverResult.current({ term: nextTerm, coordinatorId: toCoordinatorId });
        }),
      )
      .pipe(Effect.mapError(guard(fleetId)));
  });

  return CoordinatorTerm.of({ read, observe, handover });
});

export const layer = Layer.effect(CoordinatorTerm, make);

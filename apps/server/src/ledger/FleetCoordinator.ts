import {
  EnvironmentId,
  FleetCoordinatorError,
  type FleetTermExchangeInput,
  type FleetTermExchangeResult,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as CoordinatorTerm from "./coordinatorTerm.ts";
import * as LedgerDb from "./LedgerDb.ts";

/**
 * Answers coordinator term exchanges with paired machines: adopts the larger
 * `(term, coordinatorId)` and replies with the converged snapshot, so the
 * caller adopts it in turn. `CoordinatorTerm` owns storage only.
 */
export class FleetCoordinator extends Context.Service<
  FleetCoordinator,
  {
    readonly exchange: (
      caller: { readonly environmentId: string },
      input: FleetTermExchangeInput,
    ) => Effect.Effect<FleetTermExchangeResult, FleetCoordinatorError>;
  }
>()("t3/ledger/FleetCoordinator") {}

const make = Effect.gen(function* () {
  const terms = yield* CoordinatorTerm.CoordinatorTerm;
  const links = yield* PeerLinks.PeerLinks;
  const environment = yield* ServerEnvironment.ServerEnvironment;

  const storageError = (cause: unknown) =>
    new FleetCoordinatorError({
      reason: "storage",
      message: "Coordinator term storage is unavailable.",
      cause,
    });

  const exchange = Effect.fn("FleetCoordinator.exchange")(function* (
    caller: { readonly environmentId: string },
    input: FleetTermExchangeInput,
  ) {
    const selfId = yield* environment.getEnvironmentId;
    const paired =
      input.coordinatorId === selfId ||
      (yield* links.get(input.coordinatorId).pipe(
        Effect.map(Option.isSome),
        Effect.mapError((error) =>
          storageError(error.cause !== undefined ? error.cause : new Error(error.message)),
        ),
      ));
    if (!paired) {
      return yield* new FleetCoordinatorError({
        reason: "unknown-coordinator",
        message: `Coordinator ${input.coordinatorId} is neither this environment nor a linked one.`,
      });
    }
    const before = yield* terms
      .read(CoordinatorTerm.FLEET_TERM_KEY)
      .pipe(Effect.mapError(storageError));
    const observed = yield* terms
      .observe(CoordinatorTerm.FLEET_TERM_KEY, input.term, input.coordinatorId)
      .pipe(Effect.mapError(storageError));
    // Equal terms with different coordinators mean two machines both took over; the
    // lexicographic order only converges them, so every overwrite and refusal is worth a look.
    if (
      before.term === input.term &&
      before.term > 0 &&
      before.coordinatorId !== input.coordinatorId
    ) {
      yield* Effect.logWarning("coordinator term exchanged at equal term", {
        storedCoordinatorId: before.coordinatorId,
        observedCoordinatorId: input.coordinatorId,
        term: input.term,
        callerEnvironmentId: caller.environmentId,
        outcome: observed._tag,
      });
    }
    return {
      term: observed.term,
      // Rows only ever hold environment ids this machine or a linked one wrote.
      coordinatorId:
        observed.coordinatorId === null ? null : EnvironmentId.make(observed.coordinatorId),
    };
  });

  return FleetCoordinator.of({ exchange });
});

export const layer = Layer.effect(FleetCoordinator, make).pipe(
  Layer.provideMerge(CoordinatorTerm.layer),
  Layer.provide(LedgerDb.layer),
);

/** Same service on the test's own ledger file, so term writes land where the test reads them. */
export const layerForTest = (filename = ":memory:") =>
  Layer.effect(FleetCoordinator, make).pipe(
    Layer.provideMerge(CoordinatorTerm.layer),
    Layer.provide(NodeSqliteClient.layer({ filename })),
  );

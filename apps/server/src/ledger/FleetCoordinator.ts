import {
  EnvironmentId,
  FleetCoordinatorError,
  type FleetTermExchangeInput,
  type FleetTermExchangeResult,
  FleetTermExchangeResult as FleetTermExchangeResultSchema,
  type FleetTermHandoverResult,
  FleetTermHandoverResult as FleetTermHandoverResultSchema,
  type FleetTermTakeoverResult,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import * as CoordinatorTerm from "./coordinatorTerm.ts";
import * as LedgerDb from "./LedgerDb.ts";

/**
 * Term exchanges adopt the larger `(term, coordinatorId)` and reply with the
 * converged snapshot. Handover commits the next term locally before pushing to
 * the target, so this machine stops accepting fleet lease writes at the commit
 * even when the push never lands. `CoordinatorTerm` owns storage only.
 */
export class FleetCoordinator extends Context.Service<
  FleetCoordinator,
  {
    readonly exchange: (
      caller: { readonly environmentId: string },
      input: FleetTermExchangeInput,
    ) => Effect.Effect<FleetTermExchangeResult, FleetCoordinatorError>;
    /** Hands the coordinator to a linked machine. Idempotent for a machine already handed to it. */
    readonly handover: (
      to: EnvironmentId,
    ) => Effect.Effect<FleetTermHandoverResult, FleetCoordinatorError>;
    /**
     * A linked machine asking this one to hand the coordinator over. The target
     * can only be the caller itself: handing to a third machine is refused.
     */
    readonly requestHandover: (
      caller: { readonly environmentId: EnvironmentId },
      target?: EnvironmentId,
    ) => Effect.Effect<FleetTermHandoverResult, FleetCoordinatorError>;
    /**
     * Makes this machine the coordinator. Exchanges with every reachable peer
     * first, so the term it writes sits above anything the fleet knows. The
     * reachable coordinator is asked to hand over; only an unreachable one may
     * be bypassed, and only with `force`.
     */
    readonly takeover: (options: {
      readonly force: boolean;
    }) => Effect.Effect<FleetTermTakeoverResult, FleetCoordinatorError>;
    /** The coordinator term as this machine last heard it. */
    readonly current: Effect.Effect<FleetTermExchangeResult, FleetCoordinatorError>;
    /** Machines a handover push failed to reach; a later version's re-push loop reads this. */
    readonly pendingPush: Effect.Effect<ReadonlyArray<EnvironmentId>, never>;
  }
>()("t3/ledger/FleetCoordinator") {}

const make = Effect.gen(function* () {
  const terms = yield* CoordinatorTerm.CoordinatorTerm;
  const links = yield* PeerLinks.PeerLinks;
  const peerClient = yield* PeerMcpClient.PeerMcpClient;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const pending = yield* Ref.make<ReadonlySet<EnvironmentId>>(new Set());

  const storageError = (cause: unknown) =>
    new FleetCoordinatorError({
      reason: "storage",
      message: "Coordinator term storage is unavailable.",
      cause,
    });
  const linkError = (error: { readonly message: string; readonly cause?: unknown }) =>
    storageError(error.cause !== undefined ? error.cause : new Error(error.message));

  const snapshotOf = (snapshot: {
    readonly term: number;
    readonly coordinatorId: string | null;
  }): FleetTermExchangeResult => ({
    term: snapshot.term,
    // Rows only ever hold environment ids this machine or a linked one wrote.
    coordinatorId:
      snapshot.coordinatorId === null ? null : EnvironmentId.make(snapshot.coordinatorId),
  });

  const readSnapshot = terms
    .read(CoordinatorTerm.FLEET_TERM_KEY)
    .pipe(Effect.mapError(storageError));

  const adopt = (
    term: number,
    coordinatorId: EnvironmentId,
    caller?: { readonly environmentId: string },
  ) =>
    terms
      .observe(CoordinatorTerm.FLEET_TERM_KEY, term, coordinatorId, caller)
      .pipe(Effect.mapError(storageError));

  const exchange = Effect.fn("FleetCoordinator.exchange")(function* (
    caller: { readonly environmentId: string },
    input: FleetTermExchangeInput,
  ) {
    const selfId = yield* environment.getEnvironmentId;
    const paired =
      input.coordinatorId === selfId ||
      (yield* links
        .get(input.coordinatorId)
        .pipe(Effect.map(Option.isSome), Effect.mapError(linkError)));
    if (!paired) {
      return yield* new FleetCoordinatorError({
        reason: "unknown-coordinator",
        message: `Coordinator ${input.coordinatorId} is neither this environment nor a linked one.`,
      });
    }
    return snapshotOf(yield* adopt(input.term, input.coordinatorId, caller));
  });

  /** Pushes the snapshot to one peer. Failure records it for a later version's re-push loop. */
  const pushTo = (
    environmentId: EnvironmentId,
    snapshot: { readonly term: number; readonly coordinatorId: EnvironmentId },
  ) =>
    peerClient
      .call({
        environmentId,
        tool: "fleet_term_exchange",
        arguments: { term: snapshot.term, coordinatorId: snapshot.coordinatorId },
        limits: { runtimeMode: "auto", interactionMode: "default" },
        success: FleetTermExchangeResultSchema,
      })
      .pipe(
        // The peer may know a larger term; adopting it is how the fleet converges.
        // The reply came from the pushed machine, so contended-term warnings name it.
        Effect.tap((reply) =>
          reply.coordinatorId === null || reply.term === 0
            ? Effect.void
            : adopt(reply.term, reply.coordinatorId, { environmentId }),
        ),
        // A push that never answers must not hold up the handover reply.
        Effect.timeout(Duration.seconds(3)),
        Effect.tap(() =>
          Ref.update(pending, (set) => {
            const next = new Set(set);
            next.delete(environmentId);
            return next;
          }),
        ),
        Effect.tapError((error) =>
          Effect.all([
            Ref.update(pending, (set) => new Set(set).add(environmentId)),
            Effect.logWarning("coordinator term push failed", {
              targetEnvironmentId: environmentId,
              message: error.message,
            }),
          ]),
        ),
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );

  const handover = Effect.fn("FleetCoordinator.handover")(function* (to: EnvironmentId) {
    const selfId = yield* environment.getEnvironmentId;
    const linked = yield* links.get(to).pipe(Effect.mapError(linkError));
    if (to === selfId || Option.isNone(linked)) {
      return yield* new FleetCoordinatorError({
        reason: "unknown-target",
        message:
          to === selfId
            ? "This environment cannot hand the coordinator over to itself."
            : `Cannot hand the coordinator to ${to}: this environment is not linked to it. Link it first.`,
      });
    }
    const before = yield* readSnapshot;
    let pushed: { readonly term: number; readonly coordinatorId: EnvironmentId };
    if (before.coordinatorId === to) {
      // Already handed: resume the push without touching the row. Any row naming the
      // target counts; the validation adopts a larger term the target knows, so a
      // stale row converges instead of winning back.
      const validation = yield* peerClient
        .call({
          environmentId: to,
          tool: "fleet_term_exchange",
          arguments: { term: before.term, coordinatorId: to },
          limits: { runtimeMode: "auto", interactionMode: "default" },
          success: FleetTermExchangeResultSchema,
        })
        .pipe(
          Effect.timeout(Duration.seconds(3)),
          Effect.orElseSucceed(() => null),
        );
      if (validation !== null && validation.coordinatorId !== null && validation.term > 0) {
        yield* adopt(validation.term, validation.coordinatorId, { environmentId: to });
      }
      const settled = yield* readSnapshot;
      if (settled.coordinatorId !== to) {
        return { outcome: "stale" as const, ...snapshotOf(settled) };
      }
      pushed = { term: settled.term, coordinatorId: to };
    } else {
      if (before.coordinatorId !== selfId) {
        return { outcome: "stale" as const, ...snapshotOf(before) };
      }
      // Learn the target's term before moving ours: a target that knows a larger
      // term turns this handover stale instead of diverging.
      const offered = yield* peerClient
        .call({
          environmentId: to,
          tool: "fleet_term_exchange",
          arguments: { term: before.term, coordinatorId: selfId },
          limits: { runtimeMode: "auto", interactionMode: "default" },
          success: FleetTermExchangeResultSchema,
        })
        .pipe(
          Effect.timeout(Duration.seconds(3)),
          Effect.mapError(
            (error) =>
              new FleetCoordinatorError({
                reason: "peer-unreachable",
                message: `The handover target ${to} could not be asked its term: ${error.message}`,
                cause: error,
              }),
          ),
        );
      if (offered.coordinatorId !== null && offered.term > 0) {
        yield* adopt(offered.term, offered.coordinatorId, { environmentId: to });
      }
      const current = yield* readSnapshot;
      if (current.coordinatorId === to && current.term === before.term + 1) {
        // The exchange already moved the fleet onto the target, as when it had
        // accepted a lost push of this very handover.
        pushed = { term: current.term, coordinatorId: to };
      } else {
        if (current.coordinatorId !== selfId) {
          return { outcome: "stale" as const, ...snapshotOf(current) };
        }
        const written = yield* terms
          .handover(CoordinatorTerm.FLEET_TERM_KEY, to, current.term, current.coordinatorId)
          .pipe(Effect.mapError(storageError));
        if (written._tag === "stale") {
          return { outcome: "stale" as const, ...snapshotOf(written) };
        }
        // The term row committed here; fleet lease writes on this machine refuse
        // from this moment. The push below only confirms what is already decided.
        pushed = { term: written.term, coordinatorId: to };
      }
    }
    const confirmed = yield* pushTo(to, pushed);
    const others = yield* links.list.pipe(Effect.mapError(linkError));
    // Best effort: every other paired machine learns the new term now. Failures
    // land on the pending list a later version's re-push loop reads.
    yield* Effect.forEach(
      others.filter((link) => link.environmentId !== to),
      (link) => pushTo(link.environmentId, pushed),
      { concurrency: "unbounded", discard: true },
    );
    return {
      outcome: confirmed ? ("handed-over" as const) : ("handed-over-unconfirmed" as const),
      term: pushed.term,
      coordinatorId: pushed.coordinatorId,
    };
  });

  const takeover = Effect.fn("FleetCoordinator.takeover")(function* (options: {
    readonly force: boolean;
  }) {
    const selfId = yield* environment.getEnvironmentId;
    // Ask every peer its term first: each pairwise exchange leaves the larger
    // snapshot here, so the row read afterwards is the largest term this
    // machine can know. Unreachable peers are the ones this call exists for.
    const peers = yield* links.list.pipe(Effect.mapError(linkError));
    const answered = new Set<string>();
    for (const peer of peers) {
      const local = yield* readSnapshot;
      const reply = yield* peerClient
        .call({
          environmentId: peer.environmentId,
          tool: "fleet_term_exchange",
          arguments: {
            term: local.term,
            coordinatorId: local.coordinatorId ?? selfId,
          },
          limits: { runtimeMode: "auto", interactionMode: "default" },
          success: FleetTermExchangeResultSchema,
        })
        .pipe(Effect.timeoutOption(Duration.seconds(3)), Effect.orElseSucceed(Option.none));
      if (Option.isNone(reply)) continue;
      answered.add(peer.environmentId);
      if (reply.value.coordinatorId !== null && reply.value.term > 0) {
        yield* adopt(reply.value.term, reply.value.coordinatorId, {
          environmentId: peer.environmentId,
        }).pipe(
          Effect.tapError((error) =>
            Effect.logWarning("coordinator term adoption during takeover failed", {
              peerEnvironmentId: peer.environmentId,
              message: error.message,
            }),
          ),
          Effect.catch(() => Effect.void),
        );
      }
    }
    const known = yield* readSnapshot;
    if (known.coordinatorId === selfId) {
      return { outcome: "taken-over" as const, ...snapshotOf(known) };
    }
    const coordinatorId = known.coordinatorId;
    if (coordinatorId !== null && answered.has(coordinatorId)) {
      // The coordinator answered the exchange above, so it hands over online.
      const handed = yield* peerClient
        .call({
          environmentId: EnvironmentId.make(coordinatorId),
          tool: "fleet_term_handover",
          arguments: { target: selfId },
          limits: { runtimeMode: "auto", interactionMode: "default" },
          success: FleetTermHandoverResultSchema,
        })
        .pipe(Effect.timeoutOption(Duration.seconds(10)), Effect.orElseSucceed(Option.none));
      if (Option.isSome(handed) && handed.value.coordinatorId !== null && handed.value.term > 0) {
        yield* adopt(handed.value.term, handed.value.coordinatorId, {
          environmentId: coordinatorId,
        });
      }
      // The handover may have committed on the coordinator even when its reply
      // timed out or got lost: the local row, not the reply, decides.
      const after = yield* readSnapshot;
      if (after.coordinatorId === selfId) {
        return { outcome: "taken-over" as const, ...snapshotOf(after) };
      }
      if (Option.isSome(handed)) {
        // A reachable coordinator refused the handover; bypassing it would split the fleet.
        return { outcome: "stale" as const, ...snapshotOf(after) };
      }
      if (!options.force) {
        return { outcome: "needs-confirmation" as const, ...snapshotOf(after) };
      }
    } else if (coordinatorId !== null && !options.force) {
      return { outcome: "needs-confirmation" as const, ...snapshotOf(known) };
    }
    const latest = yield* readSnapshot;
    const written = yield* terms
      .handover(CoordinatorTerm.FLEET_TERM_KEY, selfId, latest.term, latest.coordinatorId)
      .pipe(Effect.mapError(storageError));
    if (written._tag === "stale") {
      // Already this machine, as when a retry meets its own first write.
      const current = yield* readSnapshot;
      return {
        outcome: current.coordinatorId === selfId ? ("taken-over" as const) : ("stale" as const),
        ...snapshotOf(current),
      };
    }
    yield* Effect.forEach(
      peers,
      (peer) => pushTo(peer.environmentId, { term: written.term, coordinatorId: selfId }),
      { concurrency: "unbounded", discard: true },
    );
    return {
      outcome: "taken-over" as const,
      term: written.term,
      coordinatorId: selfId,
    };
  });

  const requestHandover = Effect.fn("FleetCoordinator.requestHandover")(function* (
    caller: { readonly environmentId: EnvironmentId },
    target?: EnvironmentId,
  ) {
    if (target !== undefined && target !== caller.environmentId) {
      return yield* new FleetCoordinatorError({
        reason: "third-party-target",
        message: `A linked machine can only ask the coordinator for itself, not for ${target}.`,
      });
    }
    return yield* handover(caller.environmentId);
  });

  return FleetCoordinator.of({
    exchange,
    handover,
    requestHandover,
    takeover,
    current: readSnapshot.pipe(Effect.map(snapshotOf)),
    pendingPush: Ref.get(pending).pipe(Effect.map((set) => Array.from(set))),
  });
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

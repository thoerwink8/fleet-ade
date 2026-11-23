import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  GuestMessageId,
  GuestShareId,
  MessageId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectionReplay from "./testkit/ProjectionReplay.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const database = SqlitePersistence.layerMemory;
const eventStoreProvided = EventStore.layer.pipe(Layer.provideMerge(database));
const projectionStoreProvided = ProjectionStore.layer.pipe(Layer.provideMerge(database));
const stores = Layer.mergeAll(database, eventStoreProvided, projectionStoreProvided);
const layerTest = Layer.mergeAll(
  stores,
  OrchestrationEventStore.layer.pipe(Layer.provide(database)),
  EventSink.layer.pipe(Layer.provide(stores)),
  ProjectionReplay.layer.pipe(Layer.provide(stores)),
);

const providerInstanceId = ProviderInstanceId.make("codex");
const decodeThreadProjection = Schema.decodeUnknownSync(OrchestrationV2ThreadProjection);
const guestCommandAdapter = {
  instanceId: providerInstanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Runs here never reach a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerGuestCommands = ProviderReplayHarness.layerWithRegistry(
  { name: "guest-legacy-commands" },
  ProviderAdapterRegistry.layerFromAdapters([guestCommandAdapter]),
  { databaseLayer: database, runEffectWorker: false },
);

it.effect(
  "keeps a stored guest share's pending files on the delete plan after a projection rebuild",
  () =>
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const replay = yield* ProjectionReplay.ProjectionReplay;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:guest-legacy");
      const thread: OrchestrationV2AppThread = {
        id: threadId,
        projectId: ProjectId.make("project:guest-legacy"),
        title: "Old guest share",
        providerInstanceId,
        modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
        forkedFrom: null,
        createdBy: "user",
        creationSource: "web",
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      };
      const shared: OrchestrationV2AppThread = {
        ...thread,
        guestShare: {
          id: GuestShareId.make("share:legacy"),
          host: "machine.tailnet.ts.net",
          createdAt: "2026-01-01T00:00:00.000Z",
          expiresAt: "2026-01-02T00:00:00.000Z",
          guestName: "Sam",
          messages: [
            {
              id: GuestMessageId.make("guest-message:legacy"),
              text: "See the notes",
              status: "pending",
              submittedAt: "2026-01-01T00:00:01.000Z",
              attachments: [
                {
                  id: "attachment-guest-pending",
                  type: "file",
                  name: "notes.txt",
                  sizeBytes: 3,
                  mimeType: "text/plain",
                },
              ],
            },
            {
              id: GuestMessageId.make("guest-message:sent"),
              text: "Already sent",
              status: "sent",
              submittedAt: "2026-01-01T00:00:02.000Z",
              attachments: [
                {
                  id: "attachment-guest-sent",
                  type: "file",
                  name: "sent.txt",
                  sizeBytes: 3,
                  mimeType: "text/plain",
                },
              ],
            },
          ],
        },
      };
      const created = {
        id: EventId.make("event:guest-legacy:created"),
        type: "thread.created",
        threadId,
        providerInstanceId,
        occurredAt: now,
        payload: thread,
      } satisfies OrchestrationV2DomainEvent;
      const updated = {
        id: EventId.make("event:guest-legacy:share"),
        type: "thread.guest-share-updated",
        threadId,
        providerInstanceId,
        occurredAt: now,
        payload: shared,
      } satisfies OrchestrationV2DomainEvent;
      yield* sink.write({ events: [created, updated] });

      const rebuilt = yield* replay.rebuild;
      assert.isTrue(rebuilt.valid);
      const decoded = yield* projections.getThread(threadId);
      assert.equal(decoded.guestShare?.messages[0]?.status, "pending");
      assert.equal(
        decoded.guestShare?.messages[0]?.attachments?.[0]?.id,
        "attachment-guest-pending",
      );
      assert.deepEqual(yield* projections.getThreadAttachmentIds(threadId), [
        "attachment-guest-pending",
      ]);
    }).pipe(Effect.provide(layerTest)),
);

it.effect("archive and cancel leave an old pending guest share decodable", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sink = yield* EventSink.EventSinkV2;
    const threadId = ThreadId.make("thread:guest-archive");
    const now = yield* DateTime.now;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create:guest-archive"),
      threadId,
      projectId: ProjectId.make("project:guest-archive"),
      title: "Old guest share",
      modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    const created = yield* orchestrator.getThreadProjection(threadId);
    yield* sink.write({
      events: [
        {
          id: EventId.make("event:guest-archive:share"),
          type: "thread.guest-share-updated",
          threadId,
          providerInstanceId,
          occurredAt: now,
          payload: {
            ...created.thread,
            guestShare: {
              id: GuestShareId.make("share:archive"),
              host: "machine.tailnet.ts.net",
              createdAt: "2026-01-01T00:00:00.000Z",
              expiresAt: "2026-01-02T00:00:00.000Z",
              guestName: "Sam",
              messages: [
                {
                  id: GuestMessageId.make("guest-message:archive"),
                  text: "See the notes",
                  status: "pending",
                  submittedAt: "2026-01-01T00:00:01.000Z",
                  attachments: [
                    {
                      id: "attachment-guest-pending",
                      type: "file",
                      name: "notes.txt",
                      sizeBytes: 3,
                      mimeType: "text/plain",
                    },
                  ],
                },
              ],
            },
          },
        } satisfies OrchestrationV2DomainEvent,
      ],
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("send:guest-archive:active"),
      threadId,
      messageId: MessageId.make("message:guest-archive:active"),
      text: "active",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("send:guest-archive:queued"),
      threadId,
      messageId: MessageId.make("message:guest-archive:queued"),
      text: "queued",
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "user",
      creationSource: "web",
    });
    const queued = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
      (run) => run.status === "queued",
    );
    assert.isDefined(queued);
    yield* orchestrator.dispatch({
      type: "queued-run.cancel",
      commandId: CommandId.make("cancel:guest-archive"),
      threadId,
      runId: queued.id,
    });
    yield* orchestrator.dispatch({
      type: "thread.archive",
      commandId: CommandId.make("archive:guest-archive"),
      threadId,
    });
    const projection = yield* orchestrator.getThreadProjection(threadId);
    const decoded = decodeThreadProjection(projection);
    assert.equal(decoded.thread.guestShare?.messages[0]?.status, "pending");
    assert.equal(
      decoded.thread.guestShare?.messages[0]?.attachments?.[0]?.id,
      "attachment-guest-pending",
    );
    assert.isNotNull(decoded.thread.archivedAt);
  }).pipe(Effect.provide(layerGuestCommands)),
);

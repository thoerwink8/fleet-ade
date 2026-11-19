import { assert, it } from "@effect/vitest";
import {
  EventId,
  GuestMessageId,
  GuestShareId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectionReplay from "./testkit/ProjectionReplay.ts";

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

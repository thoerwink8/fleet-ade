import { assert, it } from "@effect/vitest";
import { RunId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as SessionEndInbox from "./SessionEndInbox.ts";

const layer = Layer.provideMerge(SessionEndInbox.layer, SqlitePersistence.layerMemory);

const entry = (status: SessionEndInbox.SessionEndStatus, run = "run:one") => ({
  threadId: ThreadId.make("thread:one"),
  runId: RunId.make(run),
  status,
  endedAt: "2026-11-16T00:00:00.000Z",
  headLookup: "unavailable" as const,
});

it.effect(
  "records one row for each terminal status and keeps it after reopening the database",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "session-end-" });
      const database = SqlitePersistence.layerFromPath(path.join(directory, "state.sqlite"));
      const provided = Layer.provideMerge(SessionEndInbox.layer, database);

      const read = Effect.gen(function* () {
        const inbox = yield* SessionEndInbox.SessionEndInbox;
        return yield* inbox.list;
      }).pipe(Effect.provide(provided));

      const first = yield* Effect.gen(function* () {
        const inbox = yield* SessionEndInbox.SessionEndInbox;
        for (const [index, status] of SessionEndInbox.SESSION_END_STATUSES.entries()) {
          const result = yield* inbox.record({
            ...entry(status, `run:${status}`),
            endedAt: `2026-11-16T00:00:0${index}.000Z`,
          });
          assert.deepEqual(result, { recorded: true, conflict: false });
        }
        return yield* inbox.list;
      }).pipe(Effect.provide(provided));

      assert.deepEqual(
        first.map((row) => row.status),
        [...SessionEndInbox.SESSION_END_STATUSES],
      );

      assert.deepEqual(yield* read, first);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("keeps the first terminal row and records a different later status as a conflict", () =>
  Effect.gen(function* () {
    const inbox = yield* SessionEndInbox.SessionEndInbox;
    const original = entry("completed");

    assert.deepEqual(yield* inbox.record(original), { recorded: true, conflict: false });
    assert.deepEqual(yield* inbox.record(original), { recorded: false, conflict: false });
    assert.deepEqual(yield* inbox.record({ ...original, status: "failed" }), {
      recorded: false,
      conflict: true,
    });

    assert.deepEqual(yield* inbox.list, [original]);
    assert.deepEqual(yield* inbox.conflicts, [
      {
        runId: original.runId,
        threadId: original.threadId,
        keptStatus: "completed",
        rejectedStatus: "failed",
        endedAt: original.endedAt,
      },
    ]);
  }).pipe(Effect.provide(layer)),
);

it.effect("keeps one conflict row and does not move the cursor backwards", () =>
  Effect.gen(function* () {
    const inbox = yield* SessionEndInbox.SessionEndInbox;
    const original = entry("completed");
    yield* inbox.record(original);
    yield* inbox.record({ ...original, status: "failed" });
    yield* inbox.record({ ...original, status: "failed" });
    assert.equal((yield* inbox.conflicts).length, 1);
    assert.equal(yield* inbox.lastSequence, 0);
    yield* inbox.noteSequence(4);
    yield* inbox.noteSequence(2);
    assert.equal(yield* inbox.lastSequence, 4);
  }).pipe(Effect.provide(layer)),
);

it.effect("keeps a missing head separate from a workspace with no commit", () =>
  Effect.gen(function* () {
    const inbox = yield* SessionEndInbox.SessionEndInbox;
    const unread = { ...entry("completed"), headLookup: "unavailable" as const };
    const found = {
      ...entry("failed", "run:two"),
      headLookup: "found" as const,
      headSha: "abc123",
    };

    yield* inbox.record(unread);
    yield* inbox.record(found);

    assert.deepEqual(yield* inbox.list, [unread, found]);
    assert.isUndefined((yield* inbox.list)[0]?.headSha);
  }).pipe(Effect.provide(layer)),
);

it.effect("fails a read instead of reporting an empty inbox", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DROP TABLE pipeline_session_end_inbox`;
    const inbox = yield* SessionEndInbox.SessionEndInbox;
    const error = yield* Effect.flip(inbox.list);
    assert.equal(error._tag, "SqlError");
  }).pipe(Effect.provide(layer)),
);

it("maps only the four terminal statuses", () => {
  assert.equal(SessionEndInbox.sessionEndStatus({ status: "completed" }), "completed");
  assert.equal(SessionEndInbox.sessionEndStatus({ status: "failed" }), "failed");
  assert.equal(SessionEndInbox.sessionEndStatus({ status: "interrupted" }), "interrupted");
  assert.equal(SessionEndInbox.sessionEndStatus({ status: "cancelled" }), "cancelled");
  assert.equal(SessionEndInbox.sessionEndStatus({ status: "rolled_back" }), "cancelled");
  assert.equal(SessionEndInbox.sessionEndStatus({ status: "running" }), undefined);
  assert.equal(
    SessionEndInbox.sessionEndStatus({
      status: "completed",
      restartCancelledBackgroundWork: [{ kind: "shell", label: "dev", awaited: true }],
    }),
    "interrupted",
  );
});

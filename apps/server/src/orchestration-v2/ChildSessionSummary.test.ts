import { assert, it } from "@effect/vitest";
import { CHILD_SUMMARY_PAGE_SIZE, ChildSummaryCursorError, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { ChildSessionSummary, ChildSessionSummaryInternal } from "./ChildSessionSummary.ts";
import type { SummaryFacts } from "./childSummaryDerive.ts";

const layerTest = ChildSessionSummary.layer.pipe(Layer.provide(SqlitePersistence.layerMemory));
const isChildSummaryCursorError = Schema.is(ChildSummaryCursorError);

const factsFor = (
  threadId: ThreadId,
  parentThreadId: ThreadId,
  createdAtMs: number,
): SummaryFacts => ({
  threadId,
  parentThreadId,
  createdAtMs,
  activityAtMs: createdAtMs,
  status: "running",
  approvalCommand: null,
  waitingForAnswer: false,
  items: [],
  goal: `goal ${threadId}`,
  taskText: null,
  branch: null,
  pr: null,
  grandchildCount: 0,
});

it.layer(layerTest)("child session summaries", (it) => {
  it.effect("pages children by creation order without duplicates", () =>
    Effect.gen(function* () {
      const internal = yield* ChildSessionSummaryInternal;
      const service = yield* ChildSessionSummary;
      const parent = ThreadId.make("thread:parent");
      for (let index = 0; index < CHILD_SUMMARY_PAGE_SIZE + 25; index += 1) {
        yield* internal.note(
          factsFor(ThreadId.make(`thread:${String(index).padStart(3, "0")}`), parent, index * 1000),
        );
      }
      const first = yield* service.list({ threadId: parent });
      assert.strictEqual(first.children.length, CHILD_SUMMARY_PAGE_SIZE);
      assert.ok(first.nextCursor !== null);
      const second = yield* service.list({ threadId: parent, cursor: first.nextCursor });
      assert.strictEqual(second.children.length, 25);
      assert.strictEqual(second.nextCursor, null);
      const ids = [...first.children, ...second.children].map((row) => row.threadId);
      assert.strictEqual(new Set(ids).size, ids.length);
      const ordered = [
        ...first.children.map((row) => row.createdAtMs),
        ...second.children.map((row) => row.createdAtMs),
      ];
      assert.deepStrictEqual(
        ordered,
        [...ordered].sort((left, right) => left - right),
      );
      const invalid = yield* service.list({ threadId: parent, cursor: "nope" }).pipe(Effect.flip);
      assert.ok(isChildSummaryCursorError(invalid));
    }),
  );

  it.effect("marks a quiet running child as stuck and bumps the revision", () =>
    Effect.gen(function* () {
      const internal = yield* ChildSessionSummaryInternal;
      const service = yield* ChildSessionSummary;
      const parent = ThreadId.make("thread:idle-parent");
      const child = ThreadId.make("thread:idle-child");
      yield* internal.note(factsFor(child, parent, 0));
      yield* TestClock.adjust("4 minutes");
      yield* internal.markIdle();
      const detail = yield* service.detail({ threadId: child });
      assert.ok(detail !== null);
      assert.strictEqual(detail.phase, "卡住");
      assert.strictEqual(detail.reason, "没动静");
      assert.strictEqual(detail.revision, 2);
    }),
  );

  it.effect("replays the snapshot then pushes a delete", () =>
    Effect.gen(function* () {
      const internal = yield* ChildSessionSummaryInternal;
      const service = yield* ChildSessionSummary;
      const parent = ThreadId.make("thread:sub-parent");
      const child = ThreadId.make("thread:sub-child");
      yield* internal.note(factsFor(child, parent, 0));
      const queue = yield* Stream.toQueue(service.subscribe(parent), {
        capacity: "unbounded",
      });
      const first = yield* Queue.take(queue);
      assert.ok(first._tag === "upsert");
      if (first._tag === "upsert") {
        assert.strictEqual(first.row.threadId, child);
      }
      yield* internal.recompute(child, null);
      const second = yield* Queue.take(queue);
      assert.ok(second._tag === "deleted");
      if (second._tag === "deleted") {
        assert.strictEqual(second.threadId, child);
      }
    }),
  );
});

import { assert, it } from "@effect/vitest";
import { ThreadId, type ChildSummaryListItem } from "@t3tools/contracts";

import {
  deriveChildSummary,
  delegateCorrectionRefusal,
  emptyPushLane,
  flushPush,
  offerPush,
  toSummaryItem,
  type SummaryFacts,
} from "./childSummaryDerive.ts";

const parent = ThreadId.make("thread:parent");
const child = ThreadId.make("thread:child");

const base = (patch: Partial<SummaryFacts> = {}): SummaryFacts => ({
  threadId: child,
  parentThreadId: parent,
  createdAtMs: 0,
  activityAtMs: 0,
  status: "running",
  approvalCommand: null,
  waitingForAnswer: false,
  items: [],
  goal: "把登录改好",
  taskText: null,
  branch: "local/112",
  pr: null,
  grandchildCount: 0,
  ...patch,
});

const row = (patch: Partial<ChildSummaryListItem> = {}): ChildSummaryListItem => ({
  threadId: child,
  parentThreadId: parent,
  revision: 1,
  phase: "在做",
  reason: "在跑",
  conclusion: null,
  needsYou: false,
  activity: "正在启动",
  goalSummary: "把登录改好",
  grandchildCount: 0,
  grandchildNote: null,
  createdAtMs: 0,
  updatedAt: "2026-11-19T00:00:00.000Z",
  ...patch,
});

it("names a file edit and a command without keeping the diff or output", () => {
  const derived = deriveChildSummary(
    base({
      items: [
        {
          type: "file_change",
          status: "completed",
          fileName: "apps/web/src/Login.tsx",
          additions: 3,
          deletions: 1,
        },
        { type: "command_execution", status: "completed", command: "vp test run a\nfull output" },
      ],
    }),
    0,
  );
  assert.strictEqual(derived.list.activity, "在改 Login.tsx");
  assert.strictEqual(derived.list.phase, "在做");
  assert.strictEqual(derived.detail.latestCommand, "vp test run a");
  assert.deepStrictEqual(derived.detail.files, [
    { path: "apps/web/src/Login.tsx", additions: 3, deletions: 1 },
  ]);
  assert.strictEqual(derived.detail.avoid, "没有写别碰");
  assert.strictEqual("diffStr" in derived.detail, false);
});

it("truncates a command and an assistant line to 80 characters", () => {
  const long = "a".repeat(120);
  const command = deriveChildSummary(
    base({ items: [{ type: "command_execution", status: "running", command: long }] }),
    0,
  );
  assert.strictEqual(command.list.activity, `在跑 ${"a".repeat(80)}`);
  assert.strictEqual(command.idleEligible, false);
  const assistant = deriveChildSummary(
    base({ items: [{ type: "assistant_message", status: "completed", text: `${long}\nsecond` }] }),
    0,
  );
  assert.strictEqual(assistant.list.activity, "a".repeat(80));
});

it("keeps a running command and a pending answer out of silence", () => {
  const running = deriveChildSummary(
    base({ items: [{ type: "command_execution", status: "running", command: "vp test" }] }),
    10 * 60 * 1000,
  );
  assert.strictEqual(running.list.phase, "在做");
  assert.strictEqual(running.list.reason, "在跑");
  const waiting = deriveChildSummary(base({ waitingForAnswer: true }), 10 * 60 * 1000);
  assert.strictEqual(waiting.list.phase, "在做");
  assert.strictEqual(waiting.list.activity, "在等你回答");
  assert.strictEqual(waiting.list.needsYou, false);
});

it("marks three quiet minutes as stuck without rewriting the sentence", () => {
  const quiet = deriveChildSummary(
    base({ items: [{ type: "file_change", status: "completed", fileName: "a.ts" }] }),
    3 * 60 * 1000,
  );
  assert.strictEqual(quiet.list.phase, "卡住");
  assert.strictEqual(quiet.list.reason, "没动静");
  assert.strictEqual(quiet.list.activity, "在改 a.ts");
  assert.strictEqual(quiet.list.needsYou, false);
  const before = deriveChildSummary(
    base({ items: [{ type: "file_change", status: "completed", fileName: "a.ts" }] }),
    3 * 60 * 1000 - 1,
  );
  assert.strictEqual(before.list.phase, "在做");
});

it("marks a live delegation timed out without ending it", () => {
  const timedOut = deriveChildSummary(base({ status: "running", timedOut: true }), 0).list;
  assert.strictEqual(timedOut.phase, "卡住");
  assert.strictEqual(timedOut.reason, "超时");
  assert.strictEqual(timedOut.conclusion, null);
  const finished = deriveChildSummary(base({ status: "completed", timedOut: true }), 0).list;
  assert.strictEqual(finished.reason, "没有 PR");
});

it("treats command approval as the only needs-you stuck reason", () => {
  const approval = deriveChildSummary(
    base({ status: "waiting", approvalCommand: "rm -rf data\nextra" }),
    0,
  );
  assert.strictEqual(approval.list.phase, "卡住");
  assert.strictEqual(approval.list.needsYou, true);
  assert.strictEqual(approval.list.reason, "等你批准：rm -rf data");
  assert.strictEqual(approval.list.conclusion, null);
});

it("maps queue, failure, cancel, and pull-request conclusions", () => {
  assert.strictEqual(deriveChildSummary(base({ status: "queued" }), 0).list.reason, "排队中");
  const failed = deriveChildSummary(base({ status: "failed" }), 0).list;
  assert.strictEqual(failed.phase, "卡住");
  assert.strictEqual(failed.reason, "失败");
  assert.strictEqual(failed.needsYou, false);
  assert.strictEqual(
    deriveChildSummary(base({ status: "cancelled" }), 0).list.conclusion,
    "已取消",
  );
  const completed = deriveChildSummary(base({ status: "completed" }), 0).list;
  assert.strictEqual(completed.phase, "做完");
  assert.strictEqual(completed.reason, "没有 PR");
  assert.strictEqual(completed.conclusion, "没有 PR");
  assert.strictEqual(completed.activity, "没有 PR");
  assert.strictEqual(completed.needsYou, false);
  assert.strictEqual(
    deriveChildSummary(base({ status: "completed", pr: { number: 4, state: "open" } }), 0).list
      .conclusion,
    "等验收",
  );
  assert.strictEqual(
    deriveChildSummary(base({ status: "completed", pr: { number: 4, state: "merged" } }), 0).list
      .reason,
    "已合并",
  );
  assert.strictEqual(
    deriveChildSummary(base({ status: "completed", pr: { number: 4, state: "closed" } }), 0).list
      .reason,
    "PR 已关闭",
  );
  assert.strictEqual(
    deriveChildSummary(base({ status: "completed", pr: { number: 4, state: "unknown" } }), 0).list
      .conclusion,
    "合并状态未知",
  );
});

it("counts grandchildren on the row and does not invent an outlook", () => {
  const derived = deriveChildSummary(base({ grandchildCount: 2 }), 0);
  assert.strictEqual(derived.list.grandchildNote, "它还派了 2 个");
  assert.strictEqual(derived.detail.outlook, null);
});

it("drops command output and diffs when reading a turn item", () => {
  const item = toSummaryItem({
    type: "command_execution",
    status: "completed",
    input: "vp test",
    output: "secret log",
    diffStr: "should not survive",
  });
  assert.deepStrictEqual(item, {
    type: "command_execution",
    status: "completed",
    command: "vp test",
  });
  assert.strictEqual("output" in item, false);
});

it("sends the terminal row immediately and does not drop it inside the throttle window", () => {
  const first = offerPush(emptyPushLane, row({ activity: "在改 a.ts", revision: 1 }), 0);
  assert.strictEqual(first.emit?.activity, "在改 a.ts");
  const second = offerPush(first.lane, row({ activity: "在改 b.ts", revision: 2 }), 100);
  assert.strictEqual(second.emit, null);
  assert.strictEqual(second.armMs, 2000);
  const done = offerPush(
    second.lane,
    row({
      phase: "做完",
      reason: "没有 PR",
      conclusion: "没有 PR",
      activity: "没有 PR",
      revision: 3,
    }),
    500,
  );
  assert.strictEqual(done.emit?.phase, "做完");
  assert.strictEqual(done.lane.pending, null);
  const late = flushPush(done.lane, 3000);
  assert.strictEqual(late.emit, null);
});

it("coalesces non-terminal updates into the flush and skips an unchanged row", () => {
  const first = offerPush(emptyPushLane, row({ revision: 1 }), 0);
  const second = offerPush(first.lane, row({ activity: "在改 a.ts", revision: 2 }), 100);
  const third = offerPush(second.lane, row({ activity: "在改 b.ts", revision: 3 }), 200);
  assert.strictEqual(third.armMs, null);
  const flushed = flushPush(third.lane, 2100);
  assert.strictEqual(flushed.emit?.activity, "在改 b.ts");
  const again = offerPush(flushed.lane, flushed.emit!, 2200);
  assert.strictEqual(again.emit, null);
});

it("pushes a needs-you change without waiting", () => {
  const first = offerPush(emptyPushLane, row(), 0);
  const approval = offerPush(
    first.lane,
    row({ phase: "卡住", reason: "等你批准：rm", needsYou: true, revision: 2 }),
    50,
  );
  assert.strictEqual(approval.emit?.needsYou, true);
});

it("refuses a send once a delegated child was stopped", () => {
  const delegated = {
    lineage: { relationshipToParent: "subagent" as const },
    creationSource: "server",
    status: "cancelled",
  };
  assert.strictEqual(delegateCorrectionRefusal(delegated), "这条已经停了");
  assert.strictEqual(
    delegateCorrectionRefusal({ ...delegated, status: "interrupted" }),
    "这条已经停了",
  );
  assert.strictEqual(delegateCorrectionRefusal({ ...delegated, status: "completed" }), undefined);
  assert.strictEqual(delegateCorrectionRefusal({ ...delegated, status: "running" }), undefined);
  assert.strictEqual(
    delegateCorrectionRefusal({
      lineage: { relationshipToParent: null },
      creationSource: "web",
      status: "cancelled",
    }),
    undefined,
  );
});

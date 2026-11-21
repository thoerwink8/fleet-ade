import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { type ClosedViewEntry, useClosedViewStore } from "./closedViewStore";

const refA = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-A"));
const refB = scopeThreadRef("env-2" as EnvironmentId, ThreadId.make("thread-A"));
const diff = (threadRef: typeof refA) =>
  ({ kind: "panel-tab", threadRef, surface: { kind: "diff", id: "diff" } }) as const;

beforeEach(() => {
  useClosedViewStore.setState({ entries: [] });
});

describe("closedViewStore", () => {
  it.each([
    { id: "bad", kind: "panel-tab", surface: { kind: "diff", id: "diff" } },
    { id: "bad", kind: "panel-tab", threadRef: refA },
    { id: "bad", kind: "panel-tab", threadRef: {}, surface: { kind: "diff", id: "diff" } },
    { id: "bad", kind: "panel-tab", threadRef: refA, surface: {} },
    { id: "bad", kind: "panel-tab", threadRef: refA, surface: { kind: "file", id: "file:x" } },
    {
      id: "bad",
      kind: "panel-tab",
      threadRef: refA,
      surface: { kind: "device", id: "device:x", target: {} },
    },
    {
      id: "bad",
      kind: "panel-tab",
      threadRef: refA,
      surface: { kind: "pull-request", id: "pull-request:x", repository: "owner/repo", number: 1 },
    },
    {
      id: "bad",
      kind: "panel-tab",
      threadRef: refA,
      surface: { kind: "side-chat", id: "side-chat:x" },
    },
  ])("discards incomplete saved views %j while retaining valid history", async (entry) => {
    const id = useClosedViewStore.getState().remember(diff(refA));
    const { storage, name } = useClosedViewStore.persist.getOptions();
    await storage!.setItem(name!, {
      state: { entries: [entry as ClosedViewEntry, ...useClosedViewStore.getState().entries] },
      version: 1,
    });
    await useClosedViewStore.persist.rehydrate();
    expect(useClosedViewStore.persist.hasHydrated()).toBe(true);
    expect(useClosedViewStore.getState().entries).toEqual([{ ...diff(refA), id }]);
    expect(() => useClosedViewStore.getState().remember(diff(refB))).not.toThrow();
  });

  it("removes private metadata and malformed entries from history saved by earlier versions", async () => {
    const store = useClosedViewStore.getState();
    const sideChatId = store.remember({
      kind: "panel-tab",
      threadRef: refA,
      surface: { id: "side-chat:side", kind: "side-chat", threadId: ThreadId.make("side") },
    });
    const publicId = store.remember(diff(refA));
    const { storage, name } = useClosedViewStore.persist.getOptions();
    await storage!.setItem(name!, {
      state: {
        entries: [null, {}, ...useClosedViewStore.getState().entries] as ClosedViewEntry[],
      },
      version: 0,
    });
    await useClosedViewStore.persist.rehydrate();
    expect(useClosedViewStore.persist.hasHydrated()).toBe(true);
    expect(useClosedViewStore.getState().entries.map((entry) => entry.id)).toEqual([
      publicId,
      sideChatId,
    ]);
    const saved = JSON.stringify(await storage!.getItem(name!));
    expect(saved).not.toContain("private.example");
    expect(saved).not.toContain("Private page");
  });
});

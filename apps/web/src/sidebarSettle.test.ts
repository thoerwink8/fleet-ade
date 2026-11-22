import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { registerSidebarSettle, settleSidebarThread } from "./sidebarSettle";

const threadRef = scopeThreadRef(
  EnvironmentId.make("environment-local"),
  ThreadId.make("thread-1"),
);

describe("sidebarSettle", () => {
  it("keeps a remounted sidebar's handler when the old one unmounts late", () => {
    const settledBy: string[] = [];
    const unregisterOld = registerSidebarSettle(() => settledBy.push("old"));
    const unregisterNew = registerSidebarSettle(() => settledBy.push("new"));
    unregisterOld();

    expect(settleSidebarThread(threadRef)).toBe(true);
    expect(settledBy).toEqual(["new"]);
    unregisterNew();
    expect(settleSidebarThread(threadRef)).toBe(false);
  });
});

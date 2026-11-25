import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { navigateAfterThreadDeletion, selectNextThreadKeyAfterArchive } from "./useThreadActions";
import { toastManager } from "../components/ui/toast";

describe("navigateAfterThreadDeletion", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reports a rejected navigation without failing the completed deletion", async () => {
    const addToast = vi.spyOn(toastManager, "add").mockReturnValue("navigation-error");

    await expect(
      navigateAfterThreadDeletion(() => Promise.reject(new Error("route unavailable"))),
    ).resolves.toBeUndefined();

    expect(addToast).toHaveBeenCalledOnce();
    expect(addToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "会话已删除，但无法跳转页面",
        description: "route unavailable",
      }),
    );
  });
});

describe("selectNextThreadKeyAfterArchive", () => {
  it("picks the next thread in sidebar order for middle and first items", () => {
    expect(
      selectNextThreadKeyAfterArchive({
        orderedThreadKeys: ["a", "b", "c"],
        currentThreadKey: "b",
      }),
    ).toBe("c");
    expect(
      selectNextThreadKeyAfterArchive({
        orderedThreadKeys: ["a", "b", "c"],
        currentThreadKey: "a",
      }),
    ).toBe("b");
  });

  it("picks the previous thread when archiving the last item", () => {
    expect(
      selectNextThreadKeyAfterArchive({
        orderedThreadKeys: ["a", "b", "c"],
        currentThreadKey: "c",
      }),
    ).toBe("b");
  });

  it("returns null when the archived thread is the only item or the list is empty", () => {
    expect(
      selectNextThreadKeyAfterArchive({
        orderedThreadKeys: ["a"],
        currentThreadKey: "a",
      }),
    ).toBeNull();
    expect(
      selectNextThreadKeyAfterArchive({
        orderedThreadKeys: [],
        currentThreadKey: "a",
      }),
    ).toBeNull();
  });

  it("skips co-archived threads in a batch and keeps failed ones as candidates", () => {
    expect(
      selectNextThreadKeyAfterArchive({
        orderedThreadKeys: ["a", "b", "c", "d"],
        currentThreadKey: "b",
        removedThreadKeys: new Set(["b", "c"]),
      }),
    ).toBe("d");
    expect(
      selectNextThreadKeyAfterArchive({
        orderedThreadKeys: ["a", "b", "c"],
        currentThreadKey: "b",
        removedThreadKeys: new Set(["b", "c"]),
      }),
    ).toBe("a");
    expect(
      selectNextThreadKeyAfterArchive({
        orderedThreadKeys: ["a", "b", "c"],
        currentThreadKey: "a",
        removedThreadKeys: new Set(["a"]),
      }),
    ).toBe("b");
    expect(
      selectNextThreadKeyAfterArchive({
        orderedThreadKeys: ["a", "b"],
        currentThreadKey: "a",
        removedThreadKeys: new Set(["a", "b"]),
      }),
    ).toBeNull();
  });

  it("falls back to the first surviving thread when the current key is unlisted", () => {
    expect(
      selectNextThreadKeyAfterArchive({
        orderedThreadKeys: ["a", "b"],
        currentThreadKey: "unlisted",
        removedThreadKeys: new Set(["a"]),
      }),
    ).toBe("b");
  });
});

import { renderToStaticMarkup } from "react-dom/server";
import { AsyncResult } from "effect/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import * as ThreadUndo from "@t3tools/client-runtime/state/thread-undo";

import { toastManager } from "../ui/toast";
import { showThreadUndoNotice } from "../../hooks/showThreadUndoNotice";
import { SidebarThreadUndoNotice } from "./SidebarThreadUndoNotice";

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => [],
}));
vi.mock("../../lib/announce", () => ({ announce: vi.fn(), cancelAnnouncement: vi.fn() }));
// Zustand's SSR snapshot returns getInitialState() (always null); read live store state in unit render.
vi.mock("../../hooks/showThreadUndoNotice", async (original) => {
  const actual = await original<typeof import("../../hooks/showThreadUndoNotice")>();
  return {
    ...actual,
    useThreadUndoNotice: (
      selector: (state: ReturnType<typeof actual.useThreadUndoNotice.getState>) => unknown,
    ) => selector(actual.useThreadUndoNotice.getState()),
  };
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.runAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("SidebarThreadUndoNotice", () => {
  it("does not render in the sidebar footer when the active undo notice is Settled", () => {
    vi.spyOn(toastManager, "add").mockReturnValue("settle-toast");
    vi.spyOn(toastManager, "close").mockImplementation(() => {});

    showThreadUndoNotice({
      action: "Settled",
      failureTitle: "无法撤销标为完成",
      undo: async () => AsyncResult.success(undefined),
      claim: ThreadUndo.begin("settle", "env/settled-thread"),
    });

    expect(renderToStaticMarkup(<SidebarThreadUndoNotice />)).toBe("");
  });

  it("still renders non-settled undo notices in the sidebar footer", () => {
    showThreadUndoNotice({
      action: "Unpinned",
      failureTitle: "无法撤销取消置顶",
      undo: async () => AsyncResult.success(undefined),
      claim: ThreadUndo.begin("pin", "env/unpinned-thread"),
    });

    const html = renderToStaticMarkup(<SidebarThreadUndoNotice />);
    expect(html).toContain("已取消置顶，");
    expect(html).toContain("撤销");
  });
});

import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { makeThreadFixture } from "../../test-fixtures";
import { useThreadSelectionStore } from "../../threadSelectionStore";
import { SidebarBatchBar } from "./SidebarBatchBar";

vi.mock("../../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/session")>()),
  readEnvironmentScope: () => true,
  useEnvironmentScope: () => true,
}));

const environmentId = EnvironmentId.make("environment-test");

async function menuLabelsAtWidth(width: number): Promise<string[]> {
  const thread = makeThreadFixture({ environmentId, id: ThreadId.make("thread-1") });
  const container = document.createElement("div");
  container.style.width = `${width}px`;
  useThreadSelectionStore.getState().replaceSelection([`${environmentId}:thread-1`]);
  await using screen = await render(
    <SidebarBatchBar
      threadByKey={new Map([[`${environmentId}:thread-1`, thread as never]])}
      orderedThreadCount={3}
      serverConfigs={new Map([[environmentId, {} as never]])}
      onAction={() => {}}
      snoozePresets={[]}
      nowIso="2026-03-10T12:00:00.000Z"
      onClearSelection={() => {}}
    />,
    { container },
  );
  await userEvent.click(page.getByRole("button", { name: "更多批量操作" }));
  const labels = [...document.querySelectorAll('[role="menuitem"]')].map(
    (item) => item.textContent?.trim() ?? "",
  );
  void screen;
  return labels;
}

describe("SidebarBatchBar", () => {
  it("offers the same actions in its menu whether the bar is spread out or collapsed", async () => {
    const spreadOut = await menuLabelsAtWidth(420);
    useThreadSelectionStore.getState().clearSelection();
    const collapsed = await menuLabelsAtWidth(260);
    useThreadSelectionStore.getState().clearSelection();
    expect(spreadOut).toContain("重新生成标题");
    expect(spreadOut).toContain("标为未读");
    expect(collapsed).toEqual(spreadOut);
  });
});

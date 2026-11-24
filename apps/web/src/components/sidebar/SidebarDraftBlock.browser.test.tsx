import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, MessageId, ProjectId, ThreadId } from "@t3tools/contracts";
import { Profiler } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render } from "../../../test/render";
import { formatAssistantCitationForComposer } from "../../composer-logic";
import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { undoLatestThreadAction, useThreadUndoNotice } from "../../hooks/showThreadUndoNotice";
import { attachSidebarTree } from "../../lib/sidebarTree";
import { TooltipProvider } from "../ui/tooltip";
import { SidebarDraftBlock } from "./SidebarDraftBlock";

it("keeps draft previews current through edits, promotion and removal", async () => {
  const initial = useComposerDraftStore.getState();
  using _store = {
    [Symbol.dispose]: () => useComposerDraftStore.setState(initial, true),
  };
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
  });
  const environmentId = EnvironmentId.make("draft-preview-environment");
  const projectRef = scopeProjectRef(environmentId, ProjectId.make("draft-preview-project"));
  const draftId = DraftId.make("draft-preview");
  const threadId = ThreadId.make("draft-preview-thread");
  const onRender = vi.fn();
  await using screen = await render(
    <Profiler id="draft-block" onRender={onRender}>
      <ul>
        <SidebarDraftBlock
          projectByKey={new Map()}
          projectDisplayNameByKey={new Map()}
          scopedProjectKeys={null}
          routeDraftId={null}
          onNavigateToDraft={vi.fn()}
          onDraftContextMenu={vi.fn()}
        />
      </ul>
    </Profiler>,
  );
  const row = screen.getByTestId("sidebar-draft-row");
  await expect.element(row).not.toBeInTheDocument();

  await act(() => {
    initial.setProjectDraftThreadId(projectRef, draftId, { threadId });
    initial.setPrompt(draftId, "First draft preview");
  });
  await expect.element(row).toHaveAccessibleName("First draft preview, 未发送的草稿");

  const rendersBeforeOtherComposer = onRender.mock.calls.length;
  await act(() =>
    initial.setPrompt(scopeThreadRef(environmentId, ThreadId.make("other")), "Other composer"),
  );
  expect(onRender).toHaveBeenCalledTimes(rendersBeforeOtherComposer);
  await act(() => initial.setPrompt(draftId, "Updated draft preview"));
  await expect.element(row).toHaveAccessibleName("Updated draft preview, 未发送的草稿");

  const quote = "Cache the parsed config per worktree.";
  const citation = formatAssistantCitationForComposer({
    version: 1,
    environmentId,
    threadId: ThreadId.make("source-thread"),
    messageId: MessageId.make("source-message"),
    text: quote,
    start: 0,
    end: quote.length,
    prefix: "",
    suffix: "",
  });
  await act(() => initial.setPrompt(draftId, `${citation}Why per worktree?`));
  await expect.element(row).toHaveAccessibleName(`${quote} Why per worktree?, 未发送的草稿`);

  await act(() => initial.markDraftThreadPromoting(draftId));
  await expect.element(row).not.toBeInTheDocument();
  await act(() => initial.clearDraftThread(draftId));

  const nextDraftId = DraftId.make("next-draft-preview");
  await act(() => {
    initial.setProjectDraftThreadId(projectRef, nextDraftId, { threadId: ThreadId.make("next") });
    initial.setPrompt(nextDraftId, "Next draft preview");
  });
  await expect.element(row).toHaveAccessibleName("Next draft preview, 未发送的草稿");
  await act(() => initial.clearDraftThread(nextDraftId));
  await expect.element(row).not.toBeInTheDocument();
});

it("preserves draft click, keyboard navigation, context menu, hover details, discard, and undo", async () => {
  const initial = useComposerDraftStore.getState();
  using _store = {
    [Symbol.dispose]: () => useComposerDraftStore.setState(initial, true),
  };
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
  });
  const environmentId = EnvironmentId.make("draft-behavior-env");
  const projectId = ProjectId.make("draft-behavior-project");
  const projectRef = scopeProjectRef(environmentId, projectId);
  const projectKey = `${environmentId}:${projectId}`;
  const firstDraftId = DraftId.make("draft-1");
  const secondDraftId = DraftId.make("draft-2");
  initial.setProjectDraftThreadId(projectRef, firstDraftId, {
    threadId: ThreadId.make("thread-draft-1"),
    branch: "feat/draft-branch",
    createdAt: "2026-11-24T10:00:00.000Z",
  });
  initial.setPrompt(firstDraftId, "同一项目草稿\n第二行详细内容");
  initial.setProjectDraftThreadId(projectRef, secondDraftId, {
    threadId: ThreadId.make("thread-draft-2"),
    createdAt: "2026-11-24T09:00:00.000Z",
  });
  initial.setPrompt(secondDraftId, "同一项目草稿");

  const onNavigateToDraft = vi.fn();
  const onDraftContextMenu = vi.fn();
  const project = {
    environmentId,
    workspaceRoot: "/work/fleet-ade",
    title: "fleet-ade",
    faviconPath: null,
    projectIcon: { kind: "monogram" as const, text: "FA", color: "blue" as const },
  };

  await using screen = await render(
    <TooltipProvider delay={150}>
      <ul ref={attachSidebarTree}>
        <SidebarDraftBlock
          projectByKey={new Map([[projectKey, project as never]])}
          projectDisplayNameByKey={new Map([[projectKey, "fleet-ade"]])}
          scopedProjectKeys={null}
          routeDraftId={null}
          onNavigateToDraft={onNavigateToDraft}
          onDraftContextMenu={onDraftContextMenu}
        />
      </ul>
    </TooltipProvider>,
    { router: "/threads/1" },
  );

  const rows = [
    ...screen.container.querySelectorAll<HTMLElement>('[data-testid="sidebar-draft-row"]'),
  ];
  expect(rows).toHaveLength(2);
  const [firstRow, secondRow] = rows as [HTMLElement, HTMLElement];

  // Hover opens lazy details card with project favicon, branch, multiline body, and status.
  expect(document.querySelector('[data-testid="sidebar-draft-details"]')).toBeNull();
  await userEvent.hover(firstRow);
  await vi.waitFor(() => {
    expect(document.querySelector('[data-testid="sidebar-draft-details"]')).not.toBeNull();
  });
  expect(
    document.querySelector('[data-testid="sidebar-draft-detail-body"]')?.textContent,
  ).toContain("第二行详细内容");
  const projectDetails = document.querySelector<HTMLElement>(
    '[data-testid="sidebar-draft-project"]',
  )!;
  expect(projectDetails.textContent).toContain("fleet-ade");
  const icon = projectDetails.querySelector<HTMLElement>("span[aria-hidden]")!;
  expect(icon.offsetWidth).toBe(12);
  expect(icon.offsetHeight).toBe(12);
  expect(document.querySelector('[data-testid="sidebar-draft-branch"]')?.textContent).toContain(
    "feat/draft-branch",
  );
  expect(document.querySelector('[data-testid="sidebar-draft-status"]')?.textContent).toContain(
    "未发送的草稿",
  );
  await userEvent.unhover(firstRow);
  await vi.waitFor(() => {
    expect(document.querySelector('[data-testid="sidebar-draft-details"]')).toBeNull();
  });

  // Touch details button opens the details card directly.
  firstRow.querySelector<HTMLButtonElement>('button[aria-label="草稿详情"]')!.click();
  await vi.waitFor(() => {
    expect(document.querySelector('[data-testid="sidebar-draft-details"]')).not.toBeNull();
  });

  // Click opens draft.
  await userEvent.click(firstRow);
  expect(onNavigateToDraft).toHaveBeenCalledWith(firstDraftId);

  // Keyboard navigation + Enter + Shift+F10 / contextmenu.
  firstRow.focus();
  await userEvent.keyboard("{ArrowDown}");
  expect(document.activeElement).toBe(secondRow);
  await userEvent.keyboard("{ArrowUp}");
  expect(document.activeElement).toBe(firstRow);
  onNavigateToDraft.mockClear();
  await userEvent.keyboard("{Enter}");
  expect(onNavigateToDraft).toHaveBeenCalledWith(firstDraftId);

  secondRow.focus();
  secondRow.dispatchEvent(
    new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true, cancelable: true }),
  );
  secondRow.dispatchEvent(
    new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 24, clientY: 48 }),
  );
  expect(onDraftContextMenu).toHaveBeenCalledWith(secondDraftId, expect.any(Object));
  expect(onDraftContextMenu).toHaveBeenCalledWith(secondDraftId, { x: 24, y: 48 });

  // Discard does not navigate, sets undo notice, and undo restores the discarded draft.
  onNavigateToDraft.mockClear();
  firstRow.querySelector<HTMLButtonElement>('button[aria-label="丢弃草稿"]')!.click();
  expect(onNavigateToDraft).not.toHaveBeenCalled();
  await vi.waitFor(() => {
    expect(screen.container.querySelectorAll('[data-testid="sidebar-draft-row"]')).toHaveLength(1);
  });
  expect(useThreadUndoNotice.getState().notice?.action).toBe("Discarded");

  await act(() => {
    undoLatestThreadAction();
  });
  await vi.waitFor(() => {
    expect(screen.container.querySelectorAll('[data-testid="sidebar-draft-row"]')).toHaveLength(2);
  });
});

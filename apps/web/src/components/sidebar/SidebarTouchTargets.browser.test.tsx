import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { createRef } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { makeThreadFixture } from "../../test-fixtures";
import { ProjectPinButton } from "../ProjectPinButton";
import { SidebarProvider } from "../ui/sidebar";
import { SidebarChromeFooter, SidebarChromeHeader } from "./SidebarChrome";
import { SidebarHeaderActions, SidebarThreadHeader } from "./SidebarThreadHeader";
import { SortableThreadRow } from "./SidebarThreadRow";

vi.mock("../../state/environments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/environments")>()),
  usePullRequestsSupported: () => true,
}));

vi.mock("../../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/session")>()),
  readEnvironmentScope: () => true,
  useEnvironmentScope: () => true,
}));

vi.mock("../../state/entities", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/entities")>()),
  useThreadShell: () => null,
}));

const noop = () => {};

function makeRowProps(overrides: {
  id: string;
  title: string;
  variant: "card" | "slim";
  variantAction: "settle" | "unsettle";
  isPinned: boolean;
}) {
  const thread = makeThreadFixture({
    environmentId: EnvironmentId.make("local"),
    projectId: ProjectId.make("project-1"),
    id: ThreadId.make(overrides.id),
    title: overrides.title,
    ...(overrides.variantAction === "unsettle"
      ? { settledOverride: "settled" as const, settledAt: "2026-03-10T12:00:00.000Z" }
      : {}),
  });
  return {
    sortableId: `thread:${overrides.id}`,
    sortableDisabled: true,
    contextDrag: false,
    thread,
    variant: overrides.variant,
    variantAction: overrides.variantAction,
    settlementSupported: true,
    snoozeSupported: true,
    pinningSupported: true,
    isPinned: overrides.isPinned,
    dropVerb: null,
    dragOverPinned: false,
    sweepAction: null,
    snoozeWakeLabelText: null,
    wokeAt: null,
    isActive: false,
    isRouteThread: false,
    openPullRequestsInRightPanel: false,
    jumpLabel: null,
    currentEnvironmentId: "local",
    environmentLabel: null,
    environmentMachine: "desktop" as const,
    scratchMachineLabel: null,
    project: null,
    projectDisplayName: "fleet-ade",
    providerEntryByInstanceId: new Map(),
    timestampFormat: "24-hour" as const,
    onThreadClick: noop,
    onThreadActivate: noop,
    onStartRename: noop,
    onRenameTitleChange: noop,
    onCommitRename: noop,
    onCancelRename: noop,
    isRenaming: false,
    renamingTitle: "",
    onContextMenu: noop,
    onSettle: noop,
    onActionSweepStart: noop,
    onUnsettle: noop,
    onSnooze: noop,
    onUnsnooze: noop,
    onUnpin: noop,
    onAcknowledgeWoke: noop,
  };
}

function SidebarTouchHarness() {
  const searchInputRef = createRef<HTMLInputElement>();
  const projectScopeAnchorRef = createRef<HTMLSpanElement>();
  return (
    <SidebarProvider>
      <div className="flex w-full max-w-[378px] flex-col bg-sidebar text-sidebar-foreground">
        <SidebarChromeHeader
          isElectron={false}
          actions={
            <SidebarHeaderActions
              hasProjects
              projectScope={null}
              projectScopeActive={false}
              projectScopeAnchorRef={projectScopeAnchorRef}
              onOpenProjectScope={noop}
              onNewProject={noop}
              onNewThread={noop}
              newThreadDisabled={false}
              newThreadShortcutLabel={null}
              newThreadInProjectShortcutLabel={null}
              showNewThreadInProjectHint={false}
            />
          }
        />
        <div className="px-3 pb-3">
          <SidebarThreadHeader
            searchInputRef={searchInputRef}
            searchShortcutLabel={null}
            searchQuery="foo"
            onSearchQueryChange={noop}
            onSearchKeyDown={noop}
            isSearching
            searchResultCount={0}
            activeSearchResultIndex={0}
            onClearSearch={noop}
          />
        </div>
        <ul className="flex flex-col px-2">
          <SortableThreadRow
            {...makeRowProps({
              id: "card-active",
              title: "置顶活跃会话",
              variant: "card",
              variantAction: "settle",
              isPinned: true,
            })}
          />
          <SortableThreadRow
            {...makeRowProps({
              id: "card-settled",
              title: "已收尾会话",
              variant: "card",
              variantAction: "unsettle",
              isPinned: false,
            })}
          />
          <SortableThreadRow
            {...makeRowProps({
              id: "slim-active",
              title: "紧凑行会话",
              variant: "slim",
              variantAction: "settle",
              isPinned: true,
            })}
          />
        </ul>
        <div className="flex items-center px-3 py-1">
          <ProjectPinButton name="fleet-ade" pinned onToggle={noop} />
        </div>
        <SidebarChromeFooter />
      </div>
    </SidebarProvider>
  );
}

function expectHitTargetAtLeast(element: Element, minSize = 32) {
  const rect = element.getBoundingClientRect();
  expect(
    rect.width,
    `${element.getAttribute("aria-label") ?? element.getAttribute("title") ?? element.tagName} width`,
  ).toBeGreaterThanOrEqual(minSize);
  expect(
    rect.height,
    `${element.getAttribute("aria-label") ?? element.getAttribute("title") ?? element.tagName} height`,
  ).toBeGreaterThanOrEqual(minSize);
}

describe("sidebar mobile touch targets", () => {
  it("expands thread-row actions and sidebar chrome buttons to >= 32x32 at 390x844 while keeping icons compact", async () => {
    await page.viewport(390, 844);
    await using screen = await render(<SidebarTouchHarness />);

    const cardRow = screen.container.querySelector<HTMLElement>(
      '[data-sidebar-row="local:card-active"]',
    )!;
    const settledCardRow = screen.container.querySelector<HTMLElement>(
      '[data-sidebar-row="local:card-settled"]',
    )!;
    const slimRow = screen.container.querySelector<HTMLElement>(
      '[data-sidebar-row="local:slim-active"]',
    )!;

    const cardUnpin = cardRow.querySelector<HTMLButtonElement>(
      'button[aria-label="取消置顶会话"]',
    )!;
    const cardSnooze = cardRow.querySelector<HTMLButtonElement>('button[aria-label="暂缓会话"]')!;
    const cardSettle = cardRow.querySelector<HTMLButtonElement>('button[aria-label="收尾会话"]')!;
    const cardUnsettle = settledCardRow.querySelector<HTMLButtonElement>(
      'button[aria-label="取消会话收尾"]',
    )!;
    const slimUnpin = slimRow.querySelector<HTMLButtonElement>(
      'button[aria-label="取消置顶会话"]',
    )!;
    const slimSettle = slimRow.querySelector<HTMLButtonElement>('button[aria-label="收尾会话"]')!;

    const mobileTargets = [
      screen.container.querySelector('button[aria-label="切换主侧边栏"]')!,
      screen.container.querySelector('button[aria-label="更多"]')!,
      screen.container.querySelector('button[aria-label="新建会话"]')!,
      screen.container.querySelector('button[aria-label="清除会话搜索"]')!,
      cardUnpin,
      cardSnooze,
      cardSettle,
      cardUnsettle,
      slimUnpin,
      slimSettle,
      screen.container.querySelector('button[title="Unpin fleet-ade"]')!,
      screen.container.querySelector('button[aria-label="设置"]')!,
      screen.container.querySelector('button[aria-label="PR"]')!,
      screen.container.querySelector('button[aria-label="用量"]')!,
      screen.container.querySelector('button[aria-label="机群"]')!,
    ];

    for (const target of mobileTargets) {
      expect(target).not.toBeNull();
      expectHitTargetAtLeast(target, 32);
    }

    // Hovering a card row reveals the action group inline; boxes must remain >= 32x32 and inside the row.
    await userEvent.hover(cardRow);
    const cardRect = cardRow.getBoundingClientRect();
    for (const button of [cardUnpin, cardSnooze, cardSettle]) {
      expectHitTargetAtLeast(button, 32);
      const rect = button.getBoundingClientRect();
      expect(rect.top).toBeGreaterThanOrEqual(cardRect.top);
      expect(rect.bottom).toBeLessThanOrEqual(cardRect.bottom);
    }

    // Visual icons stay compact instead of scaling up to fill the 32x32 hit box.
    expect(cardUnpin.querySelector("svg")!.getBoundingClientRect().width).toBeLessThanOrEqual(16);
    expect(cardSnooze.querySelector("svg")!.getBoundingClientRect().width).toBeLessThanOrEqual(16);
    expect(
      screen.container.querySelector('button[aria-label="设置"] svg')!.getBoundingClientRect()
        .width,
    ).toBeLessThanOrEqual(18);
  });

  it("keeps compact desktop button sizes at 1280x800", async () => {
    await page.viewport(1280, 800);
    await using screen = await render(<SidebarTouchHarness />);

    const cardRow = screen.container.querySelector<HTMLElement>(
      '[data-sidebar-row="local:card-active"]',
    )!;
    const cardUnpin = cardRow.querySelector<HTMLButtonElement>(
      'button[aria-label="取消置顶会话"]',
    )!;
    const cardSnooze = cardRow.querySelector<HTMLButtonElement>('button[aria-label="暂缓会话"]')!;
    const cardSettle = cardRow.querySelector<HTMLButtonElement>('button[aria-label="收尾会话"]')!;
    const settingsButton = screen.container.querySelector<HTMLButtonElement>(
      'button[aria-label="设置"]',
    )!;

    expect(Math.round(cardUnpin.getBoundingClientRect().height)).toBe(24);
    expect(Math.round(cardSnooze.getBoundingClientRect().height)).toBe(24);
    expect(Math.round(cardSettle.getBoundingClientRect().height)).toBe(24);
    expect(Math.round(settingsButton.getBoundingClientRect().width)).toBe(28);
    expect(Math.round(settingsButton.getBoundingClientRect().height)).toBe(28);
  });
});

import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { createRef } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { cdp, page } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { makeThreadFixture } from "../../test-fixtures";
import { ProjectPinButton } from "../ProjectPinButton";
import { SidebarProvider } from "../ui/sidebar";
import { SidebarChromeFooter, SidebarChromeHeader } from "./SidebarChrome";
import { SidebarDraftBlock } from "./SidebarDraftBlock";
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

function seedTouchDraftStore() {
  const previous = useComposerDraftStore.getState();
  const environmentId = EnvironmentId.make("local");
  const projectRef = scopeProjectRef(environmentId, ProjectId.make("project-1"));
  const cardThreadRef = scopeThreadRef(environmentId, ThreadId.make("card-active"));
  const standaloneDraftId = DraftId.make("draft-standalone");

  previous.setPrompt(cardThreadRef, "card unsent draft");
  previous.setProjectDraftThreadId(projectRef, standaloneDraftId, {
    threadId: ThreadId.make("draft-standalone-thread"),
  });
  previous.setPrompt(standaloneDraftId, "standalone unsent draft");

  // Restore original store state on disposal so concurrent/subsequent tests see clean drafts.
  return {
    [Symbol.dispose]() {
      useComposerDraftStore.setState(previous, true);
    },
  };
}

async function emulateTouchPointer(viewport: {
  width: number;
  height: number;
}): Promise<AsyncDisposable> {
  const previous = { width: window.innerWidth, height: window.innerHeight };
  const session = cdp();
  await page.viewport(viewport.width, viewport.height);
  await session.send("Emulation.setDeviceMetricsOverride", {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: 2,
    mobile: true,
  });
  await session.send("Emulation.setTouchEmulationEnabled", {
    enabled: true,
    maxTouchPoints: 5,
  });
  await session.send("Emulation.setEmitTouchEventsForMouse", {
    enabled: true,
    configuration: "mobile",
  });
  return {
    async [Symbol.asyncDispose]() {
      await session.send("Emulation.setEmitTouchEventsForMouse", { enabled: false });
      await session.send("Emulation.setTouchEmulationEnabled", { enabled: false });
      await session.send("Emulation.clearDeviceMetricsOverride");
      await page.viewport(previous.width, previous.height);
    },
  };
}

function makeRowProps(overrides: {
  id: string;
  title: string;
  variant: "card" | "slim";
  variantAction: "settle" | "unsettle" | "unsnooze";
  isPinned: boolean;
  wokeAt?: string | null;
  snoozeWakeLabelText?: string | null;
  onSettle?: () => void;
  onThreadClick?: () => void;
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
    snoozeWakeLabelText: overrides.snoozeWakeLabelText ?? null,
    wokeAt: overrides.wokeAt ?? null,
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
    onThreadClick: overrides.onThreadClick ?? noop,
    onThreadActivate: noop,
    onStartRename: noop,
    onRenameTitleChange: noop,
    onCommitRename: noop,
    onCancelRename: noop,
    isRenaming: false,
    renamingTitle: "",
    onContextMenu: noop,
    onSettle: overrides.onSettle ?? noop,
    onActionSweepStart: noop,
    onUnsettle: noop,
    onSnooze: noop,
    onUnsnooze: noop,
    onUnpin: noop,
    onAcknowledgeWoke: noop,
  };
}

function SidebarTouchHarness(props?: {
  onCardSettle?: () => void;
  onCardThreadClick?: () => void;
}) {
  const searchInputRef = createRef<HTMLInputElement>();
  const projectScopeAnchorRef = createRef<HTMLSpanElement>();
  const projectKey = `${scopeProjectRef(EnvironmentId.make("local"), ProjectId.make("project-1")).environmentId}:${ProjectId.make("project-1")}`;
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
          <SidebarDraftBlock
            projectByKey={new Map()}
            projectDisplayNameByKey={new Map([[projectKey, "fleet-ade"]])}
            scopedProjectKeys={null}
            routeDraftId={null}
            onNavigateToDraft={noop}
            onDraftContextMenu={noop}
          />
          <SortableThreadRow
            {...makeRowProps({
              id: "card-active",
              title: "置顶活跃会话",
              variant: "card",
              variantAction: "settle",
              isPinned: true,
              ...(props?.onCardSettle ? { onSettle: props.onCardSettle } : {}),
              ...(props?.onCardThreadClick ? { onThreadClick: props.onCardThreadClick } : {}),
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
              id: "card-woke",
              title: "已唤醒会话",
              variant: "card",
              variantAction: "settle",
              isPinned: false,
              wokeAt: "2026-03-10T12:00:00.000Z",
            })}
          />
          <SortableThreadRow
            {...makeRowProps({
              id: "slim-active",
              title: "紧凑行活跃会话",
              variant: "slim",
              variantAction: "settle",
              isPinned: true,
            })}
          />
          <SortableThreadRow
            {...makeRowProps({
              id: "slim-settled",
              title: "紧凑行已收尾会话",
              variant: "slim",
              variantAction: "unsettle",
              isPinned: false,
            })}
          />
          <SortableThreadRow
            {...makeRowProps({
              id: "slim-snoozed",
              title: "紧凑行暂缓会话",
              variant: "slim",
              variantAction: "unsnooze",
              isPinned: false,
              snoozeWakeLabelText: "2h",
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

function expectPointHitsButton(button: Element) {
  button.scrollIntoView({ block: "nearest", inline: "nearest" });
  const rect = button.getBoundingClientRect();
  const label = button.getAttribute("aria-label") ?? button.getAttribute("title") ?? button.tagName;
  expect(rect.width, `${label} width`).toBeGreaterThanOrEqual(32);
  expect(rect.height, `${label} height`).toBeGreaterThanOrEqual(32);
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const hit = document.elementFromPoint(cx, cy);
  expect(hit, `${label} elementFromPoint(${cx.toFixed(1)}, ${cy.toFixed(1)})`).toBe(button);
}

describe("sidebar mobile touch targets", () => {
  it("keeps row actions visible and hit-testable via elementFromPoint at 390x844 under pointer: coarse without hover", async () => {
    await using _touch = await emulateTouchPointer({ width: 390, height: 844 });
    using _draftStore = seedTouchDraftStore();
    const onCardSettle = vi.fn();
    const onCardThreadClick = vi.fn();
    await using screen = await render(
      <SidebarTouchHarness onCardSettle={onCardSettle} onCardThreadClick={onCardThreadClick} />,
    );

    await vi.waitFor(() => {
      expect(window.matchMedia("(pointer: coarse)").matches).toBe(true);
      expect(window.matchMedia("(hover: none)").matches).toBe(true);
    });

    const draftRow = screen.container.querySelector<HTMLElement>(
      '[data-testid="sidebar-draft-row"]',
    )!;
    const cardRow = screen.container.querySelector<HTMLElement>(
      '[data-sidebar-row="local:card-active"]',
    )!;
    const settledCardRow = screen.container.querySelector<HTMLElement>(
      '[data-sidebar-row="local:card-settled"]',
    )!;
    const wokeCardRow = screen.container.querySelector<HTMLElement>(
      '[data-sidebar-row="local:card-woke"]',
    )!;
    const slimRow = screen.container.querySelector<HTMLElement>(
      '[data-sidebar-row="local:slim-active"]',
    )!;
    const slimSettledRow = screen.container.querySelector<HTMLElement>(
      '[data-sidebar-row="local:slim-settled"]',
    )!;
    const slimSnoozedRow = screen.container.querySelector<HTMLElement>(
      '[data-sidebar-row="local:slim-snoozed"]',
    )!;

    const draftDiscard = draftRow.querySelector<HTMLButtonElement>(
      'button[aria-label="丢弃草稿"]',
    )!;
    const cardUnpin = cardRow.querySelector<HTMLButtonElement>(
      'button[aria-label="取消置顶会话"]',
    )!;
    const cardDiscardDraft = cardRow.querySelector<HTMLButtonElement>(
      'button[aria-label="丢弃草稿"]',
    )!;
    const cardSnooze = cardRow.querySelector<HTMLButtonElement>('button[aria-label="暂缓会话"]')!;
    const cardSettle = cardRow.querySelector<HTMLButtonElement>('button[aria-label="收尾会话"]')!;
    const cardUnsettle = settledCardRow.querySelector<HTMLButtonElement>(
      'button[aria-label="取消会话收尾"]',
    )!;
    const cardAckWoke = wokeCardRow.querySelector<HTMLButtonElement>(
      'button[aria-label="忽略已唤醒通知"]',
    )!;
    const cardWokeSnooze = wokeCardRow.querySelector<HTMLButtonElement>(
      'button[aria-label="暂缓会话"]',
    )!;
    const cardWokeSettle = wokeCardRow.querySelector<HTMLButtonElement>(
      'button[aria-label="收尾会话"]',
    )!;
    const slimUnpin = slimRow.querySelector<HTMLButtonElement>(
      'button[aria-label="取消置顶会话"]',
    )!;
    const slimSettle = slimRow.querySelector<HTMLButtonElement>('button[aria-label="收尾会话"]')!;
    const slimUnsettle = slimSettledRow.querySelector<HTMLButtonElement>(
      'button[aria-label="取消会话收尾"]',
    )!;
    const slimUnsnooze = slimSnoozedRow.querySelector<HTMLButtonElement>(
      'button[aria-label="立即唤醒会话"]',
    )!;

    const allTargets = [
      screen.container.querySelector('button[aria-label="切换主侧边栏"]')!,
      screen.container.querySelector('button[aria-label="更多"]')!,
      screen.container.querySelector('button[aria-label="新建会话"]')!,
      screen.container.querySelector('button[aria-label="清除会话搜索"]')!,
      draftDiscard,
      cardUnpin,
      cardDiscardDraft,
      cardSnooze,
      cardSettle,
      cardUnsettle,
      cardAckWoke,
      cardWokeSnooze,
      cardWokeSettle,
      slimUnpin,
      slimSettle,
      slimUnsettle,
      slimUnsnooze,
      screen.container.querySelector('button[title="Unpin fleet-ade"]')!,
      screen.container.querySelector('button[aria-label="设置"]')!,
      screen.container.querySelector('button[aria-label="PR"]')!,
      screen.container.querySelector('button[aria-label="用量"]')!,
      screen.container.querySelector('button[aria-label="机群"]')!,
    ];

    for (const target of allTargets) {
      expect(target).not.toBeNull();
      expectPointHitsButton(target);
    }

    const rowTargetPairs: Array<[HTMLElement, HTMLButtonElement[]]> = [
      [draftRow, [draftDiscard]],
      [cardRow, [cardUnpin, cardDiscardDraft, cardSnooze, cardSettle]],
      [settledCardRow, [cardUnsettle]],
      [wokeCardRow, [cardAckWoke, cardWokeSnooze, cardWokeSettle]],
      [slimRow, [slimUnpin, slimSettle]],
      [slimSettledRow, [slimUnsettle]],
      [slimSnoozedRow, [slimUnsnooze]],
    ];
    for (const [row, buttons] of rowTargetPairs) {
      const rowRect = row.getBoundingClientRect();
      for (const button of buttons) {
        const rect = button.getBoundingClientRect();
        expect(rect.top).toBeGreaterThanOrEqual(rowRect.top);
        expect(rect.bottom).toBeLessThanOrEqual(rowRect.bottom);
      }
    }

    // Visual icons stay compact instead of scaling up to fill the 32x32 hit box.
    expect(cardUnpin.querySelector("svg")!.getBoundingClientRect().width).toBeLessThanOrEqual(16);
    expect(cardSnooze.querySelector("svg")!.getBoundingClientRect().width).toBeLessThanOrEqual(16);
    expect(
      screen.container.querySelector('button[aria-label="设置"] svg')!.getBoundingClientRect()
        .width,
    ).toBeLessThanOrEqual(18);

    // Clicking the exposed action button handles the action without activating the owning row.
    cardSettle.click();
    expect(onCardSettle).toHaveBeenCalledTimes(1);
    expect(onCardThreadClick).not.toHaveBeenCalled();
  });

  it("keeps compact desktop button sizes and hover-only row actions at 1280x800", async () => {
    const previous = { width: window.innerWidth, height: window.innerHeight };
    await page.viewport(1280, 800);
    await using _viewport = {
      [Symbol.asyncDispose]: () => page.viewport(previous.width, previous.height),
    };
    using _draftStore = seedTouchDraftStore();
    await using screen = await render(<SidebarTouchHarness />);

    expect(window.matchMedia("(pointer: fine)").matches).toBe(true);
    expect(window.matchMedia("(pointer: coarse)").matches).toBe(false);

    const draftRow = screen.container.querySelector<HTMLElement>(
      '[data-testid="sidebar-draft-row"]',
    )!;
    const cardRow = screen.container.querySelector<HTMLElement>(
      '[data-sidebar-row="local:card-active"]',
    )!;
    const settledCardRow = screen.container.querySelector<HTMLElement>(
      '[data-sidebar-row="local:card-settled"]',
    )!;
    const slimRow = screen.container.querySelector<HTMLElement>(
      '[data-sidebar-row="local:slim-active"]',
    )!;
    const slimSettledRow = screen.container.querySelector<HTMLElement>(
      '[data-sidebar-row="local:slim-settled"]',
    )!;
    const slimSnoozedRow = screen.container.querySelector<HTMLElement>(
      '[data-sidebar-row="local:slim-snoozed"]',
    )!;

    const draftDiscard = draftRow.querySelector<HTMLButtonElement>(
      'button[aria-label="丢弃草稿"]',
    )!;
    const cardUnpin = cardRow.querySelector<HTMLButtonElement>(
      'button[aria-label="取消置顶会话"]',
    )!;
    const cardSnooze = cardRow.querySelector<HTMLButtonElement>('button[aria-label="暂缓会话"]')!;
    const cardSettle = cardRow.querySelector<HTMLButtonElement>('button[aria-label="收尾会话"]')!;
    const cardUnsettle = settledCardRow.querySelector<HTMLButtonElement>(
      'button[aria-label="取消会话收尾"]',
    )!;
    const slimSettle = slimRow.querySelector<HTMLButtonElement>('button[aria-label="收尾会话"]')!;
    const slimUnsettle = slimSettledRow.querySelector<HTMLButtonElement>(
      'button[aria-label="取消会话收尾"]',
    )!;
    const slimUnsnooze = slimSnoozedRow.querySelector<HTMLButtonElement>(
      'button[aria-label="立即唤醒会话"]',
    )!;
    const clearSearch = screen.container.querySelector<HTMLButtonElement>(
      'button[aria-label="清除会话搜索"]',
    )!;
    const projectPin = screen.container.querySelector<HTMLButtonElement>(
      'button[title="Unpin fleet-ade"]',
    )!;
    const settingsButton = screen.container.querySelector<HTMLButtonElement>(
      'button[aria-label="设置"]',
    )!;

    expect(Math.round(cardUnpin.getBoundingClientRect().height)).toBe(24);
    expect(Math.round(cardSnooze.getBoundingClientRect().height)).toBe(24);
    expect(Math.round(cardSettle.getBoundingClientRect().height)).toBe(24);
    expect(Math.round(clearSearch.getBoundingClientRect().width)).toBe(20);
    expect(Math.round(clearSearch.getBoundingClientRect().height)).toBe(20);
    expect(Math.round(projectPin.getBoundingClientRect().width)).toBe(24);
    expect(Math.round(projectPin.getBoundingClientRect().height)).toBe(24);
    expect(Math.round(settingsButton.getBoundingClientRect().width)).toBe(28);
    expect(Math.round(settingsButton.getBoundingClientRect().height)).toBe(28);

    // Without hover on desktop, hover-revealed row actions remain hidden and non-clickable.
    for (const button of [
      draftDiscard,
      cardSnooze,
      cardSettle,
      cardUnsettle,
      slimSettle,
      slimUnsettle,
      slimUnsnooze,
    ]) {
      const style = getComputedStyle(button);
      const wrapper = button.parentElement;
      const effectiveOpacity =
        style.opacity === "0" || (wrapper !== null && getComputedStyle(wrapper).opacity === "0");
      expect(effectiveOpacity).toBe(true);
      expect(style.pointerEvents).toBe("none");
      const rect = button.getBoundingClientRect();
      expect(
        document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2),
      ).not.toBe(button);
    }
  });
});

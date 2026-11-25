import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { createRef } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { cdp, page, userEvent } from "vite-plus/test/browser";

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

async function emulatePointer(options: {
  width: number;
  height: number;
  pointer: "coarse" | "fine";
}): Promise<AsyncDisposable> {
  const previous = { width: window.innerWidth, height: window.innerHeight };
  const session = cdp();
  const isTouch = options.pointer === "coarse";
  const cleanup = async () => {
    await session.send("Emulation.setEmulatedMedia", { features: [] });
    await session.send("Emulation.setEmitTouchEventsForMouse", {
      enabled: false,
      configuration: "desktop",
    });
    await session.send("Emulation.setTouchEmulationEnabled", { enabled: false });
    await session.send("Emulation.clearDeviceMetricsOverride");
    await page.viewport(previous.width, previous.height);
  };
  try {
    await page.viewport(options.width, options.height);
    await session.send("Emulation.setDeviceMetricsOverride", {
      width: options.width,
      height: options.height,
      deviceScaleFactor: isTouch ? 2 : 1,
      mobile: isTouch,
    });
    await session.send("Emulation.setTouchEmulationEnabled", {
      enabled: isTouch,
      ...(isTouch ? { maxTouchPoints: 5 } : {}),
    });
    await session.send("Emulation.setEmitTouchEventsForMouse", {
      enabled: isTouch,
      configuration: isTouch ? "mobile" : "desktop",
    });
    await session.send("Emulation.setEmulatedMedia", {
      features: isTouch
        ? [
            { name: "pointer", value: "coarse" },
            { name: "hover", value: "none" },
          ]
        : [
            { name: "pointer", value: "fine" },
            { name: "hover", value: "hover" },
          ],
    });
  } catch (error) {
    await cleanup();
    throw error;
  }
  return {
    [Symbol.asyncDispose]: cleanup,
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
              title: "已完成会话",
              variant: "card",
              variantAction: "unsettle",
              isPinned: false,
            })}
          />
          <SortableThreadRow
            {...makeRowProps({
              id: "card-woke",
              title: "暂缓结束会话",
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
              title: "紧凑行已完成会话",
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

function expectRowActionTarget(button: HTMLElement) {
  button.scrollIntoView({ block: "nearest", inline: "nearest" });
  const style = getComputedStyle(button);
  const label = button.getAttribute("aria-label") ?? button.tagName;
  expect(parseFloat(style.width), `${label} painted width`).toBe(24);
  expect(parseFloat(style.height), `${label} painted height`).toBe(24);
  const hit = getComputedStyle(button, "::after");
  const visibleSiblings = button.parentElement
    ? [...button.parentElement.children].filter(
        (child) => getComputedStyle(child).display !== "none",
      ).length
    : 1;
  expect(parseFloat(hit.width), `${label} hit width`).toBeGreaterThanOrEqual(
    visibleSiblings > 1 ? 32 : 44,
  );
  expect(parseFloat(hit.height), `${label} hit height`).toBeGreaterThanOrEqual(44);
  const rect = button.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  expect(document.elementFromPoint(cx, cy), `${label} elementFromPoint`).toBe(button);
  // ::after is 44px tall in CSS and clipped at the 32px content-visibility:auto row lane so
  // stacked rows do not steal taps from neighbors.
  expect(document.elementFromPoint(cx, rect.top - 3), `${label} top hit`).toBe(button);
  expect(document.elementFromPoint(cx, rect.bottom + 3), `${label} bottom hit`).toBe(button);
}

function expectAdjacentTargetsDoNotOverlap(buttons: HTMLButtonElement[]) {
  for (let index = 0; index < buttons.length - 1; index += 1) {
    const left = buttons[index]!;
    const right = buttons[index + 1]!;
    const leftRect = left.getBoundingClientRect();
    const rightRect = right.getBoundingClientRect();
    const midX = (leftRect.right + rightRect.left) / 2;
    const cy = leftRect.top + leftRect.height / 2;
    const leftName = left.getAttribute("aria-label") ?? "left";
    const rightName = right.getAttribute("aria-label") ?? "right";
    expect(document.elementFromPoint(midX - 1, cy), `${leftName} before midpoint`).toBe(left);
    expect(document.elementFromPoint(midX + 1, cy), `${rightName} after midpoint`).toBe(right);
  }
}

function isEffectivelyHidden(button: HTMLElement): boolean {
  for (let node: HTMLElement | null = button; node !== null; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
      return true;
    }
  }
  return false;
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

function expectVisibleInlineLabelBeforeActions(
  row: HTMLElement,
  pattern: RegExp,
  rightActionButtons: HTMLButtonElement[],
) {
  const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
  let matchedNode: Text | null = null;
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node.textContent?.trim() ?? "";
    if (pattern.test(text)) {
      matchedNode = node as Text;
      break;
    }
  }
  expect(matchedNode, `label matching ${pattern} inside row`).not.toBeNull();

  const range = document.createRange();
  range.selectNodeContents(matchedNode!);
  const labelRect = range.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();

  expect(labelRect.width).toBeGreaterThan(0);
  expect(labelRect.height).toBeGreaterThan(0);
  expect(labelRect.height).toBeLessThanOrEqual(24);
  expect(labelRect.left).toBeGreaterThanOrEqual(rowRect.left);
  expect(labelRect.right).toBeLessThanOrEqual(rowRect.right);
  expect(labelRect.top).toBeGreaterThanOrEqual(rowRect.top);
  expect(labelRect.bottom).toBeLessThanOrEqual(rowRect.bottom);

  for (let el = matchedNode!.parentElement; el && el !== row.parentElement; el = el.parentElement) {
    const style = getComputedStyle(el);
    expect(style.opacity).toBe("1");
    expect(style.visibility).toBe("visible");
    expect(style.display).not.toBe("none");
  }

  const labelCenterY = (labelRect.top + labelRect.bottom) / 2;
  for (const button of rightActionButtons) {
    const btnRect = button.getBoundingClientRect();
    const btnCenterY = (btnRect.top + btnRect.bottom) / 2;
    expect(btnRect.left).toBeGreaterThanOrEqual(labelRect.right - 0.5);
    expect(Math.abs(btnCenterY - labelCenterY)).toBeLessThanOrEqual(6);
  }
}

describe("sidebar mobile touch targets", () => {
  it("keeps row actions visible and hit-testable via elementFromPoint at 390x844 under pointer: coarse without hover", async () => {
    await using _pointer = await emulatePointer({ width: 390, height: 844, pointer: "coarse" });
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
    const draftDetails = draftRow.querySelector<HTMLButtonElement>(
      'button[aria-label="草稿详情"]',
    )!;
    const cardUnpin = cardRow.querySelector<HTMLButtonElement>(
      'button[aria-label="取消置顶会话"]',
    )!;
    const cardDiscardDraft = cardRow.querySelector<HTMLButtonElement>(
      'button[aria-label="丢弃草稿"]',
    )!;
    const cardSnooze = cardRow.querySelector<HTMLButtonElement>('button[aria-label="暂缓会话"]')!;
    const cardSettle = cardRow.querySelector<HTMLButtonElement>('button[aria-label="标为完成"]')!;
    const cardDetails = cardRow.querySelector<HTMLButtonElement>('button[aria-label="会话详情"]')!;
    const cardUnsettle = settledCardRow.querySelector<HTMLButtonElement>(
      'button[aria-label="取消完成"]',
    )!;
    const cardAckWoke = wokeCardRow.querySelector<HTMLButtonElement>(
      'button[aria-label="忽略暂缓结束提示"]',
    )!;
    const cardWokeSnooze = wokeCardRow.querySelector<HTMLButtonElement>(
      'button[aria-label="暂缓会话"]',
    )!;
    const cardWokeSettle = wokeCardRow.querySelector<HTMLButtonElement>(
      'button[aria-label="标为完成"]',
    )!;
    const cardWokeDetails = wokeCardRow.querySelector<HTMLButtonElement>(
      'button[aria-label="会话详情"]',
    )!;
    const slimUnpin = slimRow.querySelector<HTMLButtonElement>(
      'button[aria-label="取消置顶会话"]',
    )!;
    const slimSnooze = slimRow.querySelector<HTMLButtonElement>('button[aria-label="暂缓会话"]')!;
    const slimSettle = slimRow.querySelector<HTMLButtonElement>('button[aria-label="标为完成"]')!;
    const slimDetails = slimRow.querySelector<HTMLButtonElement>('button[aria-label="会话详情"]')!;
    const slimUnsettle = slimSettledRow.querySelector<HTMLButtonElement>(
      'button[aria-label="取消完成"]',
    )!;
    const slimUnsnooze = slimSnoozedRow.querySelector<HTMLButtonElement>(
      'button[aria-label="取消暂缓"]',
    )!;

    const chromeTargets = [
      screen.container.querySelector('button[aria-label="切换主侧边栏"]')!,
      screen.container.querySelector('button[aria-label="更多"]')!,
      screen.container.querySelector('button[aria-label="新建会话"]')!,
      screen.container.querySelector('button[aria-label="清除会话搜索"]')!,
      screen.container.querySelector('button[title="取消置顶 fleet-ade"]')!,
      screen.container.querySelector('button[aria-label="设置"]')!,
      screen.container.querySelector('button[aria-label="PR"]')!,
      screen.container.querySelector('button[aria-label="用量"]')!,
      screen.container.querySelector('button[aria-label="机群"]')!,
    ];
    const rowTargets = [
      draftDiscard,
      draftDetails,
      cardUnpin,
      cardDiscardDraft,
      cardSnooze,
      cardSettle,
      cardDetails,
      cardUnsettle,
      cardAckWoke,
      cardWokeSnooze,
      cardWokeSettle,
      cardWokeDetails,
      slimUnpin,
      slimSnooze,
      slimSettle,
      slimDetails,
      slimUnsettle,
      slimUnsnooze,
    ];

    for (const target of chromeTargets) {
      expect(target).not.toBeNull();
      expectPointHitsButton(target);
    }
    for (const target of rowTargets) {
      expect(target).not.toBeNull();
      expectRowActionTarget(target);
    }

    expectAdjacentTargetsDoNotOverlap([draftDiscard, draftDetails]);
    expectAdjacentTargetsDoNotOverlap([
      cardUnpin,
      cardDiscardDraft,
      cardSnooze,
      cardSettle,
      cardDetails,
    ]);
    expectAdjacentTargetsDoNotOverlap([
      cardAckWoke,
      cardWokeSnooze,
      cardWokeSettle,
      cardWokeDetails,
    ]);
    expectAdjacentTargetsDoNotOverlap([slimUnpin, slimSnooze, slimSettle, slimDetails]);

    const rowTargetPairs: Array<[HTMLElement, HTMLButtonElement[]]> = [
      [draftRow, [draftDiscard, draftDetails]],
      [cardRow, [cardUnpin, cardDiscardDraft, cardSnooze, cardSettle, cardDetails]],
      [settledCardRow, [cardUnsettle]],
      [wokeCardRow, [cardAckWoke, cardWokeSnooze, cardWokeSettle, cardWokeDetails]],
      [slimRow, [slimUnpin, slimSnooze, slimSettle, slimDetails]],
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

    const relativeTimePattern = /^(刚刚|\d+\s*(分钟|小时|天)前)$/;
    const rowLabelChecks: Array<[HTMLElement, RegExp, HTMLButtonElement[]]> = [
      [cardRow, relativeTimePattern, [cardDiscardDraft, cardSnooze, cardSettle]],
      [settledCardRow, relativeTimePattern, [cardUnsettle]],
      [wokeCardRow, /^暂缓结束$/, [cardWokeSnooze, cardWokeSettle]],
      [slimRow, relativeTimePattern, [slimSettle]],
      [slimSettledRow, relativeTimePattern, [slimUnsettle]],
      [slimSnoozedRow, /^2h$/, [slimUnsnooze]],
    ];
    for (const [row, pattern, actionButtons] of rowLabelChecks) {
      expectVisibleInlineLabelBeforeActions(row, pattern, actionButtons);
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
    await using _pointer = await emulatePointer({ width: 1280, height: 800, pointer: "fine" });
    using _draftStore = seedTouchDraftStore();
    await using screen = await render(<SidebarTouchHarness />);

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
    const cardSettle = cardRow.querySelector<HTMLButtonElement>('button[aria-label="标为完成"]')!;
    const cardUnsettle = settledCardRow.querySelector<HTMLButtonElement>(
      'button[aria-label="取消完成"]',
    )!;
    const slimSettle = slimRow.querySelector<HTMLButtonElement>('button[aria-label="标为完成"]')!;
    const slimUnsettle = slimSettledRow.querySelector<HTMLButtonElement>(
      'button[aria-label="取消完成"]',
    )!;
    const slimUnsnooze = slimSnoozedRow.querySelector<HTMLButtonElement>(
      'button[aria-label="取消暂缓"]',
    )!;
    const clearSearch = screen.container.querySelector<HTMLButtonElement>(
      'button[aria-label="清除会话搜索"]',
    )!;
    const projectPin = screen.container.querySelector<HTMLButtonElement>(
      'button[title="取消置顶 fleet-ade"]',
    )!;
    const settingsButton = screen.container.querySelector<HTMLButtonElement>(
      'button[aria-label="设置"]',
    )!;

    for (const button of [
      draftDiscard,
      cardUnpin,
      cardSnooze,
      cardSettle,
      cardUnsettle,
      slimSettle,
      slimUnsettle,
      slimUnsnooze,
    ]) {
      expect(isEffectivelyHidden(button), button.getAttribute("aria-label") ?? undefined).toBe(
        true,
      );
    }

    await userEvent.hover(draftRow);
    expect(Math.round(draftDiscard.getBoundingClientRect().height)).toBe(24);
    expect(getComputedStyle(draftDiscard, "::after").content).toBe("none");
    await userEvent.unhover(draftRow);

    await userEvent.hover(cardRow);
    expect(Math.round(cardUnpin.getBoundingClientRect().height)).toBe(24);
    expect(Math.round(cardSnooze.getBoundingClientRect().height)).toBe(24);
    expect(Math.round(cardSettle.getBoundingClientRect().height)).toBe(24);
    await userEvent.hover(settledCardRow);
    expect(Math.round(cardUnsettle.getBoundingClientRect().height)).toBe(24);
    expect(Math.round(clearSearch.getBoundingClientRect().width)).toBe(24);
    expect(Math.round(clearSearch.getBoundingClientRect().height)).toBe(24);
    expect(Math.round(projectPin.getBoundingClientRect().width)).toBe(24);
    expect(Math.round(projectPin.getBoundingClientRect().height)).toBe(24);
    expect(Math.round(settingsButton.getBoundingClientRect().width)).toBe(28);
    expect(Math.round(settingsButton.getBoundingClientRect().height)).toBe(28);

    // Without hover on desktop, hover-revealed row actions remain hidden and non-clickable.
    await userEvent.unhover(cardRow);
    await userEvent.unhover(settledCardRow);
    for (const button of [
      draftDiscard,
      cardSnooze,
      cardSettle,
      cardUnsettle,
      slimSettle,
      slimUnsettle,
      slimUnsnooze,
    ]) {
      expect(isEffectivelyHidden(button), button.getAttribute("aria-label") ?? undefined).toBe(
        true,
      );
      const rect = button.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        expect(
          document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2),
        ).not.toBe(button);
      }
    }
  });
});

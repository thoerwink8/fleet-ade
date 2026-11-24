import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId, ProviderInstanceId, RunId, ThreadId } from "@t3tools/contracts";
import { Profiler, useSyncExternalStore, type ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render } from "../../../test/render";
import { makeThreadFixture } from "../../test-fixtures";
import { applyThemePalette, EMBER_THEME, GROVE_THEME } from "../../themePalette";
import { SortableThreadRow } from "./SidebarThreadRow";
import { TooltipProvider } from "../ui/tooltip";

vi.mock("../../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/session")>()),
  readEnvironmentScope: () => true,
  useEnvironmentScope: () => true,
}));

const minuteClock = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  let value = "2026-03-10T12:00";
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get() {
      return value;
    },
    set(next: string) {
      value = next;
      for (const listener of listeners) listener();
    },
  };
});

vi.mock("../../hooks/useNowMinute", () => ({
  useNowMinute: () => useSyncExternalStore(minuteClock.subscribe, minuteClock.get, minuteClock.get),
}));

const shells = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  let byKey = new Map<string, EnvironmentThreadShell>();
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    read(ref: { environmentId: string; threadId: string } | null) {
      if (ref === null) return null;
      return byKey.get(`${ref.environmentId}:${ref.threadId}`) ?? null;
    },
    reset(threads: readonly EnvironmentThreadShell[]) {
      byKey = new Map(threads.map((thread) => [`${thread.environmentId}:${thread.id}`, thread]));
    },
    updateTitle(key: string, title: string) {
      const current = byKey.get(key);
      if (current === undefined) return;
      const next = new Map(byKey);
      next.set(key, { ...current, title });
      byKey = next;
      for (const listener of listeners) listener();
    },
  };
});

vi.mock("../../state/entities", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/entities")>()),
  useThreadShell: (ref: { environmentId: string; threadId: string } | null) =>
    useSyncExternalStore(
      shells.subscribe,
      () => shells.read(ref),
      () => shells.read(ref),
    ),
}));

const environmentId = EnvironmentId.make("local");
const projectId = ProjectId.make("project-1");

function thread(id: string, title: string, extra: Record<string, unknown> = {}) {
  return makeThreadFixture({
    environmentId,
    projectId,
    id: ThreadId.make(id),
    title,
    ...extra,
  });
}

function rowProps(
  id: string,
  title: string,
  extra: Record<string, unknown> = {},
  overrides: Record<string, unknown> = {},
) {
  return {
    sortableId: `thread:${id}`,
    sortableDisabled: true,
    contextDrag: false,
    thread: thread(id, title, extra),
    variant: "card" as const,
    variantAction: "settle" as const,
    settlementSupported: true,
    snoozeSupported: true,
    pinningSupported: true,
    isPinned: false,
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
    onThreadClick: () => {},
    onThreadActivate: () => {},
    onStartRename: () => {},
    onRenameTitleChange: () => {},
    onCommitRename: () => {},
    onCancelRename: () => {},
    isRenaming: false,
    renamingTitle: "",
    onContextMenu: () => {},
    onSettle: () => {},
    onActionSweepStart: () => {},
    onUnsettle: () => {},
    onSnooze: () => {},
    onUnsnooze: () => {},
    onUnpin: () => {},
    onAcknowledgeWoke: () => {},
    ...overrides,
  };
}

function Host(props: { children: ReactNode }) {
  return <TooltipProvider delay={150}>{props.children}</TooltipProvider>;
}

function px(value: string): number {
  const match = value.match(/(-?\d+(?:\.\d+)?)px/);
  return match ? Number(match[1]) : Number.NaN;
}

function probeColor(variable: string): string {
  const probe = document.createElement("div");
  probe.style.backgroundColor = `var(${variable})`;
  document.body.append(probe);
  const color = getComputedStyle(probe).backgroundColor;
  probe.remove();
  return color;
}

describe("sidebar thread row density", () => {
  it("paints a 32px one-line row and a 52px needs-you row at 390 and 1280", async () => {
    const running = thread("running", "排查登录超时", {
      runtime: {
        status: "running",
        activeRunId: null,
        providerInstanceId: ProviderInstanceId.make("codex"),
        providerName: "Codex",
        lastError: null,
        updatedAt: "2026-03-10T12:00:00.000Z",
      },
    });
    const unread = thread("unread", "有新回复", {
      lastVisitedAt: "2026-03-01T00:00:00.000Z",
      latestRun: {
        runId: RunId.make("run-unread"),
        status: "completed",
        requestedAt: null,
        startedAt: null,
        completedAt: "2026-03-02T00:00:00.000Z",
        assistantMessageId: null,
      },
    });
    await using screen = await render(
      <Host>
        <ul>
          <SortableThreadRow {...rowProps("idle", "普通会话")} />
          <SortableThreadRow
            {...rowProps("running", "排查登录超时", {
              runtime: running.runtime,
            })}
          />
          <SortableThreadRow
            {...rowProps("unread", "有新回复", {
              lastVisitedAt: unread.lastVisitedAt,
              latestRun: unread.latestRun,
            })}
          />
          <SortableThreadRow
            {...rowProps(
              "approval",
              "等你批准",
              {},
              {
                attention: { category: "approval", blocking: true, unseen: true },
              },
            )}
          />
        </ul>
      </Host>,
    );

    const idle = screen.container.querySelector<HTMLElement>('[data-sidebar-row="local:idle"]')!;
    const approval = screen.container.querySelector<HTMLElement>(
      '[data-sidebar-row="local:approval"]',
    )!;
    const unreadRow = screen.container.querySelector<HTMLElement>(
      '[data-sidebar-row="local:unread"]',
    )!;
    const runningRow = screen.container.querySelector<HTMLElement>(
      '[data-sidebar-row="local:running"]',
    )!;

    const measure = () => {
      const idleStyle = getComputedStyle(idle);
      const title = getComputedStyle(idle.querySelector(".t")!);
      const time = getComputedStyle(idle.querySelector(".tm")!);
      const unreadTitle = getComputedStyle(unreadRow.querySelector(".t")!);
      const reason = getComputedStyle(approval.querySelector(".s")!);
      expect(idle.getBoundingClientRect().height).toBe(32);
      expect(approval.getBoundingClientRect().height).toBe(52);
      expect(title.fontSize).toBe("14px");
      expect(title.fontWeight).toBe("400");
      expect(unreadTitle.fontWeight).toBe("500");
      expect(title.whiteSpace).toBe("nowrap");
      expect(title.textOverflow).toBe("ellipsis");
      expect(time.fontSize).toBe("12px");
      expect(time.fontVariantNumeric).toContain("tabular-nums");
      expect(time.color).toBe(probeColor("--fa-fg-muted"));
      expect(reason.fontSize).toBe("12px");
      expect(reason.color).toBe(probeColor("--fa-fg-muted"));
      expect(reason.whiteSpace).toBe("nowrap");
      expect(reason.textOverflow).toBe("ellipsis");
      expect(idleStyle.borderTopWidth).toBe("0px");
      expect(idleStyle.boxShadow).toBe("none");
      expect(px(idleStyle.borderTopLeftRadius)).toBeLessThanOrEqual(8);
      expect(idleStyle.backgroundColor).toBe("rgba(0, 0, 0, 0)");
      expect(getComputedStyle(idle.querySelector(".lead")!).width).toBe("16px");
      expect(getComputedStyle(runningRow.querySelector(".fa-dot")!).backgroundColor).toBe(
        probeColor("--fa-success"),
      );
      expect(unreadRow.querySelector(".fa-dot")?.className).toContain("fa-dot--new");
      expect(approval.querySelector(".s")?.textContent).toBe("等待批准，点开处理");
      expect(approval.querySelector(".fa-dot")?.className).toContain("fa-dot--needs");
    };

    await page.viewport(1280, 800);
    measure();
    const wide = idle.getBoundingClientRect().height;
    await page.viewport(390, 844);
    measure();
    expect(idle.getBoundingClientRect().height).toBe(wide);
    expect(approval.getBoundingClientRect().height).toBe(52);
  });

  it("keeps the placeholder height equal to the painted height across 200 rows", async () => {
    const rows = Array.from({ length: 200 }, (_, index) => (
      <SortableThreadRow key={index} {...rowProps(`dense-${index}`, `会话 ${index}`)} />
    ));
    await using screen = await render(
      <Host>
        <div data-testid="scroller" style={{ height: 320, overflow: "auto" }}>
          <ul>{rows}</ul>
        </div>
      </Host>,
    );
    const scroller = screen.getByTestId("scroller").element();
    const items = [...scroller.querySelectorAll("li")];
    expect(items).toHaveLength(200);
    for (const item of items.slice(0, 8)) {
      const block = getComputedStyle(item).containIntrinsicBlockSize;
      expect(item.offsetHeight).toBe(px(block));
    }
    const before = scroller.scrollHeight;
    scroller.scrollTop = before;
    expect(scroller.scrollHeight).toBe(before);
    expect(px(getComputedStyle(items[0]!).containIntrinsicBlockSize)).toBe(32);
  });

  it("mounts the hover card only after the row opens and keeps closed rows unsubscribed", async () => {
    await using screen = await render(
      <Host>
        <ul>
          <SortableThreadRow
            {...rowProps("preview", "标题", {
              latestMessagePreview: { role: "assistant", text: "摘要预览" },
              turnCount: 3,
              modelSelection: {
                instanceId: ProviderInstanceId.make("codex"),
                model: "gpt-5.4",
              },
            })}
          />
        </ul>
      </Host>,
    );
    const row = screen.container.querySelector<HTMLElement>('[data-sidebar-row="local:preview"]')!;
    expect(document.querySelector('[data-testid="sidebar-thread-details"]')).toBeNull();
    await userEvent.hover(row);
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="sidebar-row-preview"]')?.textContent).toBe(
        "摘要预览",
      );
    });
    const card = document.querySelector<HTMLElement>('[data-slot="tooltip-popup"]')!;
    const cardStyle = getComputedStyle(card);
    expect(card.classList.contains("ade-pop-panel")).toBe(true);
    expect(px(cardStyle.borderTopLeftRadius)).toBe(12);
    expect(cardStyle.borderTopWidth).toBe("1px");
    expect(cardStyle.backdropFilter === "none" || cardStyle.backdropFilter === "").toBe(true);
    expect(cardStyle.backgroundColor).toBe(probeColor("--fa-overlay"));
    expect(document.querySelector('[data-testid="sidebar-row-counts"]')?.textContent).toBe("3 轮");
    await userEvent.unhover(row);
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="sidebar-thread-details"]')).toBeNull();
    });
  });

  it("follows selected, hover, and mark colors in the default theme, Grove, and Ember", async () => {
    await using screen = await render(
      <Host>
        <ul>
          <SortableThreadRow {...rowProps("current", "当前", {}, { isActive: true })} />
          <SortableThreadRow
            {...rowProps("work", "运行", {
              runtime: {
                status: "running",
                activeRunId: null,
                providerInstanceId: ProviderInstanceId.make("codex"),
                providerName: "Codex",
                lastError: null,
                updatedAt: "2026-03-10T12:00:00.000Z",
              },
            })}
          />
          <SortableThreadRow
            {...rowProps("bad", "出错", {
              runtime: {
                status: "failed",
                activeRunId: null,
                providerInstanceId: ProviderInstanceId.make("codex"),
                providerName: "Codex",
                lastError: "boom",
                lastErrorClass: "unknown",
                updatedAt: "2026-03-10T12:00:00.000Z",
              },
            })}
          />
        </ul>
      </Host>,
    );
    const root = document.documentElement;
    const current = screen.container.querySelector<HTMLElement>(
      '[data-sidebar-row="local:current"]',
    )!;
    const work = screen.container.querySelector<HTMLElement>('[data-sidebar-row="local:work"]')!;
    const bad = screen.container.querySelector<HTMLElement>('[data-sidebar-row="local:bad"]')!;
    const appearances = ["light", "dark"] as const;
    const themes = [
      { id: "default", apply: () => applyThemePalette("light", "light") },
      {
        id: GROVE_THEME.id,
        apply: (appearance: "light" | "dark") => applyThemePalette(GROVE_THEME.id, appearance),
      },
      {
        id: EMBER_THEME.id,
        apply: (appearance: "light" | "dark") => applyThemePalette(EMBER_THEME.id, appearance),
      },
    ];
    try {
      for (const theme of themes) {
        for (const appearance of appearances) {
          root.classList.toggle("dark", appearance === "dark");
          root.dataset.theme = appearance;
          if (theme.id === "default") applyThemePalette(appearance, appearance);
          else theme.apply(appearance);
          const selected = getComputedStyle(current).backgroundColor;
          const running = getComputedStyle(work.querySelector(".fa-dot")!).backgroundColor;
          const error = getComputedStyle(bad.querySelector(".fa-dot")!).backgroundColor;
          expect(selected, `${theme.id} ${appearance} selected`).toBe(probeColor("--fa-selected"));
          expect(running, `${theme.id} ${appearance} running`).toBe(probeColor("--fa-success"));
          expect(error, `${theme.id} ${appearance} error`).toBe(probeColor("--fa-danger"));
          await userEvent.hover(work);
          const hoverImage = getComputedStyle(work).backgroundImage;
          expect(hoverImage, `${theme.id} ${appearance} hover`).toContain("linear-gradient");
          await userEvent.unhover(work);
        }
      }
    } finally {
      root.classList.remove("dark");
      delete root.dataset.theme;
      delete root.dataset.themeId;
      applyThemePalette("light", "light");
    }
  });

  it("re-renders only the row whose shell changed, and a minute tick does not re-render the row", async () => {
    const first = thread("a", "会话 A");
    const second = thread("b", "会话 B");
    shells.reset([first, second]);
    const counts = { a: 0, b: 0 };
    let clockRowRenders = 0;
    function ClockRowMark() {
      clockRowRenders += 1;
      return null;
    }
    await using screen = await render(
      <Host>
        <Profiler
          id="a"
          onRender={() => {
            counts.a += 1;
          }}
        >
          <SortableThreadRow {...rowProps("a", "会话 A")} />
        </Profiler>
        <Profiler
          id="b"
          onRender={() => {
            counts.b += 1;
          }}
        >
          <SortableThreadRow {...rowProps("b", "会话 B")} />
        </Profiler>
      </Host>,
    );
    expect(screen.container.querySelectorAll(".t")[0]?.textContent).toBe("会话 A");
    const before = { a: counts.a, b: counts.b };
    await act(() => {
      shells.updateTitle(`${environmentId}:a`, "会话 A 已更新");
    });
    expect(screen.container.querySelectorAll(".t")[0]?.textContent).toBe("会话 A 已更新");
    expect(counts.a).toBeGreaterThan(before.a);
    expect(counts.b).toBe(before.b);

    minuteClock.set("2026-03-10T12:00");
    shells.reset([thread("clock", "计时", { updatedAt: "2026-03-10T12:00:30.000Z" })]);
    await using clockScreen = await render(
      <Host>
        <SortableThreadRow
          {...rowProps("clock", "计时", { updatedAt: "2026-03-10T12:00:30.000Z" })}
          renderMark={<ClockRowMark />}
        />
      </Host>,
    );
    const marked = clockRowRenders;
    expect(clockScreen.container.querySelector(".tm")?.textContent).toBe("刚刚");
    await act(() => {
      minuteClock.set("2026-03-10T12:02");
    });
    expect(clockRowRenders).toBe(marked);
    expect(clockScreen.container.querySelector(".tm")?.textContent).toBe("1 分钟前");
  });
});

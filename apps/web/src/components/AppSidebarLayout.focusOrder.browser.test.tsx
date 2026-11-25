import { createMemoryHistory } from "@tanstack/react-router";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { AppRoot } from "~/AppRoot";
import "~/components/ChatView";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { startWorkspaceFocus } from "~/lib/workspaceFocus";
import { getRouter } from "~/router";
import {
  ENVIRONMENT_ID,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { render } from "../../test/render";

vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});
type Region = "BODY" | "skip" | "sidebar" | "header" | "banner" | "timeline" | "composer" | "other";

function classifyElement(el: Element | null): {
  tag: string;
  role: string;
  label: string;
  region: Region;
  inMain: boolean;
  inClosedMobileSheet: boolean;
} {
  if (!el) {
    return {
      tag: "NULL",
      role: "",
      label: "",
      region: "BODY",
      inMain: false,
      inClosedMobileSheet: false,
    };
  }
  const tag = el.tagName;
  const role = el.getAttribute("role") ?? "";
  const label =
    el.getAttribute("aria-label") ??
    el.getAttribute("data-testid") ??
    el.textContent?.trim().slice(0, 40) ??
    "";
  const inMain = el.closest('main[data-slot="sidebar-inset"]') !== null;
  const inClosedMobileSheet = el.closest('[data-mobile="true"][data-closed]') !== null;
  const region: Region =
    el === document.body || el === document.documentElement
      ? "BODY"
      : el.closest("[data-skip-to-main]")
        ? "skip"
        : el.closest("[data-sidebar-control]") || el.closest('[data-slot="sidebar"]')
          ? "sidebar"
          : el.closest("[data-chat-header]") || el.closest("[data-workspace-titlebar-controls]")
            ? "header"
            : el.closest('[data-workspace-area="conversation"]')
              ? "timeline"
              : el.closest('[data-workspace-area="composer"]')
                ? "composer"
                : el.closest("[data-chat-column]")
                  ? "banner"
                  : "other";
  return { tag, role, label, region, inMain, inClosedMobileSheet };
}

async function mountThreadApp(viewport: { width: number; height: number }, threadCount = 12) {
  const stack = new AsyncDisposableStack();
  const threads = Array.from({ length: threadCount }, (_, i) =>
    threadWithHistory(`thread-${i + 1}`, 1),
  );
  stack.use(installFakeEnvironment(threads));
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  await page.viewport(viewport.width, viewport.height);
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${threads[0]!.id}`] }),
  );
  const stopWorkspaceFocus = startWorkspaceFocus(router);
  stack.defer(() => stopWorkspaceFocus());
  await router.load();
  const screen = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  stack.use(screen);
  await expect.element(page.getByText(`Answer 0 for ${threads[0]!.id}.`)).toBeVisible();
  if (viewport.width >= 768) {
    await expect
      .element(page.getByText(`会话 ${threads[threadCount - 1]!.id}`).first())
      .toBeVisible();
  }
  return {
    threads,
    screen,
    [Symbol.asyncDispose]: () => stack.disposeAsync(),
  };
}

describe("keyboard Tab focus order", () => {
  it("walks sidebar -> header -> timeline -> composer with zero BODY stops and reaches main content within 10 Tabs", async () => {
    await using app = await mountThreadApp({ width: 1400, height: 900 }, 12);
    await expect.element(page.getByTestId("composer-editor")).toHaveFocus();

    // Tab 30 times starting from initial focus in composer: never drop to BODY.
    const fromComposer = [classifyElement(document.activeElement)];
    for (let step = 1; step <= 30; step++) {
      await userEvent.tab();
      fromComposer.push(classifyElement(document.activeElement));
    }
    expect(fromComposer.filter((step) => step.region === "BODY")).toEqual([]);

    // Start from the skip-to-main-content link (first tab stop in the shell) and trace one full cycle.
    const skipLink = document.querySelector<HTMLElement>("[data-skip-to-main]")!;
    expect(skipLink).not.toBeNull();
    skipLink.focus();

    const fromTop = [classifyElement(document.activeElement)];
    for (let step = 1; step <= 30; step++) {
      await userEvent.tab();
      fromTop.push(classifyElement(document.activeElement));
    }

    expect(fromTop.filter((step) => step.region === "BODY")).toEqual([]);
    expect(fromTop[0]?.region).toBe("skip");

    const firstMainStep = fromTop.findIndex((step) => step.inMain);
    expect(firstMainStep).toBeGreaterThan(0);
    expect(firstMainStep).toBeLessThanOrEqual(10);

    // Slice the first full pass (from skip until wrapping back to skip) and verify visual order.
    const wrapIndex = fromTop.findIndex((step, index) => index > 0 && step.region === "skip");
    expect(wrapIndex).toBeGreaterThan(firstMainStep);
    const oneCycle = fromTop.slice(0, wrapIndex);

    const regionRank: Record<Region, number> = {
      BODY: -1,
      skip: 0,
      sidebar: 1,
      header: 2,
      banner: 3,
      timeline: 4,
      composer: 5,
      other: 99,
    };
    for (let i = 1; i < oneCycle.length; i++) {
      const prev = oneCycle[i - 1]!;
      const curr = oneCycle[i]!;
      expect(
        regionRank[curr.region],
        `Tab step ${i} (${curr.region}:${curr.label}) came after ${prev.region}:${prev.label}`,
      ).toBeGreaterThanOrEqual(regionRank[prev.region]);
    }

    const visitedRegions = [...new Set(oneCycle.map((step) => step.region))];
    expect(visitedRegions).toContain("skip");
    expect(visitedRegions).toContain("sidebar");
    expect(visitedRegions).toContain("header");
    expect(visitedRegions).toContain("timeline");
    expect(visitedRegions).toContain("composer");
    expect(visitedRegions).not.toContain("other");

    // Sidebar toggle must precede the sidebar rows and must never trail the composer.
    const toggleIndex = oneCycle.findIndex((step) => step.label === "切换主侧边栏");
    const composerIndex = oneCycle.findIndex((step) => step.region === "composer");
    expect(toggleIndex).toBeGreaterThan(0);
    expect(toggleIndex).toBeLessThan(firstMainStep);
    expect(composerIndex).toBeGreaterThan(firstMainStep);

    // Header breadcrumb controls must precede the top-right panel layout controls.
    const headerBreadcrumbIndex = oneCycle.findIndex((step) =>
      step.label.includes(`${app.threads[0]!.title} 的会话操作`),
    );
    const panelToggleIndex = oneCycle.findIndex((step) => step.label === "切换右侧面板");
    expect(headerBreadcrumbIndex).toBeGreaterThanOrEqual(firstMainStep);
    expect(panelToggleIndex).toBeGreaterThan(headerBreadcrumbIndex);

    // Shift+Tab from the first stop wraps cleanly to the last stop without hitting BODY.
    skipLink.focus();
    await userEvent.tab({ shift: true });
    expect(classifyElement(document.activeElement).region).toBe("composer");
  });

  it("reveals the skip-to-main-content link on keyboard focus and jumps directly into main content", async () => {
    await using _app = await mountThreadApp({ width: 1400, height: 900 }, 6);
    const skipLink = page.getByRole("link", { name: "跳到主内容" });
    const skipEl = skipLink.element() as HTMLElement;

    // Visually sr-only (1x1) before focus.
    expect(skipEl.getBoundingClientRect().width).toBeLessThanOrEqual(1);

    skipEl.focus();
    await expect.element(skipLink).toHaveFocus();
    const focusedRect = skipEl.getBoundingClientRect();
    expect(focusedRect.width).toBeGreaterThan(20);
    expect(focusedRect.height).toBeGreaterThan(20);

    await userEvent.keyboard("{Enter}");
    const landed = classifyElement(document.activeElement);
    expect(landed.inMain).toBe(true);
    expect(landed.region).toBe("header");
  });

  it("reaches sidebar row actions with ArrowRight/ArrowLeft while keeping one Tab stop for the thread list", async () => {
    await using _app = await mountThreadApp({ width: 1400, height: 900 }, 6);
    const activeRow = document.querySelector<HTMLElement>(
      '[data-sidebar-row][aria-current="page"]',
    )!;
    expect(activeRow).not.toBeNull();
    expect(activeRow.tabIndex).toBe(0);

    activeRow.focus();
    await userEvent.keyboard("{ArrowRight}");
    const firstAction = document.activeElement as HTMLElement;
    expect(activeRow.contains(firstAction)).toBe(true);
    expect(firstAction.tagName).toBe("BUTTON");
    expect(firstAction.tabIndex).toBe(-1);

    await userEvent.keyboard("{ArrowLeft}");
    expect(document.activeElement).toBe(activeRow);

    // Pressing Tab from the active thread row leaves the entire thread list in one step.
    await userEvent.tab();
    expect((document.activeElement as HTMLElement)?.closest("[data-sidebar-row]")).toBeNull();
  });

  it("keeps Tab out of the closed mobile sidebar sheet with zero BODY drops at 390x844", async () => {
    await using _app = await mountThreadApp({ width: 390, height: 844 }, 6);
    const skipLink = document.querySelector<HTMLElement>("[data-skip-to-main]")!;
    skipLink.focus();

    const steps = [classifyElement(document.activeElement)];
    for (let step = 1; step <= 20; step++) {
      await userEvent.tab();
      steps.push(classifyElement(document.activeElement));
    }

    expect(steps.filter((step) => step.region === "BODY")).toEqual([]);
    expect(steps.filter((step) => step.inClosedMobileSheet)).toEqual([]);
    const firstMainStep = steps.findIndex((step) => step.inMain);
    expect(firstMainStep).toBeGreaterThan(0);
    expect(firstMainStep).toBeLessThanOrEqual(4);
  });
});

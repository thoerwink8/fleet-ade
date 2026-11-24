import { InfoIcon } from "lucide-react";
import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { applyThemePalette } from "~/themePalette";
import { Button } from "../ui/button";
import { render } from "../../../test/render";
import { ComposerBanner } from "./ComposerBanner";
import {
  ComposerBannerStack,
  NoticeText,
  type ComposerBannerStackItem,
} from "./ComposerBannerStack";

function notice(title: string, group?: ComposerBannerStackItem["group"]): ComposerBannerStackItem {
  return { id: title, variant: "default", icon: <InfoIcon />, title, ...(group ? { group } : {}) };
}

it("puts machine notices first, whatever order the notices arrive in", async () => {
  await using screen = await render(
    <ComposerBannerStack items={[notice("Branch changed"), notice("Offline", "environment")]} />,
  );

  expect(screen.container.textContent).toBe("OfflineBranch changed");
});

it("leaves the next attachment its own top edge when there are no notices", async () => {
  await using screen = await render(
    <ComposerBanner.Column>
      <ComposerBannerStack items={[]} />
      <ComposerBanner.Attachment>
        <ComposerBanner.Root data-testid="drawer">等你批准</ComposerBanner.Root>
      </ComposerBanner.Attachment>
    </ComposerBanner.Column>,
  );

  const surface = getComputedStyle(screen.getByTestId("drawer").element());
  expect(surface.borderTopWidth).toBe("1px");
  expect(surface.borderTopLeftRadius).not.toBe("0px");
});

function noticeRow(width: string, children: ReactNode) {
  return (
    <div data-testid="row" className="flex items-center gap-1.5" style={{ width }}>
      <NoticeText detailsLabel="显示详情" className="min-w-0 truncate">
        {children}
      </NoticeText>
    </div>
  );
}

it("leaves out the details button when only a link's hit area reaches past the text", async () => {
  // Phones lay out in device pixels, so a range can measure one float32 step (2^-17 px at
  // this size) wider than its element. Headless Chromium's rects agree exactly.
  const rangeRect = Range.prototype.getBoundingClientRect;
  using _rangeRect = vi
    .spyOn(Range.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: Range) {
      const rect = rangeRect.call(this);
      return new DOMRect(rect.x, rect.y, rect.width + 2 ** -17, rect.height);
    });
  // The flicker is a details button that mounts and then unmounts, so record every insertion.
  const inserted: Node[] = [];
  using observing = new DisposableStack();
  const mutations = new MutationObserver((records) =>
    inserted.push(...records.flatMap((record) => [...record.addedNodes])),
  );
  mutations.observe(document.body, { childList: true, subtree: true });
  observing.defer(() => mutations.disconnect());
  await using screen = await render(
    noticeRow(
      "20rem",
      <>
        Needs input{" "}
        <button type="button" className="relative after:absolute after:-inset-x-10 after:inset-y-0">
          Review
        </button>
      </>,
    ),
  );

  await expect.element(screen.getByText("Review")).toBeVisible();
  const details = [
    ...inserted,
    ...mutations.takeRecords().flatMap((record) => [...record.addedNodes]),
  ].filter(
    (node) =>
      node instanceof Element &&
      (node.matches('[aria-label="Show details"]') ||
        node.querySelector('[aria-label="Show details"]')),
  );
  expect(details).toEqual([]);
});

it("shows the details button while text or nested text is cut, until it fits again", async () => {
  await using screen = await render(noticeRow("4rem", "Waiting on a subagent with a long name"));
  const details = screen.getByRole("button", { name: "显示详情" });
  await expect.element(details).toBeInTheDocument();

  await screen.rerender(noticeRow("4rem", "Ready"));
  await expect.element(details).not.toBeInTheDocument();

  await screen.rerender(noticeRow("4rem", "Waiting on a subagent with a long name"));
  await expect.element(details).toBeInTheDocument();

  screen.getByTestId("row").element().style.width = "40rem";
  await expect.element(details).not.toBeInTheDocument();

  await screen.rerender(
    noticeRow(
      "40rem",
      <span className="inline-block max-w-16 truncate align-bottom">A long nested name</span>,
    ),
  );
  await expect.element(details).toBeInTheDocument();

  await screen.rerender(
    <ComposerBanner.Root>
      {noticeRow("4rem", "Waiting on a subagent with a long name")}
    </ComposerBanner.Root>,
  );
  await expect.element(details).toBeInTheDocument();
  await screen.rerender(<ComposerBanner.Root>{noticeRow("4rem", "Ready")}</ComposerBanner.Root>);
  await expect.element(details).not.toBeInTheDocument();
});

it("opens the details of a long notice right above its button", async () => {
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(1280, 800);
  await using _viewport = {
    [Symbol.asyncDispose]: () => page.viewport(viewport.width, viewport.height),
  };
  const script = Array.from({ length: 400 }, (_, line) => `echo "line ${line}"`).join("\n");
  const container = document.createElement("div");
  container.style.cssText = "position: fixed; bottom: 4rem; right: 4rem;";
  await using screen = await render(noticeRow("40rem", script), { container });
  const details = screen.getByRole("button", { name: "显示详情" });
  await userEvent.hover(details);
  const popup = page.getByLabelText("提示详情");
  await expect.element(popup).toBeVisible();

  // A positioner sized to the unscrolled text flips beside the button and covers it.
  await vi.waitFor(() => {
    const gap =
      details.element().getBoundingClientRect().top -
      popup.element().getBoundingClientRect().bottom;
    expect(gap).toBeGreaterThanOrEqual(0);
    expect(gap).toBeLessThan(8);
  });
});

function resolvedColor(value: string): string {
  const probe = document.createElement("span");
  probe.style.color = value;
  document.body.append(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
}

function colorAlpha(value: string): number {
  const probe = document.createElement("span");
  probe.style.backgroundColor = value;
  document.body.append(probe);
  const color = getComputedStyle(probe).backgroundColor;
  probe.remove();
  const channels = color.match(/[\d.]+/g)?.map(Number) ?? [];
  return channels.length >= 4 ? channels[3]! : 1;
}

function tokenPx(name: string): number {
  return parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
}

const THEMES = [
  { id: "system", dark: false, label: "default light" },
  { id: "system", dark: true, label: "default dark" },
  { id: "grove", dark: false, label: "grove light" },
  { id: "grove", dark: true, label: "grove dark" },
  { id: "ember", dark: false, label: "ember light" },
  { id: "ember", dark: true, label: "ember dark" },
] as const;

function errorNotice(title: string): ComposerBannerStackItem {
  return {
    id: title,
    variant: "error",
    icon: <InfoIcon />,
    title,
    description: "The environment stopped answering.",
    actions: <Button size="sm">重试</Button>,
    dismissLabel: "关闭警告",
    onDismiss: () => undefined,
  };
}

it("paints an opaque neutral surface, with tone only on the mark", async () => {
  const root = document.documentElement;
  const hadDark = root.classList.contains("dark");
  const previousTheme = root.dataset.theme;
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  await using _restore = {
    [Symbol.asyncDispose]: async () => {
      root.classList.toggle("dark", hadDark);
      if (previousTheme === undefined) delete root.dataset.theme;
      else root.dataset.theme = previousTheme;
      applyThemePalette("system", hadDark ? "dark" : "light");
      await page.viewport(viewport.width, viewport.height);
    },
  };

  await using screen = await render(
    <ComposerBannerStack items={[errorNotice("Offline"), notice("Branch changed")]} />,
  );
  const radius = tokenPx("--fa-radius-lg");
  const smallControl = tokenPx("--fa-ctrl-sm");
  expect(radius).toBe(12);
  expect(smallControl).toBe(28);

  for (const width of [390, 1280]) {
    await page.viewport(width, 800);
    for (const theme of THEMES) {
      const appearance = theme.dark ? "dark" : "light";
      root.classList.toggle("dark", theme.dark);
      root.dataset.theme = appearance;
      applyThemePalette(theme.id, appearance);
      const where = `${width}px ${theme.label}`;
      const banner = screen.container.querySelector<HTMLElement>("[data-variant='error']");
      if (!banner) throw new Error(`missing banner at ${where}`);
      const paint = getComputedStyle(banner);
      expect(colorAlpha(paint.backgroundColor), where).toBe(1);
      expect(paint.backgroundImage, where).toBe("none");
      expect(paint.backdropFilter || "none", where).toBe("none");
      expect(paint.getPropertyValue("-webkit-backdrop-filter") || "none", where).toBe("none");
      expect(paint.willChange, where).toBe("auto");
      expect(paint.borderTopWidth, where).toBe("1px");
      expect(parseFloat(paint.borderTopLeftRadius), where).toBe(radius);
      expect(parseFloat(paint.borderBottomLeftRadius), where).toBe(0);
      expect(getComputedStyle(banner, "::before").content, where).toBe("none");

      const title = banner.querySelector(".ade-composer-banner-title");
      const description = banner.querySelector(".ade-composer-banner-secondary");
      const icon = banner.querySelector("[data-slot='composer-banner-icon']");
      if (!title || !description || !icon) throw new Error(`missing banner text at ${where}`);
      const titlePaint = getComputedStyle(title);
      const descriptionPaint = getComputedStyle(description);
      expect(parseFloat(titlePaint.fontSize), where).toBe(14);
      expect(Number(titlePaint.fontWeight), where).toBeLessThanOrEqual(500);
      expect(titlePaint.color, where).toBe(resolvedColor("var(--fa-fg)"));
      expect(parseFloat(descriptionPaint.fontSize), where).toBe(14);
      expect(Number(descriptionPaint.fontWeight), where).toBeLessThanOrEqual(500);
      expect(descriptionPaint.color, where).toBe(resolvedColor("var(--fa-fg-muted)"));
      expect(getComputedStyle(icon).color, where).toBe(resolvedColor("var(--fa-danger)"));
      expect(getComputedStyle(icon).color, where).not.toBe(titlePaint.color);

      for (const side of ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"] as const) {
        expect(parseFloat(paint[side]) % 4, `${where} ${side}`).toBe(0);
      }
      for (const button of banner.querySelectorAll<HTMLElement>("[data-slot='button']")) {
        expect(Math.round(button.getBoundingClientRect().height), where).toBe(smallControl);
      }
    }
  }

  expect(screen.getByRole("button", { name: "关闭警告" }).element()).toBeTruthy();
  const neutral = screen.container.querySelector<HTMLElement>("[data-variant='default']");
  const error = screen.container.querySelector<HTMLElement>("[data-variant='error']");
  if (!neutral || !error) throw new Error("missing stacked banners");
  expect(getComputedStyle(neutral).backgroundColor).toBe(getComputedStyle(error).backgroundColor);
  expect(getComputedStyle(neutral).borderTopWidth).toBe("0px");
  expect(parseFloat(getComputedStyle(neutral).borderTopLeftRadius)).toBe(0);
  expect(parseFloat(getComputedStyle(error).borderTopLeftRadius)).toBe(radius);
});

it("meets the composer without a gap at phone and desktop widths", async () => {
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  await using _viewport = {
    [Symbol.asyncDispose]: () => page.viewport(viewport.width, viewport.height),
  };
  const host = document.createElement("div");
  await using screen = await render(
    <div>
      <ComposerBanner.Dock>
        <ComposerBanner.Column>
          <ComposerBannerStack items={[]} />
        </ComposerBanner.Column>
      </ComposerBanner.Dock>
      <div data-testid="composer" className="h-20" />
    </div>,
    { container: host },
  );

  function joined(items: readonly ComposerBannerStackItem[]) {
    return (
      <div>
        <ComposerBanner.Dock>
          <ComposerBanner.Column>
            <ComposerBannerStack items={items} />
          </ComposerBanner.Column>
        </ComposerBanner.Dock>
        <div data-testid="composer" className="h-20" />
      </div>
    );
  }

  for (const width of [390, 1280]) {
    await page.viewport(width, 800);
    host.style.width = `${width}px`;
    await screen.rerender(joined([]));
    const emptyTop = screen.getByTestId("composer").element().getBoundingClientRect().top;

    await screen.rerender(joined([errorNotice("Offline")]));
    const banner = screen.container.querySelector<HTMLElement>("[data-slot='composer-banner']");
    if (!banner) throw new Error(`missing banner at ${width}`);
    const bannerRect = banner.getBoundingClientRect();
    const oneTop = screen.getByTestId("composer").element().getBoundingClientRect().top;
    const shift = oneTop - emptyTop;
    expect(shift, `${width}px one banner`).toBeGreaterThan(0);
    expect(shift, `${width}px one banner`).toBeLessThanOrEqual(bannerRect.height);
    const overlap = bannerRect.bottom - oneTop;
    expect(overlap, `${width}px seam`).toBeGreaterThanOrEqual(1);
    expect(overlap, `${width}px seam`).toBeLessThan(bannerRect.height);

    await screen.rerender(joined([errorNotice("Offline"), notice("Branch changed")]));
    const banners = [
      ...screen.container.querySelectorAll<HTMLElement>("[data-slot='composer-banner']"),
    ];
    expect(banners, `${width}px stack`).toHaveLength(2);
    const [first, second] = banners as [HTMLElement, HTMLElement];
    const firstRect = first.getBoundingClientRect();
    const secondRect = second.getBoundingClientRect();
    const join = firstRect.bottom - secondRect.top;
    expect(join, `${width}px stack`).toBeGreaterThanOrEqual(1);
    expect(join, `${width}px stack`).toBeLessThan(firstRect.height);
    expect(getComputedStyle(second).borderTopWidth, `${width}px stack`).toBe("0px");
    expect(parseFloat(getComputedStyle(second).borderTopLeftRadius), `${width}px stack`).toBe(0);
    const stackedShift =
      screen.getByTestId("composer").element().getBoundingClientRect().top - emptyTop;
    expect(stackedShift, `${width}px two banners`).toBeGreaterThan(shift);
    expect(stackedShift, `${width}px two banners`).toBeLessThanOrEqual(
      firstRect.height + secondRect.height,
    );
  }
});

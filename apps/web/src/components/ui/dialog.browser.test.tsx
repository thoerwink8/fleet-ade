import { converter, modeOklch, modeRgb, useMode } from "culori/fn";
import { createRef } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import {
  requestConfirmDialog,
  requestConfirmDialogWithCheckbox,
  resetConfirmDialogForTests,
} from "~/confirmDialog";
import "~/index.css";
import { act, render } from "../../../test/render";
import { ConfirmDialogHost } from "../ConfirmDialogHost";
import { Button } from "./button";
import {
  Dialog,
  DialogAction,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "./dialog";

// culori/fn is tree-shakeable: parse rgb/oklch computed styles only after registration.
useMode(modeRgb);
useMode(modeOklch);
const toRgb = converter("rgb");

describe("confirm dialog host", () => {
  it.each([
    {
      name: "a destructive delete",
      message: "它的所有消息会被永久删除，无法恢复。",
      options: { title: "删除这个会话？", confirmLabel: "删除", variant: "destructive" },
    },
    {
      name: "a plain action",
      message: "之后可以取消归档。",
      options: { title: "归档这个会话？", confirmLabel: "归档" },
    },
    {
      name: "a renamed cancel",
      message: "会话已经删除。",
      options: {
        title: "同时删除这个工作树？",
        confirmLabel: "删除工作树",
        cancelLabel: "保留工作树",
        variant: "destructive",
      },
    },
  ] as const)(
    "shows the caller's title and button text for $name and cancels without confirming",
    async ({ message, options }) => {
      resetConfirmDialogForTests();
      await using _screen = await render(<ConfirmDialogHost />);
      let confirmation: Promise<boolean> | undefined;
      await act(() => {
        confirmation = requestConfirmDialog(message, options);
      });
      const cancelLabel = "cancelLabel" in options ? options.cancelLabel : "取消";

      await expect.element(page.getByRole("alertdialog")).toBeVisible();
      const dialogText = page.getByRole("alertdialog").element().textContent;
      expect(dialogText).toContain(options.title);
      expect(dialogText).toContain(message);
      await expect
        .element(page.getByRole("button", { name: options.confirmLabel, exact: true }))
        .toBeVisible();
      await expect
        .element(page.getByRole("button", { name: cancelLabel, exact: true }))
        .toHaveFocus();
      await userEvent.click(page.getByRole("button", { name: cancelLabel, exact: true }));
      await expect(confirmation).resolves.toBe(false);
    },
  );

  it("treats Escape as cancel and returns the checkbox state with a confirmation", async () => {
    resetConfirmDialogForTests();
    await using _screen = await render(<ConfirmDialogHost />);
    let escaped: Promise<{ confirmed: boolean; checked: boolean }> | undefined;
    await act(() => {
      escaped = requestConfirmDialogWithCheckbox("会丢失改动。", {
        title: "删除这个会话？",
        confirmLabel: "删除",
        variant: "destructive",
        checkbox: { label: "同时删除它的工作树" },
      });
    });
    await userEvent.click(page.getByRole("checkbox", { name: "同时删除它的工作树" }));
    await userEvent.keyboard("{Escape}");
    await expect(escaped).resolves.toEqual({ confirmed: false, checked: true });

    let confirmed: Promise<{ confirmed: boolean; checked: boolean }> | undefined;
    await act(() => {
      confirmed = requestConfirmDialogWithCheckbox("会丢失改动。", {
        title: "删除这个会话？",
        confirmLabel: "删除",
        variant: "destructive",
        checkbox: { label: "同时删除它的工作树" },
      });
    });
    await userEvent.click(page.getByRole("button", { name: "删除", exact: true }));
    await expect(confirmed).resolves.toEqual({ confirmed: true, checked: false });
  });
});

describe("dialog initial focus", () => {
  it.each([
    { label: "generic", options: {}, focused: "取消", confirmed: false },
    {
      label: "destructive opt-in",
      options: { variant: "destructive", initialFocus: "confirm" },
      focused: "取消",
      confirmed: false,
    },
    { label: "opt-in", options: { initialFocus: "confirm" }, focused: "继续", confirmed: true },
  ] as const)(
    "focuses $focused for a $label confirmation",
    async ({ options, focused, confirmed }) => {
      resetConfirmDialogForTests();
      await using _screen = await render(<ConfirmDialogHost />);
      let confirmation: Promise<boolean> | undefined;
      await act(() => {
        confirmation = requestConfirmDialog("Continue?", {
          title: "继续吗？",
          confirmLabel: "继续",
          ...options,
        });
      });

      await expect.element(page.getByRole("button", { name: focused, exact: true })).toHaveFocus();
      await userEvent.keyboard("{Enter}");
      await expect(confirmation).resolves.toBe(confirmed);
    },
  );

  it("focuses the dialog action and keeps the caller's popup ref", async () => {
    const popup = createRef<HTMLDivElement>();
    await using _screen = await render(
      <Dialog>
        <DialogTrigger>Open retry</DialogTrigger>
        <DialogPopup ref={popup}>
          <DialogTitle>Import failed</DialogTitle>
          <DialogClose>取消</DialogClose>
          <DialogAction>重试</DialogAction>
        </DialogPopup>
      </Dialog>,
    );
    await act(() => page.getByRole("button", { name: "Open retry" }).element().focus());
    await userEvent.keyboard("{Enter}");

    await expect.element(page.getByRole("button", { name: "重试" })).toHaveFocus();
    expect(popup.current).toBe(page.getByRole("dialog").element());
  });

  it.each(["disabled action", "caller initialFocus"] as const)(
    "falls back to Cancel for a %s",
    async (reason) => {
      const cancel = createRef<HTMLButtonElement>();
      await using _screen = await render(
        <Dialog defaultOpen>
          <DialogPopup {...(reason === "caller initialFocus" ? { initialFocus: cancel } : {})}>
            <DialogTitle>Install update?</DialogTitle>
            <DialogClose ref={cancel} render={<Button variant="outline" />}>
              取消
            </DialogClose>
            <DialogAction disabled={reason === "disabled action"}>安装</DialogAction>
          </DialogPopup>
        </Dialog>,
      );

      await expect.element(page.getByRole("button", { name: "取消", exact: true })).toHaveFocus();
    },
  );

  it("focuses the popup instead of the action when opened by touch", async () => {
    await using _screen = await render(
      <Dialog>
        <DialogTrigger>Open installer</DialogTrigger>
        <DialogPopup>
          <DialogTitle>Install relay client</DialogTitle>
          <DialogClose>取消</DialogClose>
          <DialogAction>安装</DialogAction>
        </DialogPopup>
      </Dialog>,
    );

    const trigger = page.getByRole("button", { name: "Open installer" }).element();
    await act(() => {
      trigger.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }),
      );
      trigger.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerType: "touch" }));
      trigger.dispatchEvent(
        new PointerEvent("click", { bubbles: true, pointerType: "touch", detail: 1 }),
      );
    });

    await expect.element(page.getByRole("dialog")).toHaveFocus();
  });
});

describe("dialog focus management", () => {
  it("keeps Tab and Shift+Tab inside the popup", async () => {
    await using _screen = await render(
      <Dialog>
        <DialogTrigger>Open retry</DialogTrigger>
        <DialogPopup>
          <DialogTitle>Import failed</DialogTitle>
          <DialogClose>取消</DialogClose>
          <DialogAction>重试</DialogAction>
        </DialogPopup>
      </Dialog>,
    );
    await userEvent.click(page.getByRole("button", { name: "Open retry" }));
    const action = page.getByRole("button", { name: "重试" });
    await expect.element(action).toHaveFocus();

    // The action is the last tabbable; Tab wraps to the popup's close button.
    await userEvent.tab();
    await expect.element(page.getByRole("button", { name: "关闭" })).toHaveFocus();

    await userEvent.tab({ shift: true });
    await expect.element(action).toHaveFocus();
    await userEvent.tab({ shift: true });
    await expect.element(page.getByRole("button", { name: "取消" })).toHaveFocus();
    await userEvent.tab({ shift: true });
    await expect.element(page.getByRole("button", { name: "关闭" })).toHaveFocus();
  });

  it("closes on Escape and returns focus to the trigger", async () => {
    await using _screen = await render(
      <Dialog>
        <DialogTrigger>Open retry</DialogTrigger>
        <DialogPopup>
          <DialogTitle>Import failed</DialogTitle>
          <DialogClose>取消</DialogClose>
        </DialogPopup>
      </Dialog>,
    );
    const trigger = page.getByRole("button", { name: "Open retry" });
    await userEvent.click(trigger);
    await expect.element(page.getByRole("dialog")).toBeVisible();

    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    await expect.element(trigger).toHaveFocus();
  });
});

describe("dialog fleet styling", () => {
  function contrastRatio(first: string, second: string): number {
    const luminance = (value: string) => {
      const rgb = toRgb(value)!;
      return [rgb.r, rgb.g, rgb.b]
        .map((channel) =>
          channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
        )
        .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index]!, 0);
    };
    const firstL = luminance(first);
    const secondL = luminance(second);
    return (Math.max(firstL, secondL) + 0.05) / (Math.min(firstL, secondL) + 0.05);
  }

  it("leaves padding to the sections at the fa-space-5 inset", async () => {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    await page.viewport(1024, 768);
    await using _viewport = {
      [Symbol.asyncDispose]: () => page.viewport(viewport.width, viewport.height),
    };
    await using _screen = await render(
      <Dialog defaultOpen>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Import failed</DialogTitle>
          </DialogHeader>
          <DialogPanel>body</DialogPanel>
          <DialogFooter>
            <DialogClose>取消</DialogClose>
          </DialogFooter>
        </DialogPopup>
      </Dialog>,
    );
    const popup = page.getByRole("dialog").element();
    // Sections own the inset so a scrolling panel reaches the surface edges.
    expect(getComputedStyle(popup).paddingLeft).toBe("0px");
    const space5 = getComputedStyle(document.documentElement).getPropertyValue("--fa-space-5");
    const header = popup.querySelector<HTMLElement>('[data-slot="dialog-header"]')!;
    const panel = popup.querySelector<HTMLElement>('[data-slot="dialog-panel"]')!;
    expect(getComputedStyle(header).paddingLeft).toBe(space5.trim());
    expect(getComputedStyle(panel).paddingLeft).toBe(space5.trim());
    const footer = popup.querySelector<HTMLElement>('[data-slot="dialog-footer"]')!;
    expect(getComputedStyle(footer).paddingLeft).toBe(space5.trim());
    expect(getComputedStyle(footer).paddingBottom).toBe(space5.trim());
    const popupStyle = getComputedStyle(popup);
    const radiusLg = getComputedStyle(document.documentElement).getPropertyValue("--fa-radius-lg");
    expect(popupStyle.borderRadius).toBe(radiusLg.trim());
    expect(popupStyle.backdropFilter).toBe("none");
    expect(popupStyle.willChange).toBe("auto");
    expect(toRgb(popupStyle.backgroundColor)?.alpha ?? 1).toBe(1);
  });

  it("keeps 4.5:1 title/description contrast on light and dark fleet palettes", async () => {
    const root = document.documentElement;
    try {
      for (const appearance of ["light", "dark"] as const) {
        root.classList.toggle("dark", appearance === "dark");
        root.dataset.theme = appearance;
        await using _screen = await render(
          <Dialog defaultOpen>
            <DialogPopup>
              <DialogTitle>Import failed</DialogTitle>
              <DialogDescription>Rows were skipped.</DialogDescription>
              <DialogClose>取消</DialogClose>
            </DialogPopup>
          </Dialog>,
        );
        const popup = page.getByRole("dialog").element();
        const surface = getComputedStyle(popup).backgroundColor;
        const title = popup.querySelector<HTMLElement>('[data-slot="dialog-title"]')!;
        const description = popup.querySelector<HTMLElement>('[data-slot="dialog-description"]')!;
        expect(
          contrastRatio(getComputedStyle(title).color, surface),
          `${appearance} title`,
        ).toBeGreaterThanOrEqual(4.5);
        expect(
          contrastRatio(getComputedStyle(description).color, surface),
          `${appearance} description`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    } finally {
      root.classList.remove("dark");
      delete root.dataset.theme;
    }
  });

  it("does not overflow a 390px viewport with the bottom-sheet layout", async () => {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    await page.viewport(390, 844);
    await using _viewport = {
      [Symbol.asyncDispose]: () => page.viewport(viewport.width, viewport.height),
    };
    await using _screen = await render(
      <Dialog defaultOpen>
        <DialogPopup>
          <DialogTitle>A title long enough to wrap onto several lines even on mobile</DialogTitle>
          <DialogDescription>Some description text to fill the sheet body.</DialogDescription>
          <DialogClose>取消</DialogClose>
        </DialogPopup>
      </Dialog>,
    );
    await vi.waitFor(() => {
      const popup = page.getByRole("dialog").element();
      expect(popup.getBoundingClientRect().width).toBeLessThanOrEqual(390);
      expect(popup.scrollWidth).toBeLessThanOrEqual(popup.clientWidth + 1);
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
    });
  });
});

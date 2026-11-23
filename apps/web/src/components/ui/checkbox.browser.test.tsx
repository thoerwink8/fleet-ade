import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { Checkbox, CheckboxMark } from "./checkbox";

describe("Checkbox", () => {
  it("matches fleet-design box geometry, checked colors, and focus ring in light and dark", async () => {
    const root = document.documentElement;
    try {
      await using screen = await render(<Checkbox aria-label="Accept" defaultChecked />);
      const box = screen.getByRole("checkbox", { name: "Accept" }).element();

      await userEvent.keyboard("{Tab}");
      await expect.element(box).toHaveFocus();

      for (const [appearance, expectedBg, expectedFg, expectedRing] of [
        ["light", "rgb(27, 27, 31)", "rgb(255, 255, 255)", "rgb(44, 91, 216)"],
        ["dark", "rgb(236, 236, 238)", "rgb(24, 24, 27)", "rgb(124, 156, 245)"],
      ] as const) {
        root.classList.toggle("dark", appearance === "dark");
        root.dataset.theme = appearance;
        const style = getComputedStyle(box);
        expect(style.width, `${appearance} width`).toBe("16px");
        expect(style.height, `${appearance} height`).toBe("16px");
        expect(style.borderRadius, `${appearance} radius`).toBe("4px");
        expect(style.backgroundColor, `${appearance} checked bg`).toBe(expectedBg);
        expect(style.color, `${appearance} checked mark`).toBe(expectedFg);
        expect(style.outlineStyle, `${appearance} focus ring style`).toBe("solid");
        expect(style.outlineWidth, `${appearance} focus ring width`).toBe("2px");
        expect(style.outlineColor, `${appearance} focus ring color`).toBe(expectedRing);
      }
    } finally {
      root.classList.remove("dark");
      delete root.dataset.theme;
    }
  });

  it("toggles with Space, blocks disabled interaction, and sets aria-checked including mixed", async () => {
    const onDisabledChange = vi.fn();
    await using screen = await render(
      <div>
        <Checkbox aria-label="Active" />
        <Checkbox aria-label="Mixed" indeterminate />
        <Checkbox aria-label="Locked" disabled onCheckedChange={onDisabledChange} />
        <Checkbox aria-label="Invalid" aria-invalid="true" />
        <CheckboxMark checked />
      </div>,
    );

    const active = screen.getByRole("checkbox", { name: "Active" });
    await expect.element(active).toHaveAttribute("aria-checked", "false");
    await userEvent.keyboard("{Tab}");
    await expect.element(active).toHaveFocus();
    await userEvent.keyboard(" ");
    await expect.element(active).toHaveAttribute("aria-checked", "true");

    const mixed = screen.getByRole("checkbox", { name: "Mixed" });
    await expect.element(mixed).toHaveAttribute("aria-checked", "mixed");

    const locked = screen.getByRole("checkbox", { name: "Locked" });
    await expect.element(locked).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(locked, { force: true });
    expect(onDisabledChange).not.toHaveBeenCalled();
    await expect.element(locked).toHaveAttribute("aria-checked", "false");

    const mark = screen.container.querySelector('[aria-hidden][data-slot="checkbox"]');
    const invalid = screen.getByRole("checkbox", { name: "Invalid" }).element();
    expect(getComputedStyle(invalid).borderColor).toBe("rgb(190, 42, 42)");

    expect(getComputedStyle(mark!).width).toBe("16px");
    expect(getComputedStyle(mark!).height).toBe("16px");
    expect(mark?.getAttribute("data-checked")).toBe("");
  });
});

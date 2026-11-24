import { converter, modeOklch, modeRgb, useMode } from "culori/fn";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../test/render";
import { useCommitOnBlur } from "../hooks/useCommitOnBlur";
import { AppRouteModal } from "./AppRouteModal";

useMode(modeRgb);
useMode(modeOklch);
const toRgb = converter("rgb");

function CommitOnBlurField({ onCommit }: { onCommit: (next: string) => void }) {
  return <input aria-label="Instructions" {...useCommitOnBlur("", onCommit)} />;
}

describe("AppRouteModal", () => {
  it("commits a focused field when Esc closes it", async () => {
    const onCommit = vi.fn();
    await using _screen = await render(
      <AppRouteModal label="设置">
        <CommitOnBlurField onCommit={onCommit} />
      </AppRouteModal>,
      { router: "/settings/general" },
    );

    await page.getByRole("textbox", { name: "Instructions" }).fill("Keep titles short");
    await userEvent.keyboard("{Escape}");

    expect(onCommit).toHaveBeenCalledWith("Keep titles short");
  });

  it("uses 12px radius and an opaque surface with no backdrop-filter on sm+", async () => {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    await page.viewport(1024, 768);
    await using _viewport = {
      [Symbol.asyncDispose]: () => page.viewport(viewport.width, viewport.height),
    };
    await using _screen = await render(
      <AppRouteModal label="设置">
        <div>Settings body</div>
      </AppRouteModal>,
      { router: "/settings/general" },
    );

    const popup = page.getByRole("dialog", { name: "设置" }).element();
    const style = getComputedStyle(popup);
    expect(style.borderRadius).toBe("12px");
    expect(style.backdropFilter).toBe("none");
    expect(style.willChange).toBe("auto");
    expect(toRgb(style.backgroundColor)?.alpha ?? 1).toBe(1);
  });
});

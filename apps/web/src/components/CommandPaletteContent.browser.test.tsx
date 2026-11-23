import { type ReactNode, useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { CommandPaletteContent } from "./CommandPaletteContent";
import { CommandDialog, CommandDialogPopup, CommandItem, CommandList } from "./ui/command";

function SubmenuPalette() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        打开
      </button>
      <CommandDialog open={open} onOpenChange={setOpen}>
        <CommandDialogPopup aria-label="命令面板">
          <CommandPaletteContent
            items={["Project A"]}
            inputProps={{
              placeholder: "搜索项目",
              startAddon: (
                <button type="button" aria-label="返回">
                  返回
                </button>
              ),
            }}
          >
            <CommandList>
              {(item: string) => <CommandItem value={item}>{item}</CommandItem>}
            </CommandList>
          </CommandPaletteContent>
        </CommandDialogPopup>
      </CommandDialog>
    </>
  );
}

describe("CommandPaletteContent", () => {
  it("focuses the search input, not the Back button, when it opens into a submenu", async () => {
    await using _screen = await render(<SubmenuPalette />);

    await userEvent.click(page.getByRole("button", { name: "打开" }));

    await expect.element(page.getByPlaceholder("搜索项目")).toHaveFocus();
  });

  it("hides keyboard footer hints on touch while keeping trailing footer content", async () => {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    await page.viewport(1280, 800);
    await using _viewport = {
      [Symbol.asyncDispose]: () => page.viewport(viewport.width, viewport.height),
    };

    const renderPalette = (footerTrailing?: ReactNode) => (
      <CommandDialog open onOpenChange={() => {}}>
        <CommandDialogPopup aria-label="命令面板">
          <CommandPaletteContent
            footerActionLabel="选择"
            footerTrailing={footerTrailing}
            items={["Project A"]}
            inputProps={{ placeholder: "搜索项目" }}
            showBackHint
          >
            <CommandList>
              {(item: string) => <CommandItem value={item}>{item}</CommandItem>}
            </CommandList>
          </CommandPaletteContent>
        </CommandDialogPopup>
      </CommandDialog>
    );

    const realMatchMedia = window.matchMedia.bind(window);
    using _touch = vi
      .spyOn(window, "matchMedia")
      .mockImplementation((query) => realMatchMedia(query === "(pointer: coarse)" ? "all" : query));

    await using screen = await render(renderPalette(<span>正在搜索消息…</span>));
    await expect.element(page.getByText("正在搜索消息…", { exact: true })).toBeVisible();
    expect(document.querySelector('[data-slot="command-footer"]')).not.toBeNull();
    expect(document.querySelectorAll('[data-slot="kbd"]')).toHaveLength(0);
    await expect.element(page.getByText("移动", { exact: true })).not.toBeInTheDocument();

    await screen.rerender(renderPalette());
    expect(document.querySelector('[data-slot="command-footer"]')).toBeNull();
  });
});

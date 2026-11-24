import { useRef } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { cdp, page } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../test/render";
import { SidebarThreadHeader } from "../components/sidebar/SidebarThreadHeader";
import { CommandShortcut } from "../components/ui/command";
import { MenuShortcut } from "../components/ui/menu";
import { SidebarProvider } from "../components/ui/sidebar";
import { useVisibleShortcutLabel } from "./useKeyboardShortcutHints";

async function emulateCoarsePointer() {
  const prev = { width: window.innerWidth, height: window.innerHeight };
  const session = cdp();
  await page.viewport(390, 844);
  await session.send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
  });
  await session.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await session.send("Emulation.setEmulatedMedia", {
    features: [
      { name: "pointer", value: "coarse" },
      { name: "hover", value: "none" },
    ],
  });
  return {
    async [Symbol.asyncDispose]() {
      await session.send("Emulation.setEmulatedMedia", { features: [] });
      await session.send("Emulation.setTouchEmulationEnabled", { enabled: false });
      await session.send("Emulation.clearDeviceMetricsOverride");
      await page.viewport(prev.width, prev.height);
    },
  };
}

function ShortcutHintsHarness() {
  const searchInputRef = useRef<HTMLInputElement>(null);
  const toggleShortcut = useVisibleShortcutLabel("Ctrl+B");

  return (
    <SidebarProvider>
      <div>
        <SidebarThreadHeader
          searchInputRef={searchInputRef}
          searchShortcutLabel="Ctrl+K"
          searchQuery=""
          onSearchQueryChange={() => {}}
          onSearchKeyDown={() => {}}
          isSearching={false}
          searchResultCount={0}
          activeSearchResultIndex={0}
          onClearSearch={() => {}}
        />
        <MenuShortcut>Ctrl+P</MenuShortcut>
        <CommandShortcut>Ctrl+N</CommandShortcut>
        <output aria-label="Visible shortcut">{toggleShortcut ?? ""}</output>
      </div>
    </SidebarProvider>
  );
}

describe("useKeyboardShortcutHints browser integration", () => {
  it("shows keyboard shortcut hints on desktop fine-pointer viewports", async () => {
    const prev = { width: window.innerWidth, height: window.innerHeight };
    await page.viewport(1280, 800);
    await using _viewport = {
      [Symbol.asyncDispose]: () => page.viewport(prev.width, prev.height),
    };
    await using screen = await render(<ShortcutHintsHarness />, {
      router: false /* no routes involved */,
    });

    expect(screen.container.querySelector('[data-slot="kbd"]')?.textContent).toBe("Ctrl+K");
    expect(screen.container.querySelector('[data-slot="menu-shortcut"]')?.textContent).toBe(
      "Ctrl+P",
    );
    expect(screen.container.querySelector('[data-slot="command-shortcut"]')?.textContent).toBe(
      "Ctrl+N",
    );
    await expect.element(screen.getByLabelText("Visible shortcut")).toHaveTextContent("Ctrl+B");
  });

  it("hides all keyboard shortcut hints under pointer: coarse", async () => {
    await using _pointer = await emulateCoarsePointer();
    await using screen = await render(<ShortcutHintsHarness />, {
      router: false /* no routes involved */,
    });

    await vi.waitFor(() => expect(window.matchMedia("(pointer: coarse)").matches).toBe(true));

    expect(screen.container.querySelectorAll('[data-slot="kbd"]')).toHaveLength(0);
    expect(screen.container.querySelector('[data-slot="menu-shortcut"]')).toBeNull();
    expect(screen.container.querySelector('[data-slot="command-shortcut"]')).toBeNull();
    await expect.element(screen.getByLabelText("Visible shortcut")).toHaveTextContent("");
  });

  it("hides all keyboard shortcut hints on narrow mobile viewports", async () => {
    const prev = { width: window.innerWidth, height: window.innerHeight };
    await page.viewport(390, 844);
    await using _viewport = {
      [Symbol.asyncDispose]: () => page.viewport(prev.width, prev.height),
    };
    await using screen = await render(<ShortcutHintsHarness />, {
      router: false /* no routes involved */,
    });

    expect(screen.container.querySelectorAll('[data-slot="kbd"]')).toHaveLength(0);
    expect(screen.container.querySelector('[data-slot="menu-shortcut"]')).toBeNull();
    expect(screen.container.querySelector('[data-slot="command-shortcut"]')).toBeNull();
    await expect.element(screen.getByLabelText("Visible shortcut")).toHaveTextContent("");
  });
});

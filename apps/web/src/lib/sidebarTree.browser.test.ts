import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { installSidebarToolbar, installSidebarTree } from "./sidebarTree";

function setup() {
  const root = document.createElement("div");
  document.body.append(root);
  let dispose: (() => void) | undefined;
  const row = (id: string, parent?: string) => {
    const element = document.createElement("button");
    element.dataset.sidebarRow = id;
    if (parent) element.dataset.sidebarParent = parent;
    element.textContent = id;
    root.append(element);
    return element;
  };
  return {
    root,
    row,
    install: () => {
      dispose = installSidebarTree(root);
    },
    [Symbol.dispose]() {
      dispose?.();
      root.remove();
    },
  };
}

function press(target: HTMLElement, key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

describe("sidebar keyboard navigation", () => {
  it("moves focus without activating rows, clamps at the ends, and keeps a single roving Tab stop", () => {
    using tree = setup();
    const first = tree.row("first");
    const second = tree.row("second");
    const last = tree.row("last");
    const activate = vi.fn();
    tree.root.addEventListener("click", activate);
    tree.install();
    expect([first.tabIndex, second.tabIndex, last.tabIndex]).toEqual([0, -1, -1]);
    first.focus();
    press(first, "ArrowDown");
    expect(document.activeElement).toBe(second);
    expect([first.tabIndex, second.tabIndex, last.tabIndex]).toEqual([-1, 0, -1]);
    press(second, "End");
    expect(document.activeElement).toBe(last);
    expect([first.tabIndex, second.tabIndex, last.tabIndex]).toEqual([-1, -1, 0]);
    press(last, "ArrowDown");
    expect(document.activeElement).toBe(last);
    press(last, "Home");
    expect(document.activeElement).toBe(first);
    expect([first.tabIndex, second.tabIndex, last.tabIndex]).toEqual([0, -1, -1]);
    expect(activate).not.toHaveBeenCalled();
  });

  it("expands a group before entering its first child and returns to the parent", () => {
    using tree = setup();
    const group = tree.row("project");
    group.setAttribute("aria-expanded", "false");
    group.addEventListener("click", () => {
      const expanded = group.getAttribute("aria-expanded") === "true";
      group.setAttribute("aria-expanded", String(!expanded));
      if (expanded) tree.root.querySelector('[data-sidebar-row="thread"]')?.remove();
      else tree.row("thread", "project");
    });
    tree.install();
    group.focus();
    press(group, "ArrowRight");
    expect(group.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(group);
    press(group, "ArrowRight");
    const child = document.activeElement as HTMLElement;
    expect(child.dataset.sidebarRow).toBe("thread");
    press(child, "ArrowLeft");
    expect(document.activeElement).toBe(group);
    press(group, "ArrowLeft");
    expect(group.getAttribute("aria-expanded")).toBe("false");
  });

  it("opens the row menu on Shift+F10 release without moving focus", () => {
    using tree = setup();
    tree.row("first");
    const selected = tree.row("selected");
    const contextMenu = vi.fn((event: MouseEvent) => event.preventDefault());
    selected.addEventListener("contextmenu", contextMenu);
    tree.install();
    selected.focus();
    expect(press(selected, "F10", { shiftKey: true }).defaultPrevented).toBe(true);
    expect(contextMenu).not.toHaveBeenCalled();
    selected.dispatchEvent(
      new KeyboardEvent("keyup", { key: "F10", shiftKey: true, bubbles: true, cancelable: true }),
    );
    expect(contextMenu).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(selected);
  });

  it("keeps row actions out of the Tab order and navigates them with ArrowRight, ArrowLeft, and Escape", () => {
    using tree = setup();
    const row = document.createElement("div");
    row.setAttribute("role", "button");
    row.tabIndex = 0;
    row.dataset.sidebarRow = "first";
    const snooze = document.createElement("button");
    snooze.textContent = "Snooze";
    const settle = document.createElement("button");
    settle.textContent = "Settle";
    row.append(snooze, settle);
    tree.root.append(row);
    const second = tree.row("second");
    tree.install();

    expect([row.tabIndex, snooze.tabIndex, settle.tabIndex, second.tabIndex]).toEqual([
      0, -1, -1, -1,
    ]);
    row.focus();
    press(row, "ArrowRight");
    expect(document.activeElement).toBe(snooze);
    press(snooze, "ArrowRight");
    expect(document.activeElement).toBe(settle);
    press(settle, "ArrowLeft");
    expect(document.activeElement).toBe(snooze);
    press(snooze, "ArrowLeft");
    expect(document.activeElement).toBe(row);

    press(row, "ArrowRight");
    expect(document.activeElement).toBe(snooze);
    press(snooze, "Escape");
    expect(document.activeElement).toBe(row);

    press(row, "ArrowRight");
    press(snooze, "ArrowDown");
    expect(document.activeElement).toBe(second);
    expect([row.tabIndex, snooze.tabIndex, settle.tabIndex, second.tabIndex]).toEqual([
      -1, -1, -1, 0,
    ]);
  });

  it("keeps a rendered row under a collapsed group reachable", () => {
    using tree = setup();
    const shelf = tree.row("shelf:settled");
    shelf.setAttribute("aria-expanded", "false");
    // A collapsed shelf still renders the open thread.
    const open = tree.row("thread", "shelf:settled");
    tree.install();
    shelf.focus();
    press(shelf, "ArrowDown");
    expect(document.activeElement).toBe(open);
  });

  it("skips disabled rows and leaves controls outside rows in the Tab order", () => {
    using tree = setup();
    const first = tree.row("first");
    const loading = tree.row("settled:more");
    loading.disabled = true;
    const undo = document.createElement("button");
    undo.textContent = "Undo";
    tree.root.append(undo);
    tree.install();
    first.focus();
    press(first, "ArrowDown");
    expect(document.activeElement).toBe(first);
    expect(undo.tabIndex).toBe(0);
  });

  it("keeps the scroll position when focus follows a row that moved away", async () => {
    using tree = setup();
    Object.assign(tree.root.style, { height: "100px", overflow: "auto" });
    const settled = tree.row("settled");
    const settle = document.createElement("button");
    settle.textContent = "Settle";
    settled.after(settle);
    settle.dataset.sidebarActionFor = "settled";
    for (let index = 0; index < 20; index++) tree.row(`row-${index}`).style.display = "block";
    tree.install();
    settle.focus();
    // Settling moves the row to the shelf at the bottom and removes the focused button.
    settle.remove();
    settled.remove();
    const moved = tree.row("settled");
    await vi.waitFor(() => expect(document.activeElement).toBe(moved));
    expect(tree.root.scrollTop).toBe(0);
  });

  it("does not pull focus back after a click outside the rows", async () => {
    using tree = setup();
    const first = tree.row("first");
    tree.install();
    const text = document.createElement("p");
    text.textContent = "Chat text";
    document.body.append(text);
    using _text = { [Symbol.dispose]: () => text.remove() };
    const spacer = document.createElement("div");
    spacer.textContent = "Empty list space";
    tree.root.append(spacer);
    for (const target of [text, spacer]) {
      first.focus();
      await userEvent.click(target);
      expect(document.activeElement).toBe(document.body);
      // A status change re-renders the list while the user works elsewhere.
      tree.row(`second-${target.tagName}`);
      // The list's mutation observer callback is queued ahead of this continuation.
      await Promise.resolve();
      expect(document.activeElement).toBe(document.body);
    }
  });

  it("manages roving tabindex for a horizontal sidebar toolbar", () => {
    const bar = document.createElement("div");
    const buttons = ["设置", "PR", "用量", "机群"].map((label) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      bar.append(button);
      return button;
    });
    document.body.append(bar);
    const dispose = installSidebarToolbar(bar);
    using _bar = {
      [Symbol.dispose]() {
        dispose();
        bar.remove();
      },
    };

    expect(buttons.map((b) => b.tabIndex)).toEqual([0, -1, -1, -1]);
    buttons[0]!.focus();
    press(buttons[0]!, "ArrowRight");
    expect(document.activeElement).toBe(buttons[1]);
    expect(buttons.map((b) => b.tabIndex)).toEqual([-1, 0, -1, -1]);
    press(buttons[1]!, "End");
    expect(document.activeElement).toBe(buttons[3]);
    press(buttons[3]!, "ArrowLeft");
    expect(document.activeElement).toBe(buttons[2]);
    press(buttons[2]!, "Home");
    expect(document.activeElement).toBe(buttons[0]);
  });
});

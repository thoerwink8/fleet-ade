const ROW = "[data-sidebar-row]";
const INTERACTIVE_ROW = 'button, a[href], [role="button"], [tabindex]';
const ROW_ACTION = "button:not(:disabled), a[href]";
const TOOLBAR_ITEM = "button:not(:disabled), a[href]";

function isVisibleControl(root: HTMLElement, element: HTMLElement): boolean {
  const hidden = element.closest('[hidden], [inert], [aria-hidden="true"]');
  if (hidden && root.contains(hidden)) return false;
  if (element.matches(":disabled")) return false;
  const style = getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden";
}

function setTabIndex(element: HTMLElement, value: 0 | -1) {
  if (element.tabIndex !== value) {
    element.tabIndex = value;
  }
}

/** Ref callback for a sidebar list; installs its keyboard navigation and returns its cleanup. */
export function attachSidebarTree(element: HTMLElement | null) {
  return element ? installSidebarTree(element) : undefined;
}

/** Ref callback for a horizontal sidebar toolbar; installs roving tabindex and arrow navigation. */
export function attachSidebarToolbar(element: HTMLElement | null) {
  return element ? installSidebarToolbar(element) : undefined;
}

/**
 * Roving tabindex for a horizontal sidebar utility strip: one Tab stop for the bar,
 * with ArrowLeft/ArrowRight/Home/End moving between its visible controls.
 */
export function installSidebarToolbar(root: HTMLElement) {
  let lastFocused: HTMLElement | undefined;

  const visibleItems = () =>
    Array.from(root.querySelectorAll<HTMLElement>(TOOLBAR_ITEM)).filter((item) =>
      isVisibleControl(root, item),
    );

  const syncTabStops = () => {
    const items = visibleItems();
    if (items.length === 0) return;
    const active = document.activeElement;
    const focused =
      active instanceof HTMLElement && root.contains(active)
        ? items.find((item) => item === active || item.contains(active))
        : undefined;
    const current =
      focused ?? (lastFocused && items.includes(lastFocused) ? lastFocused : undefined) ?? items[0];
    for (const item of items) {
      setTabIndex(item, item === current ? 0 : -1);
    }
  };

  const onFocusIn = (event: FocusEvent) => {
    if (!(event.target instanceof HTMLElement) || !root.contains(event.target)) return;
    const items = visibleItems();
    const focused = items.find(
      (item) => item === event.target || item.contains(event.target as Node),
    );
    if (!focused) return;
    lastFocused = focused;
    syncTabStops();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (
      event.defaultPrevented ||
      event.isComposing ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey
    ) {
      return;
    }
    const target = event.target;
    if (!(target instanceof HTMLElement) || !root.contains(target)) return;
    if (target.closest('[role="menu"], [role="listbox"]')) return;
    const items = visibleItems();
    const index = items.indexOf(target);
    if (index < 0) return;
    let next: HTMLElement | undefined;
    switch (event.key) {
      case "ArrowRight":
        next = items[Math.min(index + 1, items.length - 1)];
        break;
      case "ArrowLeft":
        next = items[Math.max(index - 1, 0)];
        break;
      case "Home":
        next = items[0];
        break;
      case "End":
        next = items.at(-1);
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (next && next !== target) {
      lastFocused = next;
      syncTabStops();
      next.focus();
    }
  };

  const observer = new MutationObserver(syncTabStops);
  observer.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["hidden", "inert", "aria-hidden", "disabled"],
  });
  root.addEventListener("focusin", onFocusIn);
  root.addEventListener("keydown", onKeyDown);
  syncTabStops();

  return () => {
    observer.disconnect();
    root.removeEventListener("focusin", onFocusIn);
    root.removeEventListener("keydown", onKeyDown);
  };
}

/**
 * Roving tabindex and arrow navigation for the sidebar list:
 * - One Tab stop for the entire list (on the active/current row), so Tab exits to main content cleanly.
 * - ArrowUp/ArrowDown/Home/End move between rows without activating them.
 * - ArrowRight enters a row's inline action buttons (or expands a collapsible group); ArrowLeft/Escape returns.
 */
export function installSidebarTree(root: HTMLElement) {
  let focusedId: string | undefined;
  let focusedParent: string | undefined;
  let focusedIndex = -1;
  let ownsFocus = false;
  let contextMenuRow: HTMLElement | undefined;

  const isVisibleRow = (row: HTMLElement) => {
    if (!row.matches(INTERACTIVE_ROW)) return false;
    const hidden = row.closest('[hidden], [inert], [aria-hidden="true"]');
    // A dialog can temporarily make the whole workspace inert. Keep rows navigable
    // for its return while still excluding exiting row clones.
    return (!hidden || !root.contains(hidden)) && !row.matches(":disabled");
  };
  const visibleRows = () =>
    Array.from(root.querySelectorAll<HTMLElement>(ROW)).filter(isVisibleRow);

  const ownerRow = (element: HTMLElement) => {
    const row = element.closest<HTMLElement>(ROW);
    if (row) return row;
    const linked = element.dataset.sidebarActionFor;
    return linked
      ? root.querySelector<HTMLElement>(`[data-sidebar-row="${CSS.escape(linked)}"]`)
      : null;
  };

  const rowActionsFor = (row: HTMLElement): HTMLElement[] => {
    const actions: HTMLElement[] = [];
    for (const candidate of row.querySelectorAll<HTMLElement>(ROW_ACTION)) {
      if (candidate === row || candidate.closest(ROW) !== row) continue;
      if (isVisibleControl(root, candidate)) actions.push(candidate);
    }
    const rowId = row.dataset.sidebarRow;
    if (rowId) {
      for (const candidate of root.querySelectorAll<HTMLElement>(
        `[data-sidebar-action-for="${CSS.escape(rowId)}"]`,
      )) {
        if (!actions.includes(candidate) && isVisibleControl(root, candidate)) {
          actions.push(candidate);
        }
      }
    }
    return actions;
  };

  const syncTabStops = () => {
    const rows = visibleRows();
    if (rows.length === 0) return;
    const active = document.activeElement;
    const activeRow =
      active instanceof HTMLElement && root.contains(active) ? ownerRow(active) : null;
    const currentRow =
      (activeRow && rows.includes(activeRow) ? activeRow : undefined) ??
      (focusedId !== undefined
        ? rows.find((row) => row.dataset.sidebarRow === focusedId)
        : undefined) ??
      rows.find((row) => row.getAttribute("aria-current") === "page") ??
      rows[0];
    for (const row of rows) {
      setTabIndex(row, row === currentRow ? 0 : -1);
      for (const action of row.querySelectorAll<HTMLElement>(ROW_ACTION)) {
        if (action !== row && action.closest(ROW) === row) {
          setTabIndex(action, -1);
        }
      }
    }
    for (const linkedAction of root.querySelectorAll<HTMLElement>("[data-sidebar-action-for]")) {
      if (linkedAction.matches(ROW_ACTION)) {
        setTabIndex(linkedAction, -1);
      }
    }
  };

  const focusRow = (row: HTMLElement) => {
    // Revealing before focusing also materializes content-visibility:auto descendants.
    row.scrollIntoView({ block: "nearest" });
    focusedId = row.dataset.sidebarRow;
    focusedParent = row.dataset.sidebarParent;
    syncTabStops();
    row.focus({ preventScroll: true });
  };

  // A row that moves shelves remounts and drops focus to the body; follow it.
  const restoreFocus = () => {
    syncTabStops();
    if (!ownsFocus || focusedId === undefined) return;
    const active = document.activeElement;
    const lost =
      active === document.body ||
      (active instanceof HTMLElement &&
        root.contains(active) &&
        active.matches(ROW) &&
        !isVisibleRow(active));
    if (!lost) return;
    const rows = visibleRows();
    const target =
      rows.find((row) => row.dataset.sidebarRow === focusedId) ??
      rows.find((row) => row.dataset.sidebarRow === focusedParent) ??
      rows[Math.min(Math.max(focusedIndex, 0), rows.length - 1)];
    // A settled row moves to the bottom shelf; scrolling after it fights the route reveal.
    if (target) {
      focusedId = target.dataset.sidebarRow;
      syncTabStops();
      target.focus({ preventScroll: true });
    }
  };

  // Clicking non-focusable content, including empty list space, drops focus to the body
  // without a focusin event. A click on the focused row fires no focusin either.
  const onPointerDown = (event: PointerEvent) => {
    const focusable =
      event.target instanceof Element
        ? event.target.closest(`${ROW}, button, a[href], input, [tabindex]`)
        : null;
    ownsFocus = focusable !== null && root.contains(focusable);
  };
  const onFocus = (event: FocusEvent) => {
    ownsFocus = root.contains(event.target as Node);
    if (!ownsFocus || !(event.target instanceof HTMLElement)) return;
    const row = ownerRow(event.target);
    if (!row) return;
    focusedId = row.dataset.sidebarRow;
    focusedParent = row.dataset.sidebarParent;
    focusedIndex = visibleRows().indexOf(row);
    syncTabStops();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const targetEl = event.target;
    if (!(targetEl instanceof HTMLElement)) return;
    if (
      targetEl.tagName === "INPUT" ||
      targetEl.tagName === "TEXTAREA" ||
      targetEl.isContentEditable ||
      targetEl.closest('[role="menu"], [role="listbox"]')
    ) {
      return;
    }
    if (
      !event.defaultPrevented &&
      !event.isComposing &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) &&
      targetEl.matches(ROW)
    ) {
      event.preventDefault();
      event.stopPropagation();
      contextMenuRow = targetEl;
      return;
    }
    if (
      event.defaultPrevented ||
      event.isComposing ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey
    )
      return;

    const isRow = targetEl.matches(ROW);
    const owningRow = isRow ? targetEl : ownerRow(targetEl);
    if (!owningRow) return;

    if (!isRow) {
      const actions = rowActionsFor(owningRow);
      const actionIndex = actions.indexOf(targetEl);
      if (actionIndex < 0) return;
      switch (event.key) {
        case "ArrowRight": {
          event.preventDefault();
          event.stopPropagation();
          const next = actions[Math.min(actionIndex + 1, actions.length - 1)];
          next?.focus({ preventScroll: true });
          return;
        }
        case "ArrowLeft": {
          event.preventDefault();
          event.stopPropagation();
          if (actionIndex > 0) {
            actions[actionIndex - 1]?.focus({ preventScroll: true });
          } else {
            focusRow(owningRow);
          }
          return;
        }
        case "Escape": {
          event.preventDefault();
          event.stopPropagation();
          focusRow(owningRow);
          return;
        }
        case "ArrowDown":
        case "ArrowUp":
        case "Home":
        case "End":
          break;
        default:
          return;
      }
    }

    const rows = visibleRows();
    const index = rows.indexOf(owningRow);
    if (index < 0) return;
    let target: HTMLElement | undefined;
    switch (event.key) {
      case "ArrowDown":
        target = rows[Math.min(index + 1, rows.length - 1)];
        break;
      case "ArrowUp":
        target = rows[Math.max(index - 1, 0)];
        break;
      case "Home":
        target = rows[0];
        break;
      case "End":
        target = rows.at(-1);
        break;
      case "ArrowRight":
        if (owningRow.getAttribute("aria-expanded") === "false") {
          owningRow.click();
        } else if (owningRow.getAttribute("aria-expanded") === "true") {
          target = rows.find(
            (candidate) => candidate.dataset.sidebarParent === owningRow.dataset.sidebarRow,
          );
        } else {
          const actions = rowActionsFor(owningRow);
          if (actions.length > 0) {
            event.preventDefault();
            event.stopPropagation();
            actions[0]?.focus({ preventScroll: true });
            return;
          }
          target = rows.find(
            (candidate) => candidate.dataset.sidebarParent === owningRow.dataset.sidebarRow,
          );
        }
        break;
      case "ArrowLeft":
        if (owningRow.getAttribute("aria-expanded") === "true") owningRow.click();
        else
          target = rows.find(
            (candidate) => candidate.dataset.sidebarRow === owningRow.dataset.sidebarParent,
          );
        break;
      // Row handlers own Enter, Space, F2 rename, and the context menu.
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (target) focusRow(target);
  };
  const onKeyUp = (event: KeyboardEvent) => {
    if (!contextMenuRow || (event.key !== "ContextMenu" && event.key !== "F10")) return;
    const row = contextMenuRow;
    contextMenuRow = undefined;
    event.preventDefault();
    event.stopPropagation();
    if (document.activeElement !== row || !row.isConnected) return;
    const rect = row.getBoundingClientRect();
    // Like VS Code's list, suppress keydown and open on release. Reuse the row's
    // selection-aware handler, including its Electron native menu route.
    row.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: rect.left,
        clientY: rect.bottom,
      }),
    );
  };
  const observer = new MutationObserver(restoreFocus);
  observer.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["hidden", "inert", "aria-hidden", "aria-current", "disabled"],
  });
  document.addEventListener("focusin", onFocus);
  document.addEventListener("pointerdown", onPointerDown, true);
  root.addEventListener("keydown", onKeyDown, true);
  root.addEventListener("keyup", onKeyUp, true);
  syncTabStops();
  return () => {
    observer.disconnect();
    document.removeEventListener("focusin", onFocus);
    document.removeEventListener("pointerdown", onPointerDown, true);
    root.removeEventListener("keydown", onKeyDown, true);
    root.removeEventListener("keyup", onKeyUp, true);
  };
}

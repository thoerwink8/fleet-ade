import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type KeyboardEvent,
} from "react";
import {
  ArchiveIcon,
  BotIcon,
  CalendarClockIcon,
  ChevronRightIcon,
  FolderTreeIcon,
  PaletteIcon,
  SearchIcon,
  ServerIcon,
  MessagesSquareIcon,
  PanelsTopLeftIcon,
  Settings2Icon,
  WrenchIcon,
  XIcon,
} from "lucide-react";
import { resolveEventKeys } from "@t3tools/shared/keybindings";
import { useLocation, useNavigate } from "@tanstack/react-router";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarInput,
} from "../ui/sidebar";
import { scrollToSettingsTarget } from "./settingsLayout";
import { isSettingsIndexPath } from "./settingsPath.logic";
import {
  searchSettings,
  SETTINGS_NAV_GROUPS,
  SETTINGS_SECTION_LABELS,
  type SettingsPath,
  type SettingsSearchItem,
} from "./settingsSearch";
import { useAvailableSettingsSearchItems } from "./useAvailableSettingsSearchItems";
import { handleSettingsSectionKeyDown } from "./settingsSectionNavigation";
import { workspaceAreaProps } from "../../lib/workspaceFocus";

const T3ConnectSidebarSignIn = lazy(() =>
  import("../clerk/T3ConnectSidebarSignIn").then((module) => ({
    default: module.T3ConnectSidebarSignIn,
  })),
);
const T3ConnectSidebarAvatar = lazy(() =>
  import("../clerk/T3ConnectSidebarSignIn").then((module) => ({
    default: module.T3ConnectSidebarAvatar,
  })),
);

const SETTINGS_SECTION_ICONS: Readonly<
  Record<SettingsPath, ComponentType<{ className?: string }>>
> = {
  "/settings/general": Settings2Icon,
  "/settings/network": Settings2Icon,
  "/settings/diagnostics": WrenchIcon,
  "/settings/appearance": PaletteIcon,
  "/settings/chat": MessagesSquareIcon,
  "/settings/diffs": PaletteIcon,
  "/settings/projects": PanelsTopLeftIcon,
  "/settings/keybindings": Settings2Icon,
  "/settings/providers": BotIcon,
  "/settings/threads": MessagesSquareIcon,
  "/settings/scheduled-tasks": CalendarClockIcon,
  "/settings/source-control": PanelsTopLeftIcon,
  "/settings/worktrees": FolderTreeIcon,
  "/settings/connections": ServerIcon,
  "/settings/access": ServerIcon,
  "/settings/secrets": ServerIcon,
  "/settings/maintenance": WrenchIcon,
  "/settings/about": WrenchIcon,
  "/settings/archived": ArchiveIcon,
};

// Detail pages without a nav entry highlight the section that links to them.
const SETTINGS_DETAIL_PAGE_PARENTS: Readonly<Record<string, SettingsPath>> = {
  "/settings/diagnostics": "/settings/maintenance",
  "/settings/open-source-licenses": "/settings/maintenance",
};

// Attached only to the highlighted result, so it runs whenever the highlight lands on a row.
function scrollResultIntoView(row: HTMLElement | null) {
  row?.scrollIntoView({ block: "nearest" });
}

function SettingsSectionIcon({ to }: { to: SettingsPath }) {
  const Icon = SETTINGS_SECTION_ICONS[to];
  return <Icon className="size-4 shrink-0 text-(--sidebar-icon-color)" />;
}

export function SettingsSidebarNav({ pathname }: { pathname: string }) {
  const navArea = workspaceAreaProps("settings-nav", 0, "设置分类");
  const navigate = useNavigate();
  const currentHash = useLocation({ select: (location) => location.hash });
  const isSettingsIndex = isSettingsIndexPath(pathname);
  const activePath = SETTINGS_DETAIL_PAGE_PARENTS[pathname] ?? pathname;
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [activeResultIndex, setActiveResultIndex] = useState(0);
  const searchableItems = useAvailableSettingsSearchItems();
  const results = searchSettings(query, searchableItems);
  const isSearching = query.trim().length > 0;
  const hasResults = results.length > 0;
  const maxResultIndex = Math.max(results.length - 1, 0);
  // Persist the clamp so a shrink-then-recover of results keeps the clamped highlight.
  if (activeResultIndex > maxResultIndex) {
    setActiveResultIndex(maxResultIndex);
  }

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- window keydown listener for the find and slash search shortcuts
  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const eventKeys = resolveEventKeys(event);
      const isFindShortcut =
        eventKeys.has("f") && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey;
      // Shift is allowed only when the layout types "/" with it (German Shift+7); Shift on
      // the physical Slash key types "?" or "," instead.
      const isSlashShortcut =
        eventKeys.has("/") &&
        (event.key === "/" || !event.shiftKey) &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey;
      if (!isFindShortcut && !isSlashShortcut) return;

      const input = searchInputRef.current;
      if (!input || input.offsetParent === null) return;

      const target = event.target;
      if (
        target instanceof HTMLElement &&
        ((isSlashShortcut &&
          (target.tagName === "INPUT" ||
            target.tagName === "TEXTAREA" ||
            target.isContentEditable)) ||
          target.closest(
            '[role="dialog"]:not([data-app-modal]), [aria-modal="true"]:not([data-app-modal]), [data-slot$="popup"]:not([data-app-modal]), [data-keybinding-capture]',
          ) !== null)
      ) {
        return;
      }

      event.preventDefault();
      input.focus();
      input.select();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const handleSectionClick = (to: SettingsPath) => {
    void navigate({
      to,
      hash: "",
      replace: !isSettingsIndex,
      hashScrollIntoView: false,
      ...(isSettingsIndex ? { state: { fromSettingsIndex: true } } : {}),
    });
  };

  const clearSearch = () => {
    setQuery("");
    setActiveResultIndex(0);
  };
  const handleSearchResultClick = (item: SettingsSearchItem) => {
    clearSearch();
    const targetId = item.targetId ?? item.id;
    if (pathname === item.to && currentHash.replace(/^#/, "") === targetId) {
      scrollToSettingsTarget(targetId);
      return;
    }
    void navigate({
      to: item.to,
      hash: targetId,
      replace: !isSettingsIndex,
      hashScrollIntoView: false,
      state: {
        settingsTargetHighlight: true,
        ...(isSettingsIndex ? { fromSettingsIndex: true } : {}),
      },
    });
  };

  const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape" && isSearching) {
      event.preventDefault();
      event.stopPropagation();
      clearSearch();
      return;
    }
    if (results.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveResultIndex((activeResultIndex + 1) % results.length);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveResultIndex((activeResultIndex - 1 + results.length) % results.length);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const result = results[activeResultIndex];
      if (result) handleSearchResultClick(result);
    }
  };

  return (
    <nav
      {...navArea}
      role="navigation"
      className="flex min-h-0 w-52 shrink-0 flex-col border-e bg-sidebar text-sidebar-foreground max-md:w-full max-md:border-e-0"
    >
      <SidebarContent className="overflow-x-hidden">
        <SidebarGroup>
          <div className="flex flex-col gap-2">
            <div className="flex h-8 items-center gap-2 rounded-md px-2 py-1.5 text-row font-medium text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground max-md:h-10 max-md:bg-sidebar-control-surface max-md:px-3 max-md:ring-1 max-md:ring-sidebar-border">
              <SearchIcon className="size-4 shrink-0 text-sidebar-muted-foreground/80" />
              {/* Native search inputs clear on Escape even during IME composition. */}
              <SidebarInput
                ref={searchInputRef}
                nativeInput
                type="text"
                value={query}
                onChange={(event) => {
                  setQuery(event.currentTarget.value);
                  setActiveResultIndex(0);
                }}
                onKeyDown={handleSearchKeyDown}
                placeholder={"搜索"}
                aria-label={"搜索设置"}
                role="combobox"
                aria-autocomplete="list"
                aria-expanded={isSearching && hasResults}
                aria-controls={isSearching && hasResults ? "settings-search-results" : undefined}
                aria-activedescendant={
                  isSearching && results[activeResultIndex]
                    ? `settings-search-result-${results[activeResultIndex].id}`
                    : undefined
                }
                className="min-w-0 flex-1"
              />
              {isSearching ? (
                <Button
                  type="button"
                  size="icon-micro"
                  variant="ghost-muted"
                  className="shrink-0"
                  aria-label={"清除设置搜索"}
                  onClick={() => {
                    clearSearch();
                    searchInputRef.current?.focus();
                  }}
                >
                  <XIcon className="size-3" />
                </Button>
              ) : (
                <span className="max-md:hidden pointer-coarse:hidden">
                  <Kbd>/</Kbd>
                </span>
              )}
            </div>
            {isSearching && results.length === 0 ? (
              <p
                role="status"
                className="px-2 py-6 text-center text-ui text-sidebar-muted-foreground"
              >
                未找到设置
              </p>
            ) : null}
            {isSearching ? (
              <SidebarMenu
                id={hasResults ? "settings-search-results" : undefined}
                role={hasResults ? "listbox" : undefined}
                aria-label={hasResults ? "设置搜索结果" : undefined}
              >
                {results.map((item, index) => (
                  <SidebarMenuItem
                    key={item.id}
                    role="presentation"
                    ref={index === activeResultIndex ? scrollResultIntoView : undefined}
                  >
                    <SidebarMenuButton
                      id={`settings-search-result-${item.id}`}
                      role="option"
                      aria-selected={index === activeResultIndex}
                      tabIndex={-1}
                      size="sm"
                      isActive={index === activeResultIndex}
                      className="h-auto min-h-10 items-start"
                      onMouseMove={() => setActiveResultIndex(index)}
                      onClick={() => handleSearchResultClick(item)}
                    >
                      <SettingsSectionIcon to={item.to} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-row font-medium text-sidebar-foreground">
                          {item.title}
                        </span>
                        <span className="block truncate text-meta text-sidebar-muted-foreground">
                          {SETTINGS_SECTION_LABELS[item.to]}
                        </span>
                      </span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            ) : (
              <div onKeyDown={handleSettingsSectionKeyDown} className="flex flex-col gap-1">
                {SETTINGS_NAV_GROUPS.map((group, index) => (
                  <div
                    key={group.heading}
                    className={cn("flex flex-col gap-1", !group.headingHidden && "mt-3 first:mt-0")}
                  >
                    <h3
                      id={`settings-nav-group-${index}`}
                      className={cn(
                        "px-2 text-meta font-semibold text-sidebar-muted-foreground",
                        group.headingHidden && "sr-only",
                      )}
                    >
                      {group.heading}
                    </h3>
                    {/* The heading stays outside the group it names so NVDA does not read the name twice. */}
                    <div role="group" aria-labelledby={`settings-nav-group-${index}`}>
                      <SidebarMenu>
                        {group.paths.map((to) => {
                          const Icon = SETTINGS_SECTION_ICONS[to];
                          const isActive = activePath === to || activePath.startsWith(`${to}/`);
                          return (
                            <SidebarMenuItem key={to}>
                              <SidebarMenuButton
                                data-settings-section={to}
                                aria-current={isActive ? "page" : undefined}
                                isActive={isActive}
                                onClick={() => handleSectionClick(to)}
                              >
                                <Icon />
                                <span className="min-w-0 flex-1 truncate">
                                  {SETTINGS_SECTION_LABELS[to]}
                                </span>
                                <ChevronRightIcon
                                  aria-hidden="true"
                                  className="ms-auto opacity-50 md:hidden"
                                />
                              </SidebarMenuButton>
                            </SidebarMenuItem>
                          );
                        })}
                      </SidebarMenu>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="max-md:hidden">
        <Suspense fallback={null}>
          <T3ConnectSidebarSignIn />
        </Suspense>
        <Suspense fallback={null}>
          <T3ConnectSidebarAvatar />
        </Suspense>
      </SidebarFooter>
    </nav>
  );
}

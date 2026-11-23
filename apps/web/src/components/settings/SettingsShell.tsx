import { useLocation, useNavigate, useRouter } from "@tanstack/react-router";
import { ChevronLeftIcon } from "lucide-react";
import { useEffect, type ReactNode } from "react";

import { useMediaQuery } from "../../hooks/useMediaQuery";
import { cn } from "../../lib/utils";
import { workspaceAreaProps } from "../../lib/workspaceFocus";
import { Button } from "../ui/button";
import { SettingsBreadcrumb } from "./SettingsBreadcrumb";
import { isSettingsIndexPath } from "./settingsPath.logic";
import { SettingsSidebarNav } from "./SettingsSidebarNav";

export function SettingsShell({
  pathname,
  headerActions,
  closeButton,
  children,
}: {
  readonly pathname: string;
  readonly headerActions?: ReactNode;
  readonly closeButton?: ReactNode;
  readonly children: ReactNode;
}) {
  const contentArea = workspaceAreaProps("settings", 1, "设置内容");
  const isIndex = isSettingsIndexPath(pathname);
  const isMobile = useMediaQuery("max-md");
  const navigate = useNavigate();
  const router = useRouter();
  const fromSettingsIndex = useLocation({
    select: (location) => location.state.fromSettingsIndex === true,
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- desktop has no settings index view, so widening from mobile redirects to the default section
  useEffect(() => {
    if (!isMobile && isIndex) {
      void navigate({ to: "/settings/general", replace: true });
    }
  }, [isMobile, isIndex, navigate]);

  const handleBackToList = () => {
    if (fromSettingsIndex) {
      router.history.back();
      return;
    }
    void navigate({ to: "/settings", hash: "" });
  };

  return (
    <div className="relative flex min-h-0 flex-1">
      <div
        data-settings-nav-pane
        className={cn(
          "flex min-h-0 flex-col md:w-52 md:shrink-0",
          isIndex ? "max-md:min-w-0 max-md:flex-1" : "max-md:hidden",
        )}
      >
        {isIndex ? (
          <header className="flex h-12 shrink-0 items-center gap-3 border-b bg-sidebar ps-4 pe-2 md:hidden">
            <SettingsBreadcrumb pathname={pathname} />
            {closeButton ? (
              <div className="ms-auto flex shrink-0 items-center gap-1">{closeButton}</div>
            ) : null}
          </header>
        ) : null}
        <div className="flex min-h-0 flex-1">
          <SettingsSidebarNav pathname={pathname} />
        </div>
      </div>
      <div
        {...contentArea}
        data-settings-content-pane
        className={cn("flex min-h-0 min-w-0 flex-1 flex-col", isIndex && "max-md:hidden")}
      >
        <header className="flex h-12 shrink-0 items-center gap-3 border-b ps-4 pe-2 sm:ps-5 max-md:gap-2 max-md:ps-2">
          <div className="flex shrink-0 items-center md:hidden">
            <Button size="sm" variant="ghost" aria-label="返回设置分类" onClick={handleBackToList}>
              <ChevronLeftIcon />
              <span>返回</span>
            </Button>
          </div>
          <SettingsBreadcrumb pathname={pathname} />
          <div className="ms-auto flex shrink-0 items-center gap-1">
            {headerActions}
            {closeButton}
          </div>
        </header>
        {children}
      </div>
    </div>
  );
}

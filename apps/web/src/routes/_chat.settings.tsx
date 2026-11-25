import { Outlet, createFileRoute, redirect, useLocation } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { RotateCcwIcon } from "lucide-react";
import { Button } from "../components/ui/button";
import { useSettingsRestore } from "../components/settings/SettingsPanels";

import { AppRouteModal, AppRouteModalClose } from "../components/AppRouteModal";
import { SettingsShell } from "../components/settings/SettingsShell";
import {
  SettingsScopeProvider,
  useSettingsScope,
} from "../components/settings/SettingsScopeContext";
import { useEnvironments } from "../state/environments";
import { SettingsScopeNotice } from "../components/settings/SettingsScopeNotice";
import { SETTINGS_DEVICE_ONLY_PATHS } from "../components/settings/SettingsScopeSentence";
import {
  SettingsDisconnectedHold,
  SettingsPageContainer,
} from "../components/settings/settingsLayout";
import {
  retainSettingsScope,
  validateSettingsRouteSearch,
} from "../components/settings/settingsScopeNavigation";
import { SettingsPathMissingView } from "../components/settings/SettingsPathMissingView";
import {
  isSettingsIndexPath,
  resolveSettingsPath,
} from "../components/settings/settingsPath.logic";
import {
  getSettingsSearchTargetScope,
  getThreadAutoSettlementSearchAvailability,
  isSettingsSearchScopeAvailable,
} from "../components/settings/settingsSearch";

function RestoreDeviceDefaultsButton({ onRestored }: { onRestored: () => void }) {
  const { changedSettingLabels, restoreDefaults } = useSettingsRestore(onRestored);
  return (
    <Button
      size="xs"
      variant="ghost"
      disabled={changedSettingLabels.length === 0}
      onClick={() => void restoreDefaults()}
    >
      <RotateCcwIcon className="mx-1 size-3.5" />
      <span className="max-sm:sr-only">恢复设备默认设置</span>
    </Button>
  );
}

function SettingsScopeBoundary({ pathname, children }: { pathname: string; children: ReactNode }) {
  const { scope, connectedEnvironments } = useSettingsScope();
  const { environments } = useEnvironments();
  const hash = useLocation({ select: (location) => location.hash });
  if (resolveSettingsPath(pathname, hash).kind === "missing") return children;
  const searchTarget = getSettingsSearchTargetScope(hash);
  const autoSettlementAvailability = searchTarget?.requiresThreadAutoSettlement
    ? getThreadAutoSettlementSearchAvailability(environments, scope)
    : null;
  if (
    scope.kind !== "unavailable" &&
    searchTarget &&
    autoSettlementAvailability &&
    !autoSettlementAvailability.isTargetAvailable
  ) {
    return (
      <SettingsScopeNotice
        target="environment"
        targetId={hash}
        eligibleEnvironmentIds={autoSettlementAvailability.eligibleEnvironmentIds}
      >
        {autoSettlementAvailability.eligibleEnvironmentIds.length > 0
          ? `${searchTarget.title}需要支持此功能的电脑。请选择一台电脑以继续。`
          : `${searchTarget.title}需要支持此功能的电脑。请连接或更新电脑以继续。`}
      </SettingsScopeNotice>
    );
  }
  if (
    scope.kind !== "unavailable" &&
    searchTarget &&
    !isSettingsSearchScopeAvailable(searchTarget.scope, scope.kind)
  ) {
    const target =
      searchTarget.scope === "environment" ||
      searchTarget.scope === "project" ||
      searchTarget.scope === "checkout"
        ? searchTarget.scope
        : "all";
    return (
      <SettingsScopeNotice target={target} targetId={hash}>
        {`${searchTarget.title}不适用于所选目标。请选择它所属的范围以继续。`}
      </SettingsScopeNotice>
    );
  }
  if (
    SETTINGS_DEVICE_ONLY_PATHS.has(pathname) ||
    // Device panels share these pages with environment panels, which show their own
    // connect notice through SettingsEnvironmentScopeGate.
    pathname === "/settings/general" ||
    pathname === "/settings/threads" ||
    pathname === "/settings/projects" ||
    pathname === "/settings/maintenance"
  ) {
    return children;
  }
  if (scope.kind === "unavailable")
    return (
      <SettingsPageContainer>
        <p className="text-sm text-muted-foreground">{scope.message}</p>
      </SettingsPageContainer>
    );
  const disconnected = scope.kind === "environment" && connectedEnvironments.length === 0;
  return (
    <SettingsDisconnectedHold
      notice={
        disconnected ? (
          <SettingsPageContainer>
            <p className="text-sm text-muted-foreground">
              重新连接 {scope.label}，才能改它的设置。
            </p>
          </SettingsPageContainer>
        ) : null
      }
    >
      {children}
    </SettingsDisconnectedHold>
  );
}

function isMobileSettingsViewport(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches;
}

function SettingsContentLayout() {
  const location = useLocation();
  const isIndex = isSettingsIndexPath(location.pathname);
  const { search, environment } = useSettingsScope();
  const contentScopeKey =
    location.pathname === "/settings/diagnostics" || location.pathname === "/settings/providers"
      ? environment?.environmentId
      : JSON.stringify(search);
  const [restoreSignal, setRestoreSignal] = useState(0);

  return (
    <AppRouteModal label="设置">
      <SettingsShell
        pathname={location.pathname}
        headerActions={
          location.pathname === "/settings/general" ? (
            <RestoreDeviceDefaultsButton
              onRestored={() => setRestoreSignal((value) => value + 1)}
            />
          ) : null
        }
        closeButton={<AppRouteModalClose />}
      >
        <div key={`${contentScopeKey}:${restoreSignal}`} className="min-h-0 flex flex-1 flex-col">
          <SettingsScopeBoundary pathname={location.pathname}>
            {isIndex ? null : <Outlet />}
          </SettingsScopeBoundary>
        </div>
      </SettingsShell>
    </AppRouteModal>
  );
}

function SettingsRouteLayout() {
  const rawSearch = Route.useSearch();
  const navigate = Route.useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  return (
    <SettingsScopeProvider
      search={rawSearch}
      singleEnvironment={pathname === "/settings/providers"}
      deviceOnly={SETTINGS_DEVICE_ONLY_PATHS.has(pathname)}
      onChange={(next) => {
        // Send every axis so retain middleware recognizes "all" as an explicit target.
        void navigate({
          to: pathname,
          search: () => ({
            project: next.project,
            machine: next.machine,
            checkout: next.checkout,
          }),
          hash: "",
          resetScroll: false,
        });
      }}
    >
      <SettingsContentLayout />
    </SettingsScopeProvider>
  );
}

export const Route = createFileRoute("/_chat/settings")({
  validateSearch: validateSettingsRouteSearch,
  search: { middlewares: [retainSettingsScope] },
  beforeLoad: ({ location }) => {
    const decision = resolveSettingsPath(location.pathname, location.hash, {
      isMobile: isMobileSettingsViewport(),
    });
    if (decision.kind !== "redirect") return;
    throw redirect({
      to: decision.to,
      ...(decision.hash ? { hash: decision.hash } : {}),
      ...(decision.retainSearch ? { search: true } : {}),
      replace: true,
    });
  },
  notFoundComponent: SettingsPathMissingView,
  component: SettingsRouteLayout,
});

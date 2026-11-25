import { type ServerLifecycleWelcomePayload } from "@t3tools/contracts";
import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  Outlet,
  Link,
  createRootRoute,
  type ErrorComponentProps,
  useLocation,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { APP_DISPLAY_NAME, APP_VERSION } from "../branding";
import { AppSidebarLayout } from "../components/AppSidebarLayout";
import { CommandPalette } from "../components/CommandPalette";
import { CustomSnoozeDialogHost } from "../components/CustomSnoozeDialog";
import { UseInAnotherAppDialogHost } from "../components/mcp/UseInAnotherAppDialog";
import { AddProjectToMachineDialogHost } from "../components/AddProjectToMachineDialog";
import { ConfirmDialogHost } from "../components/ConfirmDialogHost";
import { DevReplayHost } from "../components/DevReplayHost";
import { FirstRunGate } from "../components/onboarding/FirstRunGate";
import { SshPasswordPromptDialog } from "../components/desktop/SshPasswordPromptDialog";
import { DesktopAppActivationCoordinator } from "../components/desktop/DesktopAppActivationCoordinator";
import { DesktopWebLinkCoordinator } from "../components/desktop/DesktopWebLinkCoordinator";
import { RunningThreadKeepAlive } from "../components/desktop/RunningThreadKeepAlive";
import { ReopenClosedViewShortcut } from "../components/ReopenClosedViewShortcut";
import { ShortcutCheatsheetDialog } from "../components/ShortcutCheatsheet";
import { ProjectCloneToastCoordinator } from "../components/ProjectCloneToastCoordinator";
import { ChatGptWelcomeCoordinator } from "../components/settings/ChatGptWelcomeCoordinator";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import { Button } from "../components/ui/button";
import { StandalonePage, StandalonePageHeader } from "../components/ui/standalone-page";
import { AnchoredToastProvider, ToastProvider } from "../components/ui/toast";
import { toastManager } from "../components/ui/toast";
import { isElectron } from "../env";
import { useClientSettings } from "../hooks/useSettings";
import {
  deriveLogicalProjectKeyFromSettings,
  derivePhysicalProjectKeyFromPath,
  selectProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";
import { useUiStateStore } from "../uiStateStore";
import { configureClientTracing } from "../observability/clientTracing";
import { resolveInitialServerAuthGateState } from "../environments/primary";
import { takePairingRecoveryNotice } from "../environments/primary";
import { isLocalEnvironmentDisabled } from "../localEnvironment";
import { useAtomValue } from "@effect/atom-react";
import { primaryServerConfigAtom, primaryServerWelcomeAtom } from "../state/server";
import { readProject } from "../state/entities";

import { isChunkLoadError } from "../lib/chunkReloadGuard";

export const Route = createRootRoute({
  beforeLoad: async () => {
    if (isLocalEnvironmentDisabled()) {
      return {
        authGateState: {
          status: "hosted-static",
        } as const,
      };
    }

    const authGateState = await resolveInitialServerAuthGateState();
    if (authGateState.status === "authenticated") {
      // Idempotent, so every navigation can ask for it.
      void configureClientTracing();
    }
    return {
      authGateState,
    };
  },
  component: RootRouteView,
  errorComponent: RootRouteErrorView,
  notFoundComponent: RootRouteNotFoundView,
  head: () => ({
    meta: [{ name: "title", content: APP_DISPLAY_NAME }],
  }),
});

function RootRouteNotFoundView() {
  return (
    <main className="flex min-h-0 min-w-0 flex-1 items-center justify-center p-6">
      <div className="flex max-w-sm flex-col items-center gap-4 text-center">
        <h1 className="text-dialog-title font-medium text-foreground">页面不存在</h1>
        <p className="text-sm text-muted-foreground">
          此链接不是 {APP_DISPLAY_NAME} 里的页面。返回首页以选择项目或开始会话。
        </p>
        <Button render={<Link to="/" replace />}>返回首页</Button>
      </div>
    </main>
  );
}

function RootRouteView() {
  // Above every branch: app services raise toasts for the whole page, so the surface they write to
  // must not unmount when the root switches branches (for example /welcome to the app shell).
  return (
    <ToastProvider>
      <AnchoredToastProvider>
        <RootRouteBranch />
      </AnchoredToastProvider>
    </ToastProvider>
  );
}

function RootRouteBranch() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const { authGateState } = Route.useRouteContext();
  const primaryEnvironmentAuthenticated = authGateState.status === "authenticated";
  // A sync IPC read; the setting only changes across a relaunch.
  const [localEnvironmentDisabled] = useState(isLocalEnvironmentDisabled);

  if (
    pathname === "/pair" ||
    pathname === "/connect" ||
    pathname === "/connect-agent" ||
    pathname === "/approve-agent"
  ) {
    return <Outlet />;
  }

  if (authGateState.status !== "authenticated" && authGateState.status !== "hosted-static") {
    return <Outlet />;
  }

  const appHosts = (
    <>
      {primaryEnvironmentAuthenticated ? <DesktopAppActivationCoordinator /> : null}
      <PairingRecoveryToast />
      {primaryEnvironmentAuthenticated || localEnvironmentDisabled ? (
        <DesktopWebLinkCoordinator />
      ) : null}
      {isElectron ? <RunningThreadKeepAlive /> : null}
      <SshPasswordPromptDialog />
      <ShortcutCheatsheetDialog />
      <ReopenClosedViewShortcut />
      <ConfirmDialogHost />
      <CustomSnoozeDialogHost />
      <ProjectCloneToastCoordinator />
      <AddProjectToMachineDialogHost />
      <UseInAnotherAppDialogHost />
      {import.meta.env.DEV && primaryEnvironmentAuthenticated ? <DevReplayHost /> : null}
    </>
  );
  const appShell = (
    <CommandPalette>
      <AppSidebarLayout showSidebar>
        <Outlet />
      </AppSidebarLayout>
    </CommandPalette>
  );

  return (
    <>
      <ChatGptWelcomeCoordinator />
      <FirstRunGate>
        {appHosts}
        {primaryEnvironmentAuthenticated ? <EventRouter /> : null}
        {appShell}
      </FirstRunGate>
      {/* Above the shell and the router, so drafts survive navigation. */}
    </>
  );
}

function PairingRecoveryToast() {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- drains the notice a failed pairing submit left for after the app reloads
  useEffect(() => {
    const notice = takePairingRecoveryNotice();
    if (notice) {
      toastManager.add({ type: "info", title: notice });
    }
  }, []);
  return null;
}

function RootRouteErrorView({ error }: ErrorComponentProps) {
  const router = useRouter();
  const message = errorMessage(error);
  // Router pathname rather than window.location: desktop uses hash history, where the window path is always "/".
  const pathname = useLocation({ select: (location) => location.pathname });
  const report = errorReport(error, pathname);

  return (
    <StandalonePage>
      <StandalonePageHeader title="出了点问题。" description={message} />

      <div className="mt-5 flex flex-wrap gap-2">
        <Button
          size="sm"
          onClick={() =>
            isChunkLoadError(error) ? window.location.reload() : void router.invalidate()
          }
        >
          重试
        </Button>
        <Button size="sm" variant="secondary" onClick={() => window.location.reload()}>
          重新加载应用
        </Button>
        <CopyErrorButton report={report} />
      </div>

      <div className="mt-5 overflow-hidden rounded-lg border border-border/70 bg-background/55">
        <p className="px-3 py-1.5 text-meta font-medium text-muted-foreground">错误报告</p>
        <pre className="max-h-64 overflow-auto border-t border-border/70 bg-background/80 px-3 py-2 text-xs whitespace-pre-wrap text-foreground/85">
          {report}
        </pre>
      </div>
    </StandalonePage>
  );
}

function CopyErrorButton({ report }: { report: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "error-report" });

  return (
    <Button size="sm" variant="secondary" onClick={() => copyToClipboard(report)}>
      {isCopied ? <CheckIcon className="text-success" /> : <CopyIcon />}
      {isCopied ? "已复制" : "复制错误信息"}
    </Button>
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }

  return "发生了未预期的路由错误。";
}

function errorDetails(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  try {
    return JSON.stringify(error, null, 2);
  } catch {
    return "没有更多错误详情。";
  }
}

const MAX_ERROR_CAUSE_DEPTH = 5;

// Use only pathname to keep query tokens off the clipboard.
function errorReport(error: unknown, pathname: string): string {
  const lines = [
    `${APP_DISPLAY_NAME} ${APP_VERSION}`,
    `路径：${pathname}`,
    `Time: ${new Date().toISOString()}`,
    "",
    errorDetails(error),
  ];
  let cause = error instanceof Error ? error.cause : undefined;
  for (let depth = 0; cause !== undefined && depth < MAX_ERROR_CAUSE_DEPTH; depth += 1) {
    lines.push("", "Caused by:", errorDetails(cause));
    cause = cause instanceof Error ? cause.cause : undefined;
  }
  return lines.join("\n");
}

function EventRouter() {
  const navigate = useNavigate();
  const pathname = useLocation({ select: (loc) => loc.pathname });
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const serverConfig = useAtomValue(primaryServerConfigAtom);
  const serverWelcome = useAtomValue(primaryServerWelcomeAtom);
  const readPathname = useEffectEvent(() => pathname);
  const handledBootstrapThreadIdRef = useRef<string | null>(null);

  const handleWelcome = useEffectEvent((payload: ServerLifecycleWelcomePayload | null) => {
    if (!payload) return;

    void (async () => {
      if (!payload.bootstrapProjectId || !payload.bootstrapThreadId) {
        return;
      }
      const bootstrapProject = readProject(
        scopeProjectRef(payload.environment.environmentId, payload.bootstrapProjectId),
      );
      const bootstrapProjectKey =
        (bootstrapProject
          ? deriveLogicalProjectKeyFromSettings(bootstrapProject, projectGroupingSettings)
          : null) ??
        (serverConfig?.cwd
          ? derivePhysicalProjectKeyFromPath(payload.environment.environmentId, serverConfig.cwd)
          : null) ??
        scopedProjectKey(
          scopeProjectRef(payload.environment.environmentId, payload.bootstrapProjectId),
        );
      useUiStateStore.getState().setProjectExpanded(bootstrapProjectKey, true);

      if (readPathname() !== "/") {
        return;
      }

      if (handledBootstrapThreadIdRef.current === payload.bootstrapThreadId) {
        return;
      }
      await navigate({
        to: "/$environmentId/$threadId",
        params: {
          environmentId: payload.environment.environmentId,
          threadId: payload.bootstrapThreadId,
        },
        replace: true,
      });
      handledBootstrapThreadIdRef.current = payload.bootstrapThreadId;
    })().catch(() => undefined);
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- expands the bootstrap project in the UI store and navigates the router on a server welcome
  useEffect(() => {
    handleWelcome(serverWelcome);
  }, [serverWelcome]);

  return null;
}

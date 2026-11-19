import { RefreshIcon } from "~/components/ui/refresh-icon";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { useEffect, useState } from "react";

import {
  ensureClientSettingsHydrated,
  useClientSettings,
  useClientSettingsHydrationStatus,
} from "../../hooks/useSettings";
import { completeOnboarding } from "../../onboarding/firstRun";
import {
  resolveFirstRunDecision,
  resolveHostedFirstRunDecision,
  transitionFirstRunGateState,
  type FirstRunGateState,
} from "../../onboarding/firstRun.logic";
import { useAllEnvironmentShellsBootstrapped } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { environmentProjects } from "../../state/projects";
import { primaryServerConfigAtom } from "../../state/server";
import { environmentShell } from "../../state/shell";
import { environmentThreadShells } from "../../state/threads";
import { Button } from "../ui/button";

const primaryShellLiveAtom = Atom.make((get) => {
  const serverConfig = get(primaryServerConfigAtom);
  return (
    serverConfig !== null &&
    get(environmentShell.stateValueAtom(serverConfig.environment.environmentId)).status === "live"
  );
}).pipe(Atom.withLabel("web-onboarding-primary-shell-live"));

const workspaceEvidenceLiveAtom = Atom.make((get) => {
  const environmentIds = new Set([
    ...get(environmentProjects.projectsAtom).map((project) => project.environmentId),
    ...get(environmentThreadShells.threadShellsAtom).map((thread) => thread.environmentId),
  ]);

  for (const environmentId of environmentIds) {
    if (get(environmentShell.stateValueAtom(environmentId)).status !== "live") {
      return false;
    }
  }

  return true;
}).pipe(Atom.withLabel("web-onboarding-workspace-evidence-live"));

export function FirstRunGate({
  enabled,
  hostedStatic,
  children,
}: {
  readonly enabled: boolean;
  readonly hostedStatic: boolean;
  readonly children: React.ReactNode;
}) {
  const hydrationStatus = useClientSettingsHydrationStatus();
  const hydrated = hydrationStatus === "ready";
  const onboardingCompletedAt = useClientSettings((settings) => settings.onboardingCompletedAt);
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const { isReady: environmentCatalogReady } = useEnvironments();
  const serverConfig = useAtomValue(primaryServerConfigAtom);
  const primaryShellLive = useAtomValue(primaryShellLiveAtom);
  const workspaceEvidenceLive = useAtomValue(workspaceEvidenceLiveAtom);
  const [gateState, setGateState] = useState<FirstRunGateState>(() => ({
    decision:
      (!enabled && !hostedStatic) || (hydrated && onboardingCompletedAt !== null)
        ? "app"
        : "pending",
    stalled: false,
  }));
  const { decision } = gateState;
  const settingsReadFailed = hydrationStatus === "failed" || hydrationStatus === "retrying";

  const { decision: nextDecision, persistCompletion } = hostedStatic
    ? resolveHostedFirstRunDecision(hydrated)
    : resolveFirstRunDecision({
        enabled,
        hydrated,
        completed: onboardingCompletedAt !== null,
        bootstrapped,
        authoritative: primaryShellLive,
        workspaceAuthoritative: workspaceEvidenceLive,
        catalogReady: environmentCatalogReady,
        serverConfigAvailable: serverConfig !== null,
      });

  if (hydrated) {
    const transitioned = transitionFirstRunGateState(gateState, {
      type: "evidence",
      decision: nextDecision,
    });
    if (transitioned !== gateState) setGateState(transitioned);
  }

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- persists onboarding completion to settings once the server has confirmed the workspace
  useEffect(() => {
    if (decision !== "app" || !hydrated) return;
    if (persistCompletion && onboardingCompletedAt === null) {
      void completeOnboarding().catch(() => undefined);
    }
  }, [decision, hydrated, onboardingCompletedAt, persistCompletion]);

  if (settingsReadFailed) {
    return <FirstRunRecovery retrying={hydrationStatus === "retrying"} />;
  }
  if (decision !== "app") return null;
  return children;
}

function FirstRunRecovery({ retrying = false }: { readonly retrying?: boolean }) {
  return (
    <main className="flex h-dvh min-h-0 items-center justify-center bg-background px-6 text-foreground">
      <div className="flex max-w-sm flex-col items-center text-center">
        <h1 className="text-lg font-semibold">无法读取设置</h1>
        <p className="mt-2 text-sm text-muted-foreground">无法加载你保存的设置。</p>
        <Button
          className="mt-5"
          size="sm"
          variant="outline"
          disabled={retrying}
          onClick={() => {
            void ensureClientSettingsHydrated().catch(() => undefined);
          }}
        >
          <RefreshIcon refreshing={retrying} />
          重试
        </Button>
      </div>
    </main>
  );
}

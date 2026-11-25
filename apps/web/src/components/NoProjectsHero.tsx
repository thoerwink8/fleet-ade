import { workspaceAreaProps } from "../lib/workspaceFocus";
import { MessageSquareDashedIcon, PlusIcon } from "lucide-react";

import { openCommandPalette } from "../commandPaletteBus";
import { isElectron } from "../env";
import { useScratchProject } from "../hooks/useScratchProject";
import {
  useEnvironment,
  useEnvironmentProviders,
  usePrimaryEnvironmentId,
} from "../state/environments";
import { Button } from "./ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "./ui/empty";
import { SidebarInset } from "./ui/sidebar";
import { WorkspacePageHeader } from "./WorkspacePageHeader";
import { AgentSetupCard } from "./agentSetup/AgentSetupCard";
import { resolveAgentSetupCard, toAgentSetupProvider } from "./agentSetup/agentSetupCard.logic";

export function NoProjectsHero() {
  const contentArea = workspaceAreaProps("home", 1, "Home");
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { scratchEnvironmentId, startScratchThread } = useScratchProject();
  const scratchTargetEnvironmentId = scratchEnvironmentId(primaryEnvironmentId);
  const primaryEnvironment = useEnvironment(primaryEnvironmentId);
  const providersByEnvironment = useEnvironmentProviders();
  const providerSnapshots =
    primaryEnvironmentId === null ? undefined : providersByEnvironment.get(primaryEnvironmentId);
  const agentSetupCard = resolveAgentSetupCard({
    providers: (providerSnapshots ?? []).map(toAgentSetupProvider),
    catalogKnown: providerSnapshots !== undefined,
    computerName:
      primaryEnvironment?.entry.target._tag === "PrimaryConnectionTarget"
        ? null
        : (primaryEnvironment?.label ?? null),
  });

  return (
    <SidebarInset
      {...contentArea}
      role="main"
      className="h-dvh min-h-0 overflow-hidden overscroll-y-none"
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        {/* The desktop window only moves where CSS opts in, so keep a titlebar strip. */}
        {isElectron ? <WorkspacePageHeader electron /> : null}
        <Empty size="hero" className="flex-1">
          <EmptyHeader className="max-w-lg">
            <EmptyTitle>我们来做些什么？</EmptyTitle>
            <EmptyDescription>
              {scratchTargetEnvironmentId === null
                ? "添加项目，开始你的第一个会话。"
                : "添加项目，或直接新建无项目会话。"}
            </EmptyDescription>
            <div className="mt-4 flex justify-center gap-2">
              <Button size="sm" onClick={() => openCommandPalette({ open: "add-project" })}>
                <PlusIcon className="size-4" />
                添加项目
              </Button>
              {scratchTargetEnvironmentId === null ? null : (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => void startScratchThread(scratchTargetEnvironmentId)}
                >
                  <MessageSquareDashedIcon className="size-4" />
                  新建无项目会话
                </Button>
              )}
            </div>
            {agentSetupCard && primaryEnvironmentId !== null ? (
              <div className="mt-6 flex w-full justify-center">
                <AgentSetupCard model={agentSetupCard} environmentId={primaryEnvironmentId} />
              </div>
            ) : null}
          </EmptyHeader>
        </Empty>
      </div>
    </SidebarInset>
  );
}

import { usePrimarySettings } from "../../hooks/useSettings";
import { AppRouteModal, AppRouteModalClose } from "../AppRouteModal";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { ScrollArea } from "../ui/scroll-area";
import { groupChannelCandidates } from "./ChannelsPage.logic";

function CandidateRow({ instanceId, model }: { instanceId: string; model: string }) {
  return (
    <li className="flex min-w-0 flex-wrap items-baseline gap-x-2 px-3.5 py-2.5 sm:px-4">
      <span className="min-w-0 text-sm leading-5 font-medium break-words text-foreground">
        {model}
      </span>
      <span className="min-w-0 font-mono text-xs break-words text-muted-foreground">
        {instanceId}
      </span>
    </li>
  );
}

export function ChannelsPage() {
  const groups = usePrimarySettings((settings) =>
    groupChannelCandidates({
      author: settings.pipelineAuthorModel,
      verifier: settings.pipelineVerifierModel,
    }),
  );

  return (
    <AppRouteModal label="渠道">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden">
        <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2">
          <h1 className="min-w-0 flex-1 truncate text-sm font-medium">渠道</h1>
          <AppRouteModalClose />
        </header>
        <ScrollArea className="min-h-0 min-w-0 flex-1">
          <WorkspacePageContainer>
            <div className="grid min-w-0 gap-8">
              {groups.map((group) => (
                <section key={group.stage} className="min-w-0 space-y-2.5">
                  <h2 className="text-sm font-medium text-muted-foreground">{group.stage}</h2>
                  <div className="overflow-hidden rounded-lg border">
                    <ol className="divide-y">
                      {group.candidates.map((candidate) => (
                        <CandidateRow
                          key={`${candidate.instanceId}:${candidate.model}`}
                          instanceId={candidate.instanceId}
                          model={candidate.model}
                        />
                      ))}
                    </ol>
                  </div>
                </section>
              ))}
            </div>
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </AppRouteModal>
  );
}

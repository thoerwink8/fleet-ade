import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { GitBranchIcon, SquarePenIcon, XIcon } from "lucide-react";
import {
  memo,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useShallow } from "zustand/react/shallow";

import { textDirection } from "~/textDirection";
import {
  composerDraftHasUserContent,
  DraftId,
  useComposerDraftStore,
  type ComposerThreadDraftState,
  type DraftSessionState,
} from "../../composerDraftStore";
import { discardComposerDraft } from "../../lib/discardComposerDraft";
import { ProjectFavicon, type ProjectFaviconProject } from "../ProjectFavicon";
import { Badge } from "../ui/badge";
import {
  selectVisibleDraftRows,
  resolveDraftRowPresentation,
  type DraftRowPresentation,
  type SidebarDraftRowData,
} from "./SidebarDraftBlock.logic";
import { SidebarRelativeTimeLabel, SidebarRowIconButton, SidebarRowShell } from "./SidebarRowShell";

function SidebarDraftDetails(props: {
  presentation: DraftRowPresentation;
  project: ProjectFaviconProject | null;
}) {
  const { presentation } = props;
  const metaParts = [
    presentation.statusLabel,
    presentation.attachmentSummary,
    presentation.contextSummary,
  ].filter(Boolean);
  return (
    <div data-testid="sidebar-draft-details">
      <div className="ade-thread-details__title">{presentation.title}</div>
      {presentation.detailBody !== null ? (
        <div
          className="fa-cap"
          data-testid="sidebar-draft-detail-body"
          dir={textDirection(presentation.detailBody)}
        >
          {presentation.detailBody}
        </div>
      ) : null}
      <div className="fa-cap" data-testid="sidebar-draft-status">
        {metaParts.join(" · ")}
      </div>
      {presentation.projectDisplayName ? (
        <div className="fa-cap" data-testid="sidebar-draft-project">
          {props.project ? (
            <ProjectFavicon
              project={props.project}
              className="mr-1 inline-flex size-3 shrink-0 align-text-bottom"
            />
          ) : null}
          {presentation.projectDisplayName}
        </div>
      ) : null}
      {presentation.branch ? (
        <div className="fa-cap" data-testid="sidebar-draft-branch">
          <GitBranchIcon className="mr-1 inline size-3" />
          {presentation.branch}
        </div>
      ) : null}
      {presentation.createdAt ? (
        <div className="fa-cap" data-testid="sidebar-draft-time">
          <SidebarRelativeTimeLabel timestamp={presentation.createdAt} />
        </div>
      ) : null}
    </div>
  );
}

const SidebarDraftRow = memo(function SidebarDraftRow(props: {
  draftId: DraftId;
  session: DraftSessionState;
  composer: ComposerThreadDraftState;
  project: ProjectFaviconProject | null;
  projectDisplayName: string | null;
  isActive: boolean;
  onNavigate: (draftId: DraftId) => void;
  onDiscard: (draftId: DraftId) => void;
  onContextMenu: (draftId: DraftId, position: { x: number; y: number }) => void;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const {
    composer,
    draftId,
    isActive,
    onContextMenu,
    onDiscard,
    onNavigate,
    projectDisplayName,
    session,
  } = props;
  const presentation = resolveDraftRowPresentation({
    composer,
    session,
    projectDisplayName,
    isActive,
  });
  const handleActivate = () => onNavigate(draftId);
  const handleKeyDown = (event: ReactKeyboardEvent) => {
    // Keys targeting the nested action buttons belong to those buttons:
    // preventDefault here would swallow Space's synthesized click and
    // navigate instead of activating the button.
    if ((event.target as HTMLElement).closest("button")) return;
    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      onContextMenu(draftId, { x: rect.left, y: rect.bottom });
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onNavigate(draftId);
    }
  };
  const handleContextMenu = (event: ReactMouseEvent) => {
    event.preventDefault();
    onContextMenu(draftId, { x: event.clientX, y: event.clientY });
  };
  const handleDiscard = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    onDiscard(draftId);
  };

  return (
    <SidebarRowShell
      rowKey={`draft:${draftId}`}
      testId="sidebar-draft-row"
      ariaLabel={presentation.accessibility.label}
      ariaCurrent={presentation.accessibility.current}
      selected={isActive}
      onClick={handleActivate}
      onContextMenu={handleContextMenu}
      onKeyDown={handleKeyDown}
      detailsOpen={detailsOpen}
      onDetailsOpenChange={setDetailsOpen}
      detailsLabel="草稿详情"
      details={<SidebarDraftDetails presentation={presentation} project={props.project} />}
      lead={<SquarePenIcon aria-hidden className="size-3.5 text-muted-foreground" />}
      body={
        <div className="t" dir={textDirection(presentation.title)} aria-hidden>
          {presentation.title}
        </div>
      }
      endPrefix={
        <Badge variant="secondary" aria-hidden>
          {presentation.badgeLabel}
        </Badge>
      }
      meta={
        presentation.createdAt ? (
          <SidebarRelativeTimeLabel timestamp={presentation.createdAt} />
        ) : null
      }
      actions={
        <SidebarRowIconButton label="丢弃草稿" tooltip="丢弃草稿" onClick={handleDiscard}>
          <XIcon className="size-4" />
        </SidebarRowIconButton>
      }
    />
  );
});

export const SidebarDraftBlock = memo(function SidebarDraftBlock(props: {
  projectByKey: ReadonlyMap<string, EnvironmentProject>;
  projectDisplayNameByKey: ReadonlyMap<string, string>;
  scopedProjectKeys: ReadonlySet<string> | null;
  routeDraftId: string | null;
  onNavigateToDraft: (draftId: DraftId) => void;
  onDraftContextMenu: (draftId: DraftId, position: { x: number; y: number }) => void;
}) {
  const draftThreadsByThreadKey = useComposerDraftStore((store) => store.draftThreadsByThreadKey);
  const draftsByThreadKey = useComposerDraftStore(
    useShallow((store) =>
      Object.fromEntries(
        Object.keys(store.draftThreadsByThreadKey).map(
          (key) => [key, store.draftsByThreadKey[key]] as const,
        ),
      ),
    ),
  );
  const [frozenActive, setFrozenActive] = useState<{
    routeDraftId: string | null;
    row: SidebarDraftRowData | null;
  }>({ routeDraftId: null, row: null });
  if (frozenActive.routeDraftId !== props.routeDraftId) {
    let row: SidebarDraftRowData | null = null;
    if (props.routeDraftId !== null) {
      const draftId = DraftId.make(props.routeDraftId);
      const session = draftThreadsByThreadKey[draftId];
      const composer = draftsByThreadKey[draftId];
      row =
        session && session.promotedTo == null && composer && composerDraftHasUserContent(composer)
          ? { draftId, session, composer }
          : null;
    }
    setFrozenActive({ routeDraftId: props.routeDraftId, row });
  }
  const drafts = selectVisibleDraftRows({
    draftThreadsByThreadKey,
    draftsByThreadKey,
    scopedProjectKeys: props.scopedProjectKeys,
    routeDraftId: props.routeDraftId,
    frozenActive,
  });
  if (drafts.length === 0) {
    return null;
  }
  return (
    <>
      {drafts.map(({ composer, draftId, session }) => {
        const projectKey = `${session.environmentId}:${session.projectId}`;
        return (
          <SidebarDraftRow
            key={draftId}
            draftId={draftId}
            session={session}
            composer={composer}
            project={props.projectByKey.get(projectKey) ?? null}
            projectDisplayName={props.projectDisplayNameByKey.get(projectKey) ?? null}
            isActive={draftId === props.routeDraftId}
            onNavigate={props.onNavigateToDraft}
            onDiscard={discardComposerDraft}
            onContextMenu={props.onDraftContextMenu}
          />
        );
      })}
      <li
        aria-hidden
        data-testid="sidebar-draft-divider"
        className="mx-2.5 my-1.5 h-px list-none bg-sidebar-border/60"
      />
    </>
  );
});

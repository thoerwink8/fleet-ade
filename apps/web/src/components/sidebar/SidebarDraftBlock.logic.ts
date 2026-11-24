import { assistantCitationsToPlainText } from "@t3tools/shared/assistantCitations";
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import {
  composerDraftHasUserContent,
  DraftId,
  type ComposerThreadDraftState,
  type DraftSessionState,
} from "../../composerDraftStore";
import { resolveSidebarRowAccessibility } from "../Sidebar.logic";

export interface SidebarDraftRowData {
  readonly draftId: DraftId;
  readonly session: DraftSessionState;
  readonly composer: ComposerThreadDraftState;
}

/** Counts unique pending attachments across hydrated and persisted image lists plus file/context chips. */
export function countDraftAttachments(composer: ComposerThreadDraftState): number {
  // images mirrors persistedAttachments once rehydration finishes; before
  // that only the persisted list is populated, hence max not sum.
  return (
    Math.max(composer.images.length, composer.persistedAttachments.length) +
    composer.files.length +
    composer.terminalContexts.length +
    composer.previewAnnotations.length +
    composer.reviewComments.length
  );
}

/** Counts referenced thread/environment/reply contexts attached to an unsent draft. */
export function countDraftContexts(composer: ComposerThreadDraftState): number {
  return (
    composer.threadContexts.length +
    composer.environmentContexts.length +
    (composer.replyTo !== null ? 1 : 0)
  );
}

export interface DraftRowPresentation {
  readonly title: string;
  readonly detailBody: string | null;
  readonly statusLabel: "未发送的草稿";
  readonly badgeLabel: "草稿";
  readonly attachmentSummary: string | null;
  readonly contextSummary: string | null;
  readonly projectDisplayName: string | null;
  readonly branch: string | null;
  readonly createdAt: string | null;
  readonly accessibility: {
    readonly label: string;
    readonly current: "page" | undefined;
  };
}

/**
 * Derives display fields and details-card metadata for a single-line sidebar draft row so that
 * no draft information is dropped when moving from the legacy card layout to `.fa-trow--1`.
 */
export function resolveDraftRowPresentation(input: {
  readonly composer: ComposerThreadDraftState;
  readonly session: Pick<DraftSessionState, "branch" | "createdAt">;
  readonly projectDisplayName: string | null;
  readonly isActive: boolean;
}): DraftRowPresentation {
  const expandedPrompt = assistantCitationsToPlainText(
    replaceComposerContextReferences(input.composer.prompt, (occurrence) => occurrence.label),
  ).trim();
  const nonEmptyLines = expandedPrompt
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const firstLine = nonEmptyLines[0] ?? "";
  const attachmentCount = countDraftAttachments(input.composer);
  const contextCount = countDraftContexts(input.composer);
  const attachmentCountLabel = attachmentCount > 0 ? `${attachmentCount} 个附件` : null;
  const contextCountLabel = contextCount > 0 ? `${contextCount} 条引用上下文` : null;

  const title =
    firstLine.length > 0
      ? firstLine
      : (attachmentCountLabel ?? contextCountLabel ?? "未发送的草稿");
  const detailBody =
    expandedPrompt.length > 0 && (nonEmptyLines.length > 1 || firstLine.length > 24)
      ? expandedPrompt
      : null;
  const attachmentSummary = firstLine.length > 0 ? attachmentCountLabel : null;
  const contextSummary = firstLine.length > 0 || attachmentCount > 0 ? contextCountLabel : null;
  const branch = input.session.branch?.trim() ? input.session.branch.trim() : null;
  const createdAt = input.session.createdAt.trim().length > 0 ? input.session.createdAt : null;
  const statusLabel = "未发送的草稿" as const;
  const accessibility = resolveSidebarRowAccessibility({
    title,
    statusLabel,
    projectDisplayName: input.projectDisplayName,
    isActive: input.isActive,
  });

  return {
    title,
    detailBody,
    statusLabel,
    badgeLabel: "草稿",
    attachmentSummary,
    contextSummary,
    projectDisplayName: input.projectDisplayName,
    branch,
    createdAt,
    accessibility,
  };
}

/**
 * Filters and sorts visible unsent draft sessions newest-first without deduplicating drafts that
 * share a project or title. Keeps the active draft frozen if its route is still mounted.
 */
export function selectVisibleDraftRows(input: {
  readonly draftThreadsByThreadKey: Readonly<Record<string, DraftSessionState>>;
  readonly draftsByThreadKey: Readonly<Record<string, ComposerThreadDraftState | undefined>>;
  readonly scopedProjectKeys: ReadonlySet<string> | null;
  readonly routeDraftId: string | null;
  readonly frozenActive: {
    readonly routeDraftId: string | null;
    readonly row: SidebarDraftRowData | null;
  };
}): SidebarDraftRowData[] {
  const rows: SidebarDraftRowData[] = [];
  for (const [draftKey, session] of Object.entries(input.draftThreadsByThreadKey)) {
    if (session.promotedTo != null) {
      continue;
    }
    if (
      input.scopedProjectKeys !== null &&
      !input.scopedProjectKeys.has(`${session.environmentId}:${session.projectId}`)
    ) {
      continue;
    }
    if (draftKey === input.routeDraftId) {
      if (input.frozenActive.routeDraftId === draftKey && input.frozenActive.row !== null) {
        rows.push(input.frozenActive.row);
      }
      continue;
    }
    const composer = input.draftsByThreadKey[draftKey];
    if (!composer || !composerDraftHasUserContent(composer)) {
      continue;
    }
    rows.push({ draftId: DraftId.make(draftKey), session, composer });
  }
  rows.sort((left, right) => right.session.createdAt.localeCompare(left.session.createdAt));
  return rows;
}

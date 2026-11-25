import { RefreshIcon } from "~/components/ui/refresh-icon";
import { useAtomValue } from "@effect/atom-react";
import type { FileDiffContentsLoader, FileDiffMetadata } from "@pierre/diffs";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { safeErrorLogAttributes } from "@t3tools/client-runtime/errors";
import {
  CHECKPOINT_DIFF_TRUNCATED_MARKER,
  type ReviewBranchCommitsResult,
  type ScopedThreadRef,
  type RunId,
} from "@t3tools/contracts";
import {
  ArrowRightIcon,
  CheckIcon,
  ChevronDownIcon,
  Columns2Icon,
  FlaskConicalOffIcon,
  FolderTreeIcon,
  PilcrowIcon,
  Rows3Icon,
  TextWrapIcon,
  ChevronRightIcon,
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
} from "lucide-react";
import * as Schema from "effect/Schema";
import { type MouseEvent, useEffect, useRef, useState } from "react";
import { useCodeViewFileReveal } from "./diffs/useCodeViewFileReveal";
import { useCodeViewScrollRestore } from "./diffs/useCodeViewScrollRestore";
import { useFilesystemReadAccess } from "~/state/filesystem";
import { useOpenInPreferredEditor } from "../editorPreferences";
import { useFileContextMenuHandler } from "../fileContextMenu";
import { type DraftId } from "../composerDraftStore";
import { openDiffFilePrimaryAction } from "../diffFileActions";
import { toolCallDiff } from "../lib/toolCallDiff";
import { useCheckpointDiff, useTurnItemDetail } from "~/state/queries";
import { revisionedQuery } from "~/state/revisionedQuery";
import { cn } from "~/lib/utils";
import { presentVersionControlError } from "./versionControlError.logic";
import {
  resolveToolCallDiffTarget,
  selectThreadBranchBaseRef,
  selectThreadDiffPanelSelection,
  useDiffPanelSessionStore,
  useDiffPanelStore,
} from "../diffPanelStore";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { isTestChangedFile } from "@t3tools/shared/changedFileKind";
import { useHideTestFiles } from "./diffs/useHideTestFiles";
import { useRenderedAppearance } from "../hooks/useTheme";
import { useStableCallback } from "../hooks/useStableCallback";
import {
  buildFileDiffContentVersion,
  buildFileDiffIdentityKey,
  getDiffLineStat,
  getRenderablePatch,
  resolveDiffThemeName,
  resolveFileDiffPath,
} from "../lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "../lib/syntaxHighlighting";
import { areAllDiffFilesCollapsed, toggleAllDiffFiles } from "../lib/diffCollapse";
import { LIVE_REFRESH_MIN_INTERVAL_MS, useLiveRefresh } from "../hooks/useLiveRefresh";
import {
  useProject,
  useThreadCheckpointSummaries,
  useQuietThreadShell,
  useQuietThreadVisibleTurnItems,
} from "../state/entities";
import { useClientSettings, updateClientSettings } from "../hooks/useSettings";
import { formatRelativeTimeLabel, formatShortTimestamp } from "../timestampFormat";
import { DiffFilePathCopyButton } from "./DiffFilePathCopyButton";
import { DiffPanelLoadingState, DiffPanelShell, type DiffPanelMode } from "./DiffPanelShell";
import { DiffStatLabel } from "./chat/DiffStatLabel";
import { AnnotatableCodeView, type AnnotatableCodeViewHandle } from "./diffs/AnnotatableCodeView";
import { DiffFileTree } from "./diffs/DiffFileTree";
import { FileExplorerPane } from "./files/FileExplorerPane";
import { diffFileTreeEntries } from "./diffs/diffFileTree.logic";
import { Button } from "./ui/button";
import { ToggleGroup, Toggle } from "./ui/toggle-group";
import { Switch } from "./ui/switch";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxSearchInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxTrigger,
} from "./ui/combobox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "./ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";
import { serverEnvironment } from "../state/server";
import { reviewEnvironment } from "../state/review";
import { vcsEnvironment } from "../state/vcs";
import { buildBaseRefChoices, filterBaseRefChoices } from "../lib/baseRefChoices";
import { createGitDiffFileContentsLoader } from "../lib/diffFileContents";

import { observeIntersection } from "~/lib/observeIntersection";
import { useReviewFilePatches } from "./diffs/useReviewFilePatches";
import { DiffFileLoadingBoundary } from "./diffs/DiffFileLoadingBoundary";
import { DiffFileStatus } from "./diffs/DiffFileStatus";
import { useThreadRouteRef } from "../hooks/useThreadRouteTarget";
import { projectCommitUrl } from "@t3tools/client-runtime/change-request-links";
import { useOpenLink } from "../lib/useOpenLink";

type DiffThemeType = "light" | "dark";
const AUTOMATIC_BASE_REF = "__automatic_base_ref__";
const DIFF_FILE_TREE_STORAGE_KEY = "t3code.diffFileTreeOpen";
const fileEntryCache = new WeakMap<
  FileDiffMetadata,
  { fileDiff: FileDiffMetadata; fileKey: string; fileVersion: number }
>();

function getCachedFileEntry(fileDiff: FileDiffMetadata) {
  const cached = fileEntryCache.get(fileDiff);
  if (cached) return cached;
  const entry = {
    fileDiff,
    fileKey: buildFileDiffIdentityKey(fileDiff),
    fileVersion: buildFileDiffContentVersion(fileDiff),
  };
  fileEntryCache.set(fileDiff, entry);
  return entry;
}

const EMPTY_COLLAPSED_DIFF_FILE_KEYS: ReadonlySet<string> = new Set();

function DiffFileCollapseToggle({
  filePath,
  fileKey,
  collapsed,
  onToggle,
  load,
}: {
  filePath: string;
  fileKey: string;
  collapsed: boolean;
  load?: () => void;
  onToggle: (fileKey: string) => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="xs"
            icon
            variant="ghost"
            className="-ms-0.5"
            aria-label={collapsed ? `展开 ${filePath}` : `收起 ${filePath}`}
            aria-expanded={!collapsed}
            ref={(node) => {
              if (!node || !load) return;
              return observeIntersection(
                node,
                (entry) => {
                  if (entry.isIntersecting) load();
                },
                { rootMargin: "600px" },
              );
            }}
            onClick={(event) => {
              event.stopPropagation();
              onToggle(fileKey);
            }}
          />
        }
      >
        {collapsed ? (
          <ChevronRightIcon className="size-4 text-muted-foreground/80" />
        ) : (
          <ChevronDownIcon className="size-4 text-muted-foreground/80" />
        )}
      </TooltipTrigger>
      <TooltipPopup side="top">{collapsed ? "展开差异" : "折叠差异"}</TooltipPopup>
    </Tooltip>
  );
}

function DiffFileHeaderSuffix({
  filePath,
  hasStat,
  error,
  truncated,
  onRetry,
}: {
  filePath: string;
  hasStat: boolean;
  error: boolean;
  truncated: boolean;
  onRetry: (path: string) => void;
}) {
  return (
    <>
      <span data-diff-copy-path className="inline-flex">
        <DiffFilePathCopyButton filePath={filePath} />
      </span>
      {hasStat ? (
        <DiffFileStatus error={error} truncated={truncated} retry={() => onRetry(filePath)} />
      ) : null}
    </>
  );
}

interface DiffPanelProps {
  mode?: DiffPanelMode;
  composerDraftTarget: ScopedThreadRef | DraftId;
  workspaceMutationId: string | null;
  visible: boolean;
}

export default function DiffPanel({
  mode = "inline",
  composerDraftTarget,
  workspaceMutationId,
  visible,
}: DiffPanelProps) {
  const resolvedTheme = useRenderedAppearance();
  const settings = useClientSettings((settings) => ({
    diffFilesCollapsed: settings.diffFilesCollapsed,
    diffIgnoreWhitespace: settings.diffIgnoreWhitespace,
    diffLayout: settings.diffLayout,
    timestampFormat: settings.timestampFormat,
    wordWrap: settings.wordWrap,
  }));
  const diffLayout = settings.diffLayout;
  const [wordWrapOverride, setWordWrapOverride] = useState<boolean | null>(null);
  const wordWrap = wordWrapOverride ?? settings.wordWrap;
  const diffIgnoreWhitespace =
    useDiffPanelSessionStore((state) => state.ignoreWhitespace) ?? settings.diffIgnoreWhitespace;
  const [fileTreeOpen, setFileTreeOpen] = useLocalStorage(
    DIFF_FILE_TREE_STORAGE_KEY,
    false,
    Schema.Boolean,
  );
  const [hideTestFiles, setHideTestFiles] = useHideTestFiles();
  const [baseRefQuery, setBaseRefQuery] = useState("");
  // The open commit menu keeps the list it opened with, so rows do not move under the pointer.
  const [openCommitMenu, setOpenCommitMenu] = useState<ReviewBranchCommitsResult | null>(null);
  const [codeViewRevision, setCodeViewRevision] = useState(0);

  const routeThreadRef = useThreadRouteRef();
  const activeThreadId = routeThreadRef?.threadId ?? null;
  const activeThread = useQuietThreadShell(routeThreadRef);
  const fileAccess = useFilesystemReadAccess(activeThread?.environmentId ?? null);
  const { canReadFiles } = fileAccess;
  const activeProjectId = activeThread?.projectId ?? null;
  const activeProject = useProject(
    activeThread && activeProjectId
      ? {
          environmentId: activeThread.environmentId,
          projectId: activeProjectId,
        }
      : null,
  );
  const activeCwd = activeThread?.worktreePath ?? activeProject?.workspaceRoot;
  const activeRepositoryRoot = activeThread?.worktreePath
    ? undefined
    : activeProject?.repositoryIdentity?.rootPath;
  const serverConfig = useAtomValue(
    serverEnvironment.configValueAtom(activeThread?.environmentId ?? null),
  );
  const onFileContextMenu = useFileContextMenuHandler(activeThread?.environmentId ?? null);
  const openInPreferredEditor = useOpenInPreferredEditor(
    activeThread?.environmentId ?? null,
    serverConfig?.availableEditors ?? [],
  );
  const getDiffFileContents = useAtomCommand(reviewEnvironment.diffFileContents);
  const gitStatusQuery = useEnvironmentQuery(
    activeThread !== null && activeThread !== undefined && activeCwd != null
      ? vcsEnvironment.status({
          environmentId: activeThread.environmentId,
          input: { cwd: activeCwd },
        })
      : null,
  );
  const diffSelection = useDiffPanelStore((state) =>
    selectThreadDiffPanelSelection(state.byThreadKey, routeThreadRef),
  );
  const rememberedBaseRef = useDiffPanelStore((state) =>
    selectThreadBranchBaseRef(state, routeThreadRef),
  );
  const toolCallSelection = diffSelection.kind === "tool-call" ? diffSelection : null;
  const isGitSelection =
    diffSelection.kind === "branch" ||
    diffSelection.kind === "unstaged" ||
    diffSelection.kind === "commit";
  const toolCallItems = useQuietThreadVisibleTurnItems(toolCallSelection ? routeThreadRef : null);
  const toolCallDetail = useTurnItemDetail(
    toolCallSelection && routeThreadRef
      ? {
          ...resolveToolCallDiffTarget(toolCallSelection, toolCallItems),
          environmentId: routeThreadRef.environmentId,
        }
      : null,
  );
  const toolCallItem = toolCallDetail.data?.item;
  const isGitRepo = gitStatusQuery.data?.isRepo ?? true;
  const turnDiffSummaries = useThreadCheckpointSummaries(routeThreadRef);
  const orderedTurnDiffSummaries = turnDiffSummaries.toSorted((left, right) => {
    if (left.checkpointTurnCount !== right.checkpointTurnCount) {
      return right.checkpointTurnCount - left.checkpointTurnCount;
    }
    return right.completedAt.localeCompare(left.completedAt);
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- rewrites the persisted diff store selection to the latest turn when the selected turn disappears
  useEffect(() => {
    if (!routeThreadRef || diffSelection.kind !== "turn") return;
    useDiffPanelStore.getState().reconcileTurnSelection(
      routeThreadRef,
      orderedTurnDiffSummaries.map((summary) => summary.runId),
    );
  }, [diffSelection, orderedTurnDiffSummaries, routeThreadRef]);

  const selectedRunId = diffSelection.kind === "turn" ? diffSelection.turnId : null;
  const selectedGitScope =
    diffSelection.kind === "unstaged" || diffSelection.kind === "commit"
      ? diffSelection.kind
      : "branch";
  const selectedCommitSha = diffSelection.kind === "commit" ? diffSelection.sha : null;
  const selectedBaseRef =
    diffSelection.kind === "branch" || diffSelection.kind === "commit"
      ? diffSelection.baseRef
      : null;
  const selectedFilePath = diffSelection.kind === "turn" ? diffSelection.filePath : null;
  const selectedFileRevealRequestId =
    diffSelection.kind === "turn" ? diffSelection.revealRequestId : 0;
  const selectedTurn =
    selectedRunId === null
      ? undefined
      : (orderedTurnDiffSummaries.find((summary) => summary.runId === selectedRunId) ??
        orderedTurnDiffSummaries[0]);
  const selectedCheckpointTurnCount = selectedTurn?.checkpointTurnCount;
  const latestTurn = orderedTurnDiffSummaries[0];
  const reviewSectionId = toolCallSelection
    ? `tool-call:${toolCallSelection.threadId}:${toolCallSelection.itemId}`
    : selectedTurn
      ? `turn:${selectedTurn.runId}`
      : selectedCommitSha !== null
        ? `commit:${selectedCommitSha}`
        : selectedGitScope;
  const collapseScopeKey = routeThreadRef
    ? `${routeThreadRef.environmentId}:${routeThreadRef.threadId}:${reviewSectionId}`
    : null;
  const codeViewMountKey = `${collapseScopeKey ?? reviewSectionId}:${codeViewRevision}`;
  const selectedCheckpointRange =
    typeof selectedCheckpointTurnCount === "number"
      ? {
          fromTurnCount: Math.max(0, selectedCheckpointTurnCount - 1),
          toTurnCount: selectedCheckpointTurnCount,
        }
      : null;
  const activeCheckpointDiff = useCheckpointDiff(
    {
      environmentId: activeThread?.environmentId ?? null,
      threadId: activeThreadId,
      fromTurnCount: selectedCheckpointRange?.fromTurnCount ?? null,
      toTurnCount: selectedCheckpointRange?.toTurnCount ?? null,
      ignoreWhitespace: diffIgnoreWhitespace,
      cacheScope: selectedTurn ? `turn:${selectedTurn.runId}` : null,
    },
    { enabled: isGitRepo && selectedTurn !== undefined },
  );
  const branchDiffPreviewInput =
    canReadFiles && isGitSelection && activeThread && activeCwd
      ? {
          cwd: activeCwd,
          ...(selectedBaseRef ? { baseRef: selectedBaseRef } : {}),
          ...(selectedCommitSha !== null ? { commitSha: selectedCommitSha } : {}),
          ignoreWhitespace: diffIgnoreWhitespace,
          metadataOnly: true,
          ...(selectedCommitSha === null
            ? {
                sourceKind:
                  selectedGitScope === "unstaged"
                    ? ("working-tree" as const)
                    : ("branch-range" as const),
              }
            : {}),
        }
      : undefined;
  const canRefreshGitDiff =
    isGitRepo && isGitSelection && activeThread != null && activeCwd != null;
  // Read under the workspace mutation id, so each mutation refetches the diff; the panel stays
  // mounted while hidden, so a mutation made then is already reflected when it shows.
  const branchDiffPreview = useEnvironmentQuery(
    branchDiffPreviewInput && activeThread
      ? revisionedQuery(
          reviewEnvironment.diffPreview({
            environmentId: activeThread.environmentId,
            input: branchDiffPreviewInput,
          }),
          canRefreshGitDiff ? workspaceMutationId : undefined,
        )
      : null,
  );
  const branchCommitsQuery = useEnvironmentQuery(
    visible && isGitRepo && canReadFiles && activeThread && activeCwd
      ? reviewEnvironment.branchCommits({
          environmentId: activeThread.environmentId,
          input: {
            cwd: activeCwd,
            ...(rememberedBaseRef ? { baseRef: rememberedBaseRef } : {}),
          },
        })
      : null,
  );
  const branchCommitsErrorPresentation = branchCommitsQuery.error
    ? presentVersionControlError(
        branchCommitsQuery.failure ?? branchCommitsQuery.error,
        "加载分支提交",
      )
    : null;
  const branchCommits = openCommitMenu ?? branchCommitsQuery.data;
  const activeThreadRefreshKey = routeThreadRef
    ? `${routeThreadRef.environmentId}:${routeThreadRef.threadId}`
    : null;

  const selectedGitSource = branchDiffPreview.data?.sources.find(
    (source) =>
      source.kind ===
      (selectedGitScope === "unstaged"
        ? "working-tree"
        : selectedGitScope === "commit"
          ? "commit"
          : "branch-range"),
  );
  const comparisonHeadRef = selectedGitSource?.headRef ?? gitStatusQuery.data?.refName ?? "HEAD";
  const comparisonBaseRef = selectedGitSource?.baseRef ?? selectedBaseRef ?? "Automatic";
  const selectedCommitSubject =
    selectedCommitSha !== null && selectedGitSource?.headRef === selectedCommitSha
      ? selectedGitSource.commitSubject
      : undefined;
  const selectedGitScopeLabel =
    selectedCommitSha !== null
      ? (selectedCommitSubject ?? `提交 ${selectedCommitSha.slice(0, 7)}`)
      : selectedGitScope === "unstaged"
        ? "未提交的更改"
        : "改动";
  const selectedScopeLabel = toolCallSelection
    ? "工具调用"
    : selectedRunId === null
      ? selectedCommitSha !== null
        ? (selectedCommitSubject ?? "提交")
        : selectedGitScopeLabel
      : selectedTurn?.runId === latestTurn?.runId
        ? "最近一轮"
        : `第 ${selectedCheckpointTurnCount ?? "?"} 轮`;
  const reviewSectionTitle = toolCallSelection
    ? "工具调用"
    : selectedTurn
      ? `第 ${selectedCheckpointTurnCount ?? "?"} 轮`
      : selectedGitScopeLabel;
  const headerCommitSha = selectedRunId === null ? selectedCommitSha : null;
  const selectedCommitUrl =
    headerCommitSha !== null
      ? projectCommitUrl(activeProject?.repositoryIdentity, headerCommitSha)
      : null;
  const openLink = useOpenLink();
  // A SHA link goes to the code host; it must not route back into this pane's commit selection.
  const openCommitUrl = (event: MouseEvent<HTMLElement>, url: string) => {
    event.stopPropagation();
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button === 1)
      return;
    event.preventDefault();
    void openLink(url);
  };
  const refreshPreviewQuery = branchDiffPreview.refresh;
  const refreshDiffFromUserAction = refreshPreviewQuery;

  const preview = branchDiffPreview.data;
  const gitDiff = selectedGitSource?.diff;

  const toolCallPreview =
    toolCallSelection && toolCallItem?.type === "file_change" ? toolCallDiff(toolCallItem) : null;
  const selectedPatch = toolCallSelection
    ? toolCallPreview?.patch
    : selectedTurn
      ? activeCheckpointDiff.data?.diff
      : gitDiff;
  const isSelectedPatchTruncated =
    toolCallPreview?.truncated === true ||
    (isGitSelection && selectedGitSource?.truncated === true) ||
    (!toolCallSelection &&
      selectedTurn !== undefined &&
      selectedPatch?.endsWith(CHECKPOINT_DIFF_TRUNCATED_MARKER) === true);
  const selectedPatchQuery = toolCallSelection
    ? toolCallDetail
    : selectedTurn
      ? activeCheckpointDiff
      : branchDiffPreview;
  const isLoadingSelectedPatch =
    selectedPatchQuery.isPending &&
    (selectedPatchQuery.data === null ||
      (isGitSelection && preview?.incomplete === true && selectedGitSource?.files?.length === 0));
  const selectedPatchErrorPresentation = selectedPatchQuery.error
    ? presentVersionControlError(selectedPatchQuery.failure ?? selectedPatchQuery.error, "加载差异")
    : null;
  const hasResolvedPatch = typeof selectedPatch === "string";
  const hasNoNetChanges =
    hasResolvedPatch &&
    selectedPatch.trim().length === 0 &&
    !preview?.incomplete &&
    (!selectedGitSource?.patchesDeferred || selectedGitSource.files?.length === 0);
  const lazySource =
    isGitSelection &&
    (selectedGitSource?.truncated || selectedGitSource?.patchesDeferred) &&
    selectedGitSource.files?.length
      ? selectedGitSource
      : null;
  const renderablePatch = getRenderablePatch(
    lazySource ? undefined : selectedPatch,
    `diff-panel:${resolvedTheme}`,
    {
      compactPartialHunkOffsets: isGitSelection,
      ...(toolCallSelection ? { ignoreWhitespace: diffIgnoreWhitespace } : {}),
    },
  );
  const recordedToolCallFileCount =
    toolCallSelection && toolCallItem?.type === "file_change"
      ? (toolCallItem.changes?.length ?? 0)
      : 0;
  const omittedToolCallFiles =
    renderablePatch?.kind === "files"
      ? Math.max(0, recordedToolCallFileCount - renderablePatch.files.length)
      : 0;
  const fileStats = new Map(lazySource?.files?.map((file) => [file.path, file]));
  const sourceLineStat =
    isGitSelection && selectedGitSource?.files
      ? selectedGitSource.files.reduce(
          (total, file) => ({
            additions: total.additions + file.additions,
            deletions: total.deletions + file.deletions,
          }),
          { additions: 0, deletions: 0 },
        )
      : null;
  const currentLoadDiffFiles =
    isGitSelection && activeThread && preview && selectedGitSource && canReadFiles
      ? createGitDiffFileContentsLoader(getDiffFileContents, {
          environmentId: activeThread.environmentId,
          cwd: preview.cwd,
          sourceKind: selectedGitSource.kind,
          baseRef: selectedGitSource.baseRef,
          headRef: selectedGitSource.headRef,
          cacheKey: selectedGitSource.diffHash,
        })
      : undefined;
  const loadDiffFiles: FileDiffContentsLoader = useStableCallback(async (fileDiff) => {
    if (!currentLoadDiffFiles) {
      throw new Error("此选择没有可用的差异文件内容。");
    }
    return currentLoadDiffFiles(fileDiff);
  });
  const canSelectBranchBase = canReadFiles && canRefreshGitDiff && selectedGitScope === "branch";
  const branchRefsCwd = branchDiffPreview.data?.cwd ?? activeCwd;
  const localBranchRefs = useEnvironmentQuery(
    canSelectBranchBase && activeThread && branchRefsCwd
      ? vcsEnvironment.listRefs({
          environmentId: activeThread.environmentId,
          input: {
            cwd: branchRefsCwd,
            includeMatchingRemoteRefs: true,
            refKind: "local",
            ...(baseRefQuery.trim().length > 0 ? { query: baseRefQuery.trim() } : {}),
            limit: 100,
          },
        })
      : null,
  );
  const remoteBranchRefs = useEnvironmentQuery(
    canSelectBranchBase && activeThread && branchRefsCwd
      ? vcsEnvironment.listRefs({
          environmentId: activeThread.environmentId,
          input: {
            cwd: branchRefsCwd,
            includeMatchingRemoteRefs: true,
            refKind: "remote",
            ...(baseRefQuery.trim().length > 0 ? { query: baseRefQuery.trim() } : {}),
            limit: 100,
          },
        })
      : null,
  );
  const baseRefChoices = buildBaseRefChoices(
    localBranchRefs.data?.refs.filter((ref) => ref.name !== comparisonHeadRef) ?? [],
    remoteBranchRefs.data?.refs ?? [],
  );
  const matchingBaseRefChoices = filterBaseRefChoices(baseRefChoices, baseRefQuery);
  const valueForBaseRefChoice = (choice: (typeof baseRefChoices)[number]) =>
    selectedBaseRef && selectedBaseRef === choice.remote?.name
      ? selectedBaseRef
      : (choice.local?.name ?? choice.remote?.name ?? choice.id);
  const baseRefItems = [AUTOMATIC_BASE_REF, ...baseRefChoices.map(valueForBaseRefChoice)];
  const filteredBaseRefItems = [
    ...(baseRefQuery.trim().length === 0 ? [AUTOMATIC_BASE_REF] : []),
    ...matchingBaseRefChoices.map(valueForBaseRefChoice),
  ];
  const {
    isPending: areFilePatchesPending,
    fileStates,
    retry,
    requestFile,
    renderableFiles,
    remainingFileCount,
    loadNextFiles,
  } = useReviewFilePatches({
    environmentId: activeThread?.environmentId,
    cwd: branchDiffPreview.data?.cwd,
    source: lazySource,
    baseRef:
      selectedCommitSha !== null ? selectedBaseRef : (lazySource?.baseRef ?? selectedBaseRef),
    ignoreWhitespace: diffIgnoreWhitespace,
    theme: resolvedTheme,
    previewInput: branchDiffPreviewInput,
    preview: renderablePatch,
  });
  const refreshBranchDiffPreview = refreshPreviewQuery;
  const diffRefreshKey = `diff:${activeThreadRefreshKey ?? ""}`;

  // The panel stays mounted while hidden, and edits made outside Fleet ADE bump no mutation id, so
  // showing it revalidates the diff; that also stands in for focus events missed while hidden.
  // A git diff is too costly to repeat on a timer nobody asked for. A diff read within the floor,
  // such as a mutation's refetch while hidden, already counts as that revalidation.
  useLiveRefresh(
    branchDiffPreview.data !== null && !branchDiffPreview.isPending
      ? () => {
          if (Date.now() - branchDiffPreview.dataUpdatedAt < LIVE_REFRESH_MIN_INTERVAL_MS) return;
          refreshBranchDiffPreview();
        }
      : null,
    {
      enabled: visible && canReadFiles && canRefreshGitDiff,
      key: diffRefreshKey,
      intervalMs: null,
      refreshOnShow: true,
    },
  );

  const isRefreshingDiff = branchDiffPreview.isPending || areFilePatchesPending;
  const pathOccurrences = new Map<string, number>();
  const renderableFileEntries = renderableFiles.map((fileDiff) => {
    const entry = getCachedFileEntry(fileDiff);
    if (!isGitSelection) return entry;
    // Metadata has no change type; keep each path's identity when its patch arrives.
    const pathKey = JSON.stringify([fileDiff.prevName ?? fileDiff.name, fileDiff.name]);
    const occurrence = pathOccurrences.get(pathKey) ?? 0;
    pathOccurrences.set(pathKey, occurrence + 1);
    return { ...entry, fileKey: `${pathKey}:${occurrence}` };
  });
  const diffFileKeys = renderableFileEntries.map((file) => file.fileKey);
  const testFileCount = renderableFiles.filter((file) =>
    isTestChangedFile(resolveFileDiffPath(file)),
  ).length;
  // Hiding is display-only: lazy loading indexes into the full list. A requested file stays visible.
  const isFileShown = (file: FileDiffMetadata) => {
    const path = resolveFileDiffPath(file);
    return !hideTestFiles || path === selectedFilePath || !isTestChangedFile(path);
  };
  const shownFileEntries = renderableFileEntries.filter(({ fileDiff }) => isFileShown(fileDiff));
  const shownFileKeys = shownFileEntries.map((file) => file.fileKey);
  const defaultCollapsedDiffFileKeys = settings.diffFilesCollapsed
    ? new Set(diffFileKeys)
    : EMPTY_COLLAPSED_DIFF_FILE_KEYS;
  const storedCollapsedDiffFileKeys = useDiffPanelSessionStore((state) =>
    collapseScopeKey ? state.collapsedFileKeysByScopeKey[collapseScopeKey] : undefined,
  );
  const collapsedDiffFileKeys = storedCollapsedDiffFileKeys ?? defaultCollapsedDiffFileKeys;
  const updateCollapsedDiffFiles = (
    update: (current: ReadonlySet<string>) => ReadonlySet<string>,
  ) => {
    if (!collapseScopeKey) return;
    useDiffPanelSessionStore
      .getState()
      .updateCollapsedFileKeys(collapseScopeKey, defaultCollapsedDiffFileKeys, update);
  };
  const renderLoadingBoundary = () =>
    remainingFileCount > 0 ? (
      <DiffFileLoadingBoundary load={loadNextFiles} count={remainingFileCount} />
    ) : null;
  const codeViewFiles = shownFileEntries.map(({ fileDiff, fileKey, fileVersion }) => ({
    fileDiff,
    filePath: resolveFileDiffPath(fileDiff),
    fileKey,
    fileVersion,
    collapsed:
      collapsedDiffFileKeys.has(fileKey) || fileDiff.cacheKey?.endsWith(":pending") === true,
  }));
  const pendingFiles = renderableFiles.filter(
    (file) => file.cacheKey?.endsWith(":pending") && isFileShown(file),
  );
  const allDiffFilesCollapsed = areAllDiffFilesCollapsed(shownFileKeys, collapsedDiffFileKeys);
  const diffLineStat = sourceLineStat ?? getDiffLineStat(renderableFiles);
  const fileTreeEntries = diffFileTreeEntries(renderableFiles.filter(isFileShown));
  const codeViewReveal = useCodeViewFileReveal();
  // Lazy files that sat above the saved position load again only when asked for.
  const codeViewScroll = useCodeViewScrollRestore(
    collapseScopeKey,
    !isRefreshingDiff && remainingFileCount === 0,
    remainingFileCount > 0 ? loadNextFiles : null,
  );
  const attachCodeView = useStableCallback((handle: AnnotatableCodeViewHandle | null) => {
    codeViewScroll.attach(handle);
    codeViewReveal.attach(handle);
  });
  const flushCodeView = useStableCallback(() => {
    codeViewScroll.flush();
    codeViewReveal.flush();
  });
  const revealDiffFile = (filePath: string) => {
    const index = renderableFileEntries.findIndex(
      (candidate) => resolveFileDiffPath(candidate.fileDiff) === filePath,
    );
    const file = renderableFileEntries[index];
    if (!file) return false;
    codeViewScroll.discard();
    updateCollapsedDiffFiles((current) => {
      const next = new Set(current);
      next.delete(file.fileKey);
      return next;
    });
    if (lazySource) requestFile(filePath);
    codeViewReveal.request(file.fileKey);
    return true;
  };

  // A file another view asked to reveal (a chat diff link): retried as the diff loads until it
  // holds the file, then not again until a new request, so it does not undo what the user did since.
  const externalRevealRef = useRef<string | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reveals an externally requested file in the diff viewer, retrying as the diff DOM loads
  useEffect(() => {
    if (!selectedFilePath) {
      externalRevealRef.current = null;
      return;
    }
    const key = JSON.stringify([collapseScopeKey, selectedFilePath, selectedFileRevealRequestId]);
    if (externalRevealRef.current === key) return;
    if (revealDiffFile(selectedFilePath)) {
      externalRevealRef.current = key;
    }
  }, [collapseScopeKey, selectedFilePath, selectedFileRevealRequestId, revealDiffFile]);

  const openDiffFile = (filePath: string) => {
    openDiffFilePrimaryAction({
      threadRef: routeThreadRef,
      filePath,
      activeCwd,
      repositoryRoot: activeRepositoryRoot,
      openInEditor: (targetPath) => {
        void (async () => {
          const result = await openInPreferredEditor(targetPath);
          if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
            console.warn("Failed to open diff file in editor.", {
              operation: "open-diff-file",
              ...(routeThreadRef
                ? {
                    environmentId: routeThreadRef.environmentId,
                    threadId: routeThreadRef.threadId,
                  }
                : {}),
              ...safeErrorLogAttributes(squashAtomCommandFailure(result)),
            });
          }
        })();
      },
    });
  };
  const toggleDiffFileCollapsed = useStableCallback((fileKey: string) => {
    const file = renderableFileEntries.find((file) => file.fileKey === fileKey);
    if (lazySource && file) requestFile(resolveFileDiffPath(file.fileDiff));
    const pending = file?.fileDiff.cacheKey?.endsWith(":pending") === true;
    updateCollapsedDiffFiles((current) => {
      const next = new Set(current);
      if (pending || next.has(fileKey)) {
        next.delete(fileKey);
      } else {
        next.add(fileKey);
      }
      return next;
    });
  });
  // Find can ask again before the unfolded file reaches the viewer, so this must never fold.
  const unfoldDiffFile = useStableCallback((fileKey: string) => {
    updateCollapsedDiffFiles((current) => {
      if (!current.has(fileKey)) return current;
      const next = new Set(current);
      next.delete(fileKey);
      return next;
    });
  });

  const toggleDiffFileCollapse = () => {
    codeViewScroll.discard();
    setCodeViewRevision((current) => current + 1);
    updateCollapsedDiffFiles((current) => toggleAllDiffFiles(shownFileKeys, current));
  };

  const selectTurn = (runId: RunId) => {
    if (!routeThreadRef) return;
    useDiffPanelStore.getState().selectTurn(routeThreadRef, runId);
  };
  const selectGitScope = (scope: "branch" | "unstaged") => {
    if (!routeThreadRef) return;
    useDiffPanelStore.getState().selectGitScope(routeThreadRef, scope);
  };
  const selectBranchBaseRef = (baseRef: string | null) => {
    if (!routeThreadRef) return;
    useDiffPanelStore.getState().selectBranchBaseRef(routeThreadRef, baseRef);
  };
  const selectedTurnValue = selectedTurn ? `turn:${selectedTurn.runId}` : "";
  const selectedCommitValue = selectedCommitSha !== null ? `commit:${selectedCommitSha}` : "";
  const selectedScopeValue = toolCallSelection
    ? ""
    : selectedRunId === null
      ? selectedCommitValue || selectedGitScope
      : selectedTurn?.runId === latestTurn?.runId
        ? "latest"
        : selectedTurnValue;
  const selectScopeValue = (value: string) => {
    if (value === "unstaged" || value === "branch") {
      selectGitScope(value);
    } else if (value === selectedCommitValue) {
      selectGitScope("branch");
    } else if (value.startsWith("commit:")) {
      if (routeThreadRef) {
        useDiffPanelStore.getState().selectCommit(routeThreadRef, value.slice("commit:".length));
      }
    } else if (value === "latest") {
      if (latestTurn) selectTurn(latestTurn.runId);
    } else {
      const turn = orderedTurnDiffSummaries.find((summary) => `turn:${summary.runId}` === value);
      if (turn) selectTurn(turn.runId);
    }
  };

  const headerRow = (
    <>
      <div className="@container/diff-refs flex min-w-0 flex-1 items-center gap-3 [-webkit-app-region:no-drag]">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button size="xs" variant="secondary" />}
            className={cn("max-w-full", headerCommitSha !== null && "min-w-0 shrink")}
            aria-label={`差异范围：${selectedScopeLabel}`}
            data-workspace-focus-default
          >
            <span className="truncate">{selectedScopeLabel}</span>
            <ChevronDownIcon className="size-3.5 shrink-0 opacity-70" />
          </DropdownMenuTrigger>
          {headerCommitSha !== null ? (
            selectedCommitUrl ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <a
                      href={selectedCommitUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="shrink-0 font-mono text-xs text-muted-foreground underline underline-offset-4"
                      onClick={(event) => openCommitUrl(event, selectedCommitUrl)}
                    />
                  }
                >
                  {headerCommitSha.slice(0, 7)}
                </TooltipTrigger>
                <TooltipPopup side="top">{selectedCommitUrl}</TooltipPopup>
              </Tooltip>
            ) : (
              <span className="shrink-0 font-mono text-xs text-muted-foreground">
                {headerCommitSha.slice(0, 7)}
              </span>
            )
          ) : null}
          <DropdownMenuContent align="start">
            <DropdownMenuRadioGroup value={selectedScopeValue} onValueChange={selectScopeValue}>
              <DropdownMenuRadioItem value="branch" closeOnClick>
                <span>改动</span>
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="unstaged" closeOnClick>
                <span>未提交的更改</span>
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="latest" closeOnClick>
                <span>最近一轮</span>
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>轮次</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuRadioGroup value={selectedTurnValue} onValueChange={selectScopeValue}>
                  {orderedTurnDiffSummaries.map((summary) => {
                    const turnCount = summary.checkpointTurnCount;
                    return (
                      <DropdownMenuRadioItem
                        key={summary.runId}
                        value={`turn:${summary.runId}`}
                        closeOnClick
                      >
                        <span className="flex items-center gap-2">
                          <span>轮次 {turnCount}</span>
                          <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                            {formatShortTimestamp(summary.completedAt, settings.timestampFormat)}
                          </span>
                        </span>
                      </DropdownMenuRadioItem>
                    );
                  })}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSub
              onOpenChange={(open) => {
                setOpenCommitMenu(open ? (branchCommitsQuery.data ?? null) : null);
                if (!open) return;
                // The menu keeps the list it opened with; the refreshed one shows next time.
                branchCommitsQuery.refresh();
              }}
            >
              <DropdownMenuSubTrigger>提交</DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="max-h-80 max-w-96">
                <DropdownMenuRadioGroup
                  value={selectedCommitValue}
                  onValueChange={selectScopeValue}
                >
                  {branchCommits?.commits.map((commit) => {
                    const commitUrl = projectCommitUrl(
                      activeProject?.repositoryIdentity,
                      commit.sha,
                    );
                    return (
                      <div
                        key={commit.sha}
                        className={cn(
                          "flex items-center rounded-sm hover:bg-accent has-data-highlighted:bg-accent has-focus-visible:bg-accent [&_[data-checked]]:bg-transparent [&_[data-highlighted]]:bg-transparent",
                          selectedCommitSha === commit.sha && "bg-foreground/[0.08]",
                        )}
                      >
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <DropdownMenuRadioItem
                                className="min-w-0 flex-1"
                                value={`commit:${commit.sha}`}
                                closeOnClick
                              />
                            }
                          >
                            <span className="flex items-center gap-3">
                              <span className="min-w-0 flex-1 truncate">{commit.subject}</span>
                              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                                {formatRelativeTimeLabel(commit.committedAt)}
                              </span>
                            </span>
                          </TooltipTrigger>
                          <TooltipPopup side="right" className="max-w-80">
                            {commit.subject}
                          </TooltipPopup>
                        </Tooltip>
                        {commitUrl ? (
                          <DropdownMenuItem
                            className="shrink-0"
                            render={
                              <a
                                href={commitUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                aria-label={`打开提交 ${commit.sha.slice(0, 7)}`}
                              />
                            }
                            onClick={(event) => openCommitUrl(event, commitUrl)}
                          >
                            <span className="font-mono text-xs text-muted-foreground underline underline-offset-4">
                              {commit.sha.slice(0, 7)}
                            </span>
                          </DropdownMenuItem>
                        ) : (
                          <span className="shrink-0 px-2 font-mono text-xs text-muted-foreground">
                            {commit.sha.slice(0, 7)}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </DropdownMenuRadioGroup>
                {branchCommitsErrorPresentation ? (
                  <DropdownMenuItem disabled>
                    <span className="flex flex-col">
                      <span>{branchCommitsErrorPresentation.title}</span>
                      {branchCommitsErrorPresentation.nextStep ? (
                        <span>{branchCommitsErrorPresentation.nextStep}</span>
                      ) : null}
                      <span>{branchCommitsErrorPresentation.detail}</span>
                    </span>
                  </DropdownMenuItem>
                ) : !canReadFiles ? (
                  <DropdownMenuItem disabled>
                    {fileAccess.isPending
                      ? "正在检查文件访问权限…"
                      : (fileAccess.error ?? "此连接无法读取本地差异。")}
                  </DropdownMenuItem>
                ) : branchCommits === null ? (
                  <DropdownMenuItem disabled>正在加载提交…</DropdownMenuItem>
                ) : branchCommits.commits.length === 0 ? (
                  <DropdownMenuItem disabled>此分支没有提交。</DropdownMenuItem>
                ) : branchCommits.truncated ? (
                  <DropdownMenuItem disabled>
                    {`显示最近的 ${branchCommits.commits.length} 个提交`}
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </DropdownMenuContent>
        </DropdownMenu>
        {canSelectBranchBase && (
          <div
            className="flex min-w-0 max-w-full items-center gap-2 overflow-hidden text-xs text-muted-foreground"
            aria-label={`比较 ${comparisonHeadRef} 与 ${comparisonBaseRef}`}
          >
            <Tooltip>
              <TooltipTrigger
                render={
                  // Too narrow for both refs, keep the target readable and drop the head, which
                  // is the thread's own branch.
                  <span className="flex min-w-[min(3rem,calc(100%-2.75rem))] items-center gap-2 overflow-hidden @max-[20rem]/diff-refs:hidden" />
                }
              >
                <span className="min-w-0 max-w-48 truncate">{comparisonHeadRef}</span>
                <ArrowRightIcon className="size-3.5 shrink-0 opacity-70" />
              </TooltipTrigger>
              <TooltipPopup side="top">
                {`${comparisonHeadRef} → ${comparisonBaseRef}`}
              </TooltipPopup>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={<span aria-hidden className="hidden @max-[20rem]/diff-refs:inline" />}
              >
                vs
              </TooltipTrigger>
              <TooltipPopup side="top">
                {`${comparisonHeadRef} → ${comparisonBaseRef}`}
              </TooltipPopup>
            </Tooltip>
            <Combobox
              items={baseRefItems}
              filteredItems={filteredBaseRefItems}
              value={selectedBaseRef ?? AUTOMATIC_BASE_REF}
              onOpenChange={(open) => {
                if (!open) setBaseRefQuery("");
              }}
              onValueChange={(value) => {
                if (!value) return;
                selectBranchBaseRef(value === AUTOMATIC_BASE_REF ? null : value);
              }}
            >
              <ComboboxTrigger
                render={<Button variant="muted" size="xs" />}
                className="min-w-9 max-w-48 shrink-0"
                aria-label={`更改比较目标。当前为 ${comparisonBaseRef}。`}
              >
                <span className="min-w-0 truncate">{comparisonBaseRef}</span>
                <ChevronDownIcon className="size-3.5 shrink-0 opacity-70" />
              </ComboboxTrigger>
              <ComboboxPopup
                align="start"
                className="w-72 min-w-0 max-w-[calc(100vw-1rem)] overflow-hidden"
              >
                <ComboboxSearchInput
                  placeholder="搜索分支或标签…"
                  value={baseRefQuery}
                  onChange={(event) => setBaseRefQuery(event.target.value)}
                />
                <div className="grid shrink-0 grid-cols-[1rem_minmax(0,1fr)] items-center gap-2 border-b border-border/70 ps-3 pe-6.5 pt-2 pb-1.5 text-meta font-medium text-muted-foreground uppercase tracking-wide">
                  <span aria-hidden="true" />
                  <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_2rem] items-center">
                    <span>分支</span>
                    <span className="text-right">远端</span>
                  </div>
                </div>
                <ComboboxEmpty>没有匹配的分支或标签。</ComboboxEmpty>
                <ComboboxList className="max-h-64 min-w-0 overflow-x-hidden">
                  <ComboboxItem
                    className="w-full min-w-0 grid-cols-[1rem_minmax(0,1fr)]"
                    value={AUTOMATIC_BASE_REF}
                  >
                    <span className="block min-w-0 truncate">自动</span>
                  </ComboboxItem>
                  {baseRefChoices.map((choice) => {
                    const item = valueForBaseRefChoice(choice);
                    const hasBoth = choice.local !== null && choice.remote !== null;
                    const useRemote = choice.remote?.name === item;
                    return (
                      <ComboboxItem
                        key={choice.id}
                        className="w-full min-w-0 grid-cols-[1rem_minmax(0,1fr)]"
                        value={item}
                      >
                        <div className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)_2rem] items-center overflow-hidden">
                          <span className="block min-w-0 truncate pe-2">{choice.label}</span>
                          {hasBoth ? (
                            <div
                              className="flex justify-end"
                              onClick={(event) => event.stopPropagation()}
                              onPointerDown={(event) => event.stopPropagation()}
                            >
                              <Switch
                                aria-label={`使用 ${choice.label} 的远端版本`}
                                checked={useRemote}
                                className="[--thumb-size:--spacing(3)]"
                                onCheckedChange={(checked) => {
                                  const nextRef = checked
                                    ? choice.remote?.name
                                    : choice.local?.name;
                                  if (nextRef) selectBranchBaseRef(nextRef);
                                }}
                              />
                            </div>
                          ) : choice.remote ? (
                            <Tooltip>
                              <TooltipTrigger
                                render={
                                  <span className="flex justify-end text-muted-foreground">
                                    <CheckIcon role="img" aria-label="仅远端" className="size-3" />
                                  </span>
                                }
                              />
                              <TooltipPopup side="top">仅远端</TooltipPopup>
                            </Tooltip>
                          ) : null}
                        </div>
                      </ComboboxItem>
                    );
                  })}
                </ComboboxList>
              </ComboboxPopup>
            </Combobox>
          </div>
        )}
      </div>
      <div
        className={cn(
          "flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]",
          headerCommitSha !== null && "gap-0",
        )}
      >
        {codeViewFiles.length > 0 || (isGitSelection && selectedGitSource?.files?.length) ? (
          <DiffStatLabel
            additions={diffLineStat.additions}
            deletions={diffLineStat.deletions}
            className="mr-1 text-2xs"
            layout="inline"
          />
        ) : null}
        {canRefreshGitDiff && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="sm"
                  icon
                  variant="ghost"
                  aria-label={isRefreshingDiff ? "正在刷新差异" : "刷新差异"}
                  onClick={refreshDiffFromUserAction}
                />
              }
            >
              <RefreshIcon size="sm" refreshing={isRefreshingDiff} />
            </TooltipTrigger>
            <TooltipPopup side="top">
              {isRefreshingDiff ? "正在刷新差异…" : "刷新差异"}
            </TooltipPopup>
          </Tooltip>
        )}
        {diffFileKeys.length > 0 && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="sm"
                  icon
                  variant="ghost"
                  aria-label={allDiffFilesCollapsed ? "展开所有文件" : "折叠所有文件"}
                  onClick={toggleDiffFileCollapse}
                />
              }
            >
              {allDiffFilesCollapsed ? (
                <ChevronsUpDownIcon className="size-3.5" />
              ) : (
                <ChevronsDownUpIcon className="size-3.5" />
              )}
            </TooltipTrigger>
            <TooltipPopup side="top">
              {allDiffFilesCollapsed ? "展开所有文件" : "折叠所有文件"}
            </TooltipPopup>
          </Tooltip>
        )}
        <ToggleGroup
          aria-label="差异布局"
          className="shrink-0"
          variant="segmented"
          value={[diffLayout]}
          onValueChange={(value) => {
            const next = value[0];
            if (next === "stacked" || next === "split") {
              updateClientSettings({ diffLayout: next });
            }
          }}
        >
          <Toggle aria-label="堆叠式差异视图" value="stacked">
            <Rows3Icon className="size-3.5" />
          </Toggle>
          <Toggle aria-label="并排式差异视图" value="split">
            <Columns2Icon className="size-3.5" />
          </Toggle>
        </ToggleGroup>
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                aria-label={wordWrap ? "关闭差异自动换行" : "开启差异自动换行"}
                variant="ghost"
                size="sm"
                pressed={wordWrap}
                onPressedChange={(pressed) => {
                  setWordWrapOverride(Boolean(pressed));
                }}
              />
            }
          >
            <TextWrapIcon className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="top">{wordWrap ? "关闭自动换行" : "开启自动换行"}</TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                aria-label={diffIgnoreWhitespace ? "显示空白字符改动" : "隐藏空白字符改动"}
                variant="ghost"
                size="sm"
                pressed={diffIgnoreWhitespace}
                onPressedChange={(pressed) => {
                  useDiffPanelSessionStore.getState().setIgnoreWhitespace(Boolean(pressed));
                }}
              />
            }
          >
            <PilcrowIcon className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="top">
            {diffIgnoreWhitespace ? "显示空白字符改动" : "隐藏空白字符改动"}
          </TooltipPopup>
        </Tooltip>
        {testFileCount > 0 && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Toggle
                  aria-label="隐藏测试文件"
                  variant="ghost"
                  size="sm"
                  pressed={hideTestFiles}
                  onPressedChange={(pressed) => setHideTestFiles(Boolean(pressed))}
                />
              }
            >
              <FlaskConicalOffIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="top">
              {hideTestFiles ? `显示 ${testFileCount} 个隐藏的测试文件` : "隐藏测试文件"}
            </TooltipPopup>
          </Tooltip>
        )}
        {diffFileKeys.length > 0 && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Toggle
                  aria-label={fileTreeOpen ? "隐藏文件树" : "显示文件树"}
                  variant="ghost"
                  size="sm"
                  pressed={fileTreeOpen}
                  onPressedChange={(pressed) => setFileTreeOpen(Boolean(pressed))}
                />
              }
            >
              <FolderTreeIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="top">{fileTreeOpen ? "隐藏文件树" : "显示文件树"}</TooltipPopup>
          </Tooltip>
        )}
      </div>
    </>
  );

  return (
    <DiffPanelShell mode={mode} header={headerRow}>
      {!activeThread ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          选择一个会话以查看轮次差异。
        </div>
      ) : !isGitRepo && !toolCallSelection ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          此项目不是 Git 仓库，无法查看轮次差异。
        </div>
      ) : selectedRunId !== null && orderedTurnDiffSummaries.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          尚无已完成的轮次。
        </div>
      ) : isGitSelection && !canReadFiles ? (
        fileAccess.isPending ? (
          <DiffPanelLoadingState label="正在检查文件访问权限…" />
        ) : (
          <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
            {fileAccess.error ?? "此连接无法读取本地差异。"}
          </div>
        )
      ) : (
        <>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
            {preview?.incomplete && (
              <p className="shrink-0 border-b border-border/70 bg-muted/40 px-3 py-1.5 text-2xs text-muted-foreground">
                {selectedPatchErrorPresentation
                  ? "正在显示已跟踪的改动。无法加载未跟踪的改动。刷新以重试。"
                  : "正在显示已跟踪的改动。正在检查未跟踪的文件…"}
              </p>
            )}
            {isSelectedPatchTruncated && !lazySource && (
              <p className="shrink-0 border-b border-border/70 bg-muted/40 px-3 py-1.5 text-2xs text-muted-foreground">
                此预览超出大小限制。显示的改动不完整。
                {isGitSelection && selectedGitSource?.files && !preview?.incomplete
                  ? "合计包含全部改动。"
                  : ""}
              </p>
            )}
            {omittedToolCallFiles > 0 && (
              <p className="shrink-0 border-b border-border/70 bg-muted/40 px-3 py-1.5 text-2xs text-muted-foreground">
                这次工具调用改了 {recordedToolCallFileCount} 个文件。记录的补丁省略了其中{" "}
                {omittedToolCallFiles} 个。
              </p>
            )}
            {selectedPatchErrorPresentation && !renderablePatch && (
              <div className="px-3">
                <p className="mb-1 text-2xs font-medium text-error/80">
                  {selectedPatchErrorPresentation.title}
                </p>
                {selectedPatchErrorPresentation.nextStep ? (
                  <p className="mb-1 text-2xs text-error/80">
                    {selectedPatchErrorPresentation.nextStep}
                  </p>
                ) : null}
                <p className="mb-2 whitespace-pre-wrap text-2xs text-error/80">
                  {selectedPatchErrorPresentation.detail}
                </p>
              </div>
            )}
            {!renderablePatch && toolCallPreview && toolCallPreview.content.length > 0 ? (
              <div className="min-h-0 flex-1 space-y-3 overflow-auto p-3 text-xs">
                <p className="text-muted-foreground">智能体记录了文件内容，但没有差异。</p>
                {toolCallPreview.content.map(({ label, text }) => (
                  <div key={label} className="space-y-1">
                    <p className="text-muted-foreground">{label}</p>
                    <pre
                      className={cn(
                        "overflow-auto font-mono text-2xs",
                        wordWrap && "whitespace-pre-wrap wrap-break-word",
                      )}
                    >
                      {text === "" ? "内容为空。" : text}
                    </pre>
                  </div>
                ))}
              </div>
            ) : !renderablePatch && !lazySource ? (
              isLoadingSelectedPatch ? (
                <DiffPanelLoadingState
                  label={
                    toolCallSelection
                      ? "正在加载工具调用差异…"
                      : selectedTurn
                        ? "正在加载文件快照差异…"
                        : selectedGitScope === "unstaged"
                          ? "正在加载未提交的改动…"
                          : selectedGitScope === "commit"
                            ? "正在加载提交…"
                            : "正在加载改动…"
                  }
                />
              ) : (
                <div className="flex h-full items-center justify-center px-3 py-2 text-xs text-muted-foreground/70">
                  <p>{hasNoNetChanges ? "此选择没有净改动。" : "此选择没有可用的补丁。"}</p>
                </div>
              )
            ) : lazySource || renderablePatch?.kind === "files" ? (
              <div className="flex min-h-0 flex-1 overflow-hidden">
                <div
                  className="min-h-0 min-w-0 flex-1"
                  onClickCapture={(event) => {
                    const composedPath = event.nativeEvent.composedPath?.() ?? [];
                    for (const node of composedPath) {
                      if (!(node instanceof HTMLElement)) continue;
                      // Header buttons own their clicks; bubbling a chevron click would toggle twice.
                      if (node instanceof HTMLButtonElement || node instanceof HTMLAnchorElement) {
                        return;
                      }
                    }
                    const title = composedPath.find(
                      (node): node is HTMLElement =>
                        node instanceof HTMLElement && node.hasAttribute("data-title"),
                    );
                    const filePath = title?.textContent;
                    if (filePath) {
                      openDiffFile(filePath);
                      return;
                    }
                    const header = composedPath.find(
                      (node): node is HTMLElement =>
                        node instanceof HTMLElement && node.hasAttribute("data-diffs-header"),
                    );
                    const headerFilePath = header?.querySelector("[data-title]")?.textContent;
                    if (!headerFilePath) return;
                    const file = codeViewFiles.find(
                      (candidate) => candidate.filePath === headerFilePath,
                    );
                    if (file) toggleDiffFileCollapsed(file.fileKey);
                  }}
                  onContextMenuCapture={(event) => {
                    const composedPath = event.nativeEvent.composedPath?.() ?? [];
                    const title = composedPath.find(
                      (node): node is HTMLElement =>
                        node instanceof HTMLElement && node.hasAttribute("data-title"),
                    );
                    const filePath = title?.textContent?.trim();
                    if (!filePath) return;
                    event.preventDefault();
                    onFileContextMenu(
                      {
                        environmentId: activeThread?.environmentId ?? null,
                        filePath,
                        workspaceRoot: activeCwd,
                        repositoryRoot: activeRepositoryRoot,
                      },
                      event,
                    );
                  }}
                >
                  <AnnotatableCodeView
                    key={collapseScopeKey ?? reviewSectionId}
                    viewerRef={attachCodeView}
                    onScroll={codeViewScroll.onScroll}
                    codeViewKey={codeViewMountKey}
                    className="h-full min-h-0 overflow-auto"
                    files={codeViewFiles}
                    pendingFiles={pendingFiles}
                    renderCodeViewFooter={renderLoadingBoundary}
                    sectionId={reviewSectionId}
                    sectionTitle={reviewSectionTitle}
                    composerDraftTarget={composerDraftTarget}
                    renderHeaderFilenameSuffix={(fileDiff) => {
                      const path = resolveFileDiffPath(fileDiff);
                      const state = fileStates.get(path);
                      return (
                        <DiffFileHeaderSuffix
                          filePath={path}
                          hasStat={fileStats.has(path)}
                          error={state?.error ?? false}
                          truncated={state?.truncated ?? false}
                          onRetry={retry}
                        />
                      );
                    }}
                    {...(lazySource
                      ? {
                          unsafeCSSExtra:
                            "[data-additions-count], [data-deletions-count] { display: none; }",
                          renderHeaderMetadata: (fileDiff: FileDiffMetadata) => {
                            const stat = fileStats.get(resolveFileDiffPath(fileDiff));
                            return stat ? (
                              <DiffStatLabel
                                additions={stat.additions}
                                deletions={stat.deletions}
                              />
                            ) : null;
                          },
                        }
                      : {})}
                    onRevealSearchMatch={unfoldDiffFile}
                    renderHeaderPrefix={(fileDiff, fileKey, collapsed) => {
                      return (
                        <DiffFileCollapseToggle
                          filePath={resolveFileDiffPath(fileDiff)}
                          fileKey={fileKey}
                          collapsed={collapsed}
                          onToggle={toggleDiffFileCollapsed}
                          {...(fileDiff.cacheKey?.endsWith(":pending") &&
                          !collapsedDiffFileKeys.has(fileKey)
                            ? {
                                load: () => requestFile(resolveFileDiffPath(fileDiff)),
                              }
                            : {})}
                        />
                      );
                    }}
                    options={{
                      diffStyle: diffLayout === "split" ? "split" : "unified",
                      lineDiffType: "none",
                      overflow: wordWrap ? "wrap" : "scroll",
                      theme: resolveDiffThemeName(resolvedTheme),
                      preferredHighlighter: PREFERRED_HIGHLIGHTER,
                      themeType: resolvedTheme as DiffThemeType,
                      stickyHeaders: true,
                      onPostRender: flushCodeView,
                      ...(currentLoadDiffFiles ? { loadDiffFiles } : {}),
                    }}
                  />
                </div>
                {fileTreeOpen ? (
                  <FileExplorerPane
                    resizable
                    storageKey="t3code:diff-file-tree-width"
                    defaultWidthFraction={0.4}
                    resizeLabel="调整“改动”文件区的宽度"
                  >
                    <DiffFileTree
                      ariaLabel={`${reviewSectionTitle} 文件`}
                      entries={fileTreeEntries}
                      selectedPath={selectedFilePath}
                      revealRequestId={selectedFileRevealRequestId}
                      onSelectFile={revealDiffFile}
                    />
                  </FileExplorerPane>
                ) : null}
              </div>
            ) : (
              <div className="min-h-0 flex-1 overflow-auto p-2">
                <div className="space-y-2">
                  <p className="text-2xs text-muted-foreground/75">
                    {renderablePatch?.kind === "raw" ? renderablePatch.reason : null}
                  </p>
                  <pre
                    className={cn(
                      "max-h-[72vh] rounded-md border border-border/70 bg-background/70 p-3 font-mono text-2xs leading-relaxed text-muted-foreground/90",
                      wordWrap
                        ? "overflow-auto whitespace-pre-wrap wrap-break-word"
                        : "overflow-auto",
                    )}
                  >
                    {renderablePatch?.kind === "raw" ? renderablePatch.text : null}
                  </pre>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </DiffPanelShell>
  );
}

import {
  parsePullRequestAnchor,
  pullRequestDiffPathMatches,
  pullRequestLinkCommit,
} from "@t3tools/shared/pullRequestAnchor";
import {
  capitalizeTerm,
  sourceControlClients,
} from "@t3tools/client-runtime/source-control-clients";
import type {
  CodeViewItem,
  DiffLineAnnotation,
  FileDiffMetadata,
  SelectedLineRange,
} from "@pierre/diffs";
import type { CodeViewAnnotationArgs, CodeViewDiffItem } from "@pierre/diffs/react";
import type {
  EnvironmentId,
  PullRequestDetailView,
  PullRequestDiffResult,
  PullRequestDiffSide,
  PullRequestOmittedFileStat,
  PullRequestRef,
} from "@t3tools/contracts";
import { SOURCE_CONTROL_MEDIA_ASSET } from "@t3tools/contracts";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
  Columns2Icon,
  FlaskConicalOffIcon,
  FolderTreeIcon,
  PilcrowIcon,
  Rows3Icon,
  Settings2Icon,
  TextWrapIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useAtomRefresh } from "@effect/atom-react";
import * as Schema from "effect/Schema";
import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";

import { observeIntersection } from "~/lib/observeIntersection";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useClientSettings, updateClientSettings } from "~/hooks/useSettings";
import { useRenderedAppearance } from "~/hooks/useTheme";
import { areAllDiffFilesCollapsed } from "~/lib/diffCollapse";
import { isTestChangedFile } from "@t3tools/shared/changedFileKind";
import { isWorkspaceImagePreviewPath } from "@t3tools/shared/mediaPreview";
import { orderDiffFiles } from "./pullRequestFileOrder.logic";
import {
  buildFileDiffRenderKey,
  fnv1a32,
  getDiffLineStat,
  getRenderablePatch,
  resolveDiffThemeName,
  resolveFileDiffPath,
  type RenderablePatch,
} from "~/lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "~/lib/syntaxHighlighting";
import { createPullRequestDiffFileContentsLoader } from "~/lib/diffFileContents";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

import { ChatMarkdownAssetImage } from "../chat/ChatMarkdownMedia";
import { DiffPanelLoadingState } from "../DiffPanelShell";
import { useDiffWorkerPool } from "../DiffWorkerPoolProvider";
import { DiffFileTree } from "../diffs/DiffFileTree";
import { FileExplorerPane } from "../files/FileExplorerPane";
import { useCodeViewFileReveal } from "../diffs/useCodeViewFileReveal";
import { useHideTestFiles } from "../diffs/useHideTestFiles";
import { diffFileTreeEntries, orderDiffFilesLikeTree } from "../diffs/diffFileTree.logic";
import { StyledDiffCodeView } from "../diffs/StyledDiffCodeView";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/menu";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  isFileDiffCollapsed,
  withFileDiffFold,
  type DiffFoldOverride,
  type FileDiffFoldChoices,
} from "./pullRequestDiff.logic";
import { PullRequestDiffStat, PullRequestMetaLine } from "./pullRequestPresentation";
import { PullRequestDiffUnavailableState } from "./PullRequestDiffUnavailableState";

interface DiffAnnotationMetadata {
  readonly image?: { readonly url: string; readonly path: string };
}

type DiffAnnotation = DiffLineAnnotation<DiffAnnotationMetadata>;

const COMMIT_PAGE_SIZE = 10;

const PULL_REQUEST_FILE_TREE_STORAGE_KEY = "t3code.pullRequestFileTreeOpen";

interface DiffSlice {
  readonly source: PullRequestDiffResult;
  readonly cursor: string | null;
  readonly patch: string;
  readonly truncated: boolean;
  readonly nextCursor: string | null;
  readonly omittedFileStats: ReadonlyArray<PullRequestOmittedFileStat>;
}

// Show host counts outside the shadow root; hunk totals are zero when hosts withhold hunks.
const REPLACE_FILE_COUNTS_CSS = `
[data-diffs-header] [data-additions-count],
[data-diffs-header] [data-deletions-count] {
  display: none !important;
}`;

const NO_SLICES: ReadonlyArray<DiffSlice> = [];

// Query results outlive the panel's slices, so their parses survive closing and reopening
// without retaining anything beyond the query cache's lifetime.
const sliceParses = new WeakMap<PullRequestDiffResult, Map<string, RenderablePatch | null>>();

function parseSlice(slice: DiffSlice, cacheKey: string, ignoreWhitespace: boolean) {
  let parses = sliceParses.get(slice.source);
  if (parses === undefined) {
    parses = new Map();
    sliceParses.set(slice.source, parses);
  }
  if (parses.has(cacheKey)) return parses.get(cacheKey) ?? null;
  const parsed = getRenderablePatch(slice.patch, cacheKey, {
    compactPartialHunkOffsets: true,
    ignoreWhitespace,
  });
  parses.set(cacheKey, parsed);
  return parsed;
}

type DiffModel = {
  readonly parsedSlices: ReadonlyArray<RenderablePatch | null>;
  readonly loadedFiles: ReadonlyArray<Extract<RenderablePatch, { kind: "files" }>["files"][number]>;
  readonly sourceFileStats: ReadonlyMap<string, ReturnType<typeof getDiffLineStat>>;
};
const diffModels = new WeakMap<ReadonlyArray<DiffSlice>, Map<string, DiffModel>>();
const patchHashes = new WeakMap<DiffSlice, number>();

// Hashing, ordering and counting every file of a huge pull request costs a second, and the tab
// renders far more often than its slices change, so the model is kept per slice list.
function diffModel(
  slices: ReadonlyArray<DiffSlice>,
  keyPrefix: string,
  ignoreWhitespace: boolean,
): DiffModel {
  let models = diffModels.get(slices);
  if (models === undefined) diffModels.set(slices, (models = new Map()));
  const cached = models.get(keyPrefix);
  if (cached !== undefined) return cached;
  const parsedSlices = slices.map((slice) => {
    let hash = patchHashes.get(slice);
    if (hash === undefined) patchHashes.set(slice, (hash = fnv1a32(slice.patch)));
    // The cache key carries the theme, which the tokenizer caches against, and the patch's
    // hash: a refreshed page reuses its cursor, so position alone would return a stale parse.
    return parseSlice(slice, `${keyPrefix}:${slice.cursor ?? "first"}:${hash}`, ignoreWhitespace);
  });
  const model: DiffModel = {
    parsedSlices,
    loadedFiles: orderDiffFilesLikeTree(
      parsedSlices.flatMap((parsed) =>
        parsed?.kind === "files" ? orderDiffFiles(parsed.files) : [],
      ),
    ),
    sourceFileStats: new Map(
      parsedSlices.flatMap((parsed) =>
        parsed?.kind === "files"
          ? parsed.files.map(
              (file, index) =>
                [
                  buildFileDiffRenderKey(file),
                  getDiffLineStat([parsed.sourceFiles[index] ?? file]),
                ] as const,
            )
          : [],
      ),
    ),
  };
  models.set(keyPrefix, model);
  return model;
}

function toViewerSide(side: PullRequestDiffSide): "deletions" | "additions" {
  return side === "left" ? "deletions" : "additions";
}

function PullRequestCodeTab({
  scrollerRef,
  environmentId,
  reference,
  detail,
  selectedCommitOid,
  onSelectedCommitChange,
  refreshToken = 0,
  backgroundRefreshToken = 0,
  revealRequest = null,
  revealUrl,
  onRevealSettled,
}: {
  scrollerRef: (node: HTMLDivElement | null) => void;
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  detail: PullRequestDetailView;
  selectedCommitOid: string | null;
  onSelectedCommitChange: (oid: string | null) => void;
  refreshToken?: number;
  backgroundRefreshToken?: number;
  /** A clicked link to a file or line range, until onRevealSettled reports it shown. */
  revealUrl?: string | undefined;
  onRevealSettled?: ((revealUrl: string) => void) | undefined;
  revealRequest?: { readonly path: string; readonly nonce: number } | null;
}) {
  const resolvedTheme = useRenderedAppearance();
  // Initialize the shared tokenizer and workers while the diff request is still pending.
  useDiffWorkerPool();
  const settings = useClientSettings((settings) => ({
    diffFilesCollapsed: settings.diffFilesCollapsed,
    diffIgnoreWhitespace: settings.diffIgnoreWhitespace,
    diffLayout: settings.diffLayout,
    wordWrap: settings.wordWrap,
  }));
  const [foldChoices, setFoldChoices] = useState<FileDiffFoldChoices>(() => new Map());
  const [visibleCommitCount, setVisibleCommitCount] = useState(COMMIT_PAGE_SIZE);
  const [foldOverride, setFoldOverride] = useState<DiffFoldOverride>(null);
  const effectiveFoldOverride =
    foldOverride ?? (settings.diffFilesCollapsed ? "folded" : "expanded");
  const diffLayout = settings.diffLayout;
  const [wordWrapOverride, setWordWrapOverride] = useState<boolean | null>(null);
  const wordWrap = wordWrapOverride ?? settings.wordWrap;
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(settings.diffIgnoreWhitespace);
  const [fileTreeOpen, setFileTreeOpen] = useLocalStorage(
    PULL_REQUEST_FILE_TREE_STORAGE_KEY,
    false,
    Schema.Boolean,
  );
  const [hideTestFiles, setHideTestFiles] = useHideTestFiles();
  // Scope slices before reset to prevent using a previous pull request's data or cursor.
  const [sliceState, setSliceState] = useState<{
    readonly key: string;
    readonly cursor: string | null;
    readonly slices: ReadonlyArray<DiffSlice>;
  }>({ key: "", cursor: null, slices: NO_SLICES });

  const referenceKey = JSON.stringify([
    reference.projectId,
    reference.host ?? null,
    reference.repository,
    reference.number,
  ]);
  // A commit left selected across a force-push may no longer be part of the pull request;
  // read it as "All commits" instead of requesting its diff.
  const commit =
    selectedCommitOid !== null && detail.commits.some((entry) => entry.oid === selectedCommitOid)
      ? selectedCommitOid
      : null;
  const scopeKey = JSON.stringify([environmentId, referenceKey, commit]);
  const [stateScopeKey, setStateScopeKey] = useState(scopeKey);
  if (stateScopeKey !== scopeKey) {
    setStateScopeKey(scopeKey);
    setFoldChoices(new Map());
    setFoldOverride(null);
    setVisibleCommitCount(COMMIT_PAGE_SIZE);
    setSliceState({ key: scopeKey, cursor: null, slices: NO_SLICES });
  }

  const loadedSlices = sliceState.key === scopeKey ? sliceState.slices : NO_SLICES;
  const cursor = sliceState.key === scopeKey ? sliceState.cursor : null;
  const diffQuery = useEnvironmentQuery(
    pullRequestEnvironment.diff({
      environmentId,
      input: {
        ...reference,
        ...(cursor === null ? {} : { cursor }),
        ...(commit === null ? {} : { commit }),
      },
    }),
  );
  const [appliedPage, setAppliedPage] = useState<{
    readonly data: typeof diffQuery.data;
    readonly cursor: string | null;
    readonly scopeKey: string;
  } | null>(null);
  const data = diffQuery.data;
  if (
    data !== null &&
    (appliedPage?.data !== data ||
      appliedPage.cursor !== cursor ||
      appliedPage.scopeKey !== scopeKey)
  ) {
    setAppliedPage({ data, cursor, scopeKey });
    setSliceState((previous) => {
      const slices = previous.key === scopeKey ? previous.slices : NO_SLICES;
      const next = {
        source: data,
        cursor,
        patch: data.patch,
        truncated: data.truncated,
        nextCursor: data.nextCursor,
        omittedFileStats: data.omittedFileStats ?? [],
      };
      const index = slices.findIndex((slice) => slice.cursor === cursor);
      if (index === -1) {
        return { key: scopeKey, cursor, slices: [...slices, next] };
      }
      const existing = slices[index];
      if (
        existing !== undefined &&
        existing.patch === next.patch &&
        existing.truncated === next.truncated &&
        existing.nextCursor === next.nextCursor &&
        existing.omittedFileStats.length === next.omittedFileStats.length &&
        existing.omittedFileStats.every((file, index) => {
          const refreshed = next.omittedFileStats[index];
          return (
            refreshed !== undefined &&
            refreshed.path === file.path &&
            refreshed.additions === file.additions &&
            refreshed.deletions === file.deletions
          );
        })
      ) {
        return previous;
      }
      // Drop later slices when replacing a changed page; their cursors target the old diff.
      return { key: scopeKey, cursor, slices: [...slices.slice(0, index), next] };
    });
  }
  const refreshFirstDiffPage = useAtomRefresh(
    pullRequestEnvironment.diff({
      environmentId,
      input: { ...reference, ...(commit === null ? {} : { commit }) },
    }),
  );
  const getDiffFileContents = useAtomCommand(pullRequestEnvironment.diffFileContents);

  const appliedRefreshToken = useRef(refreshToken);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a new refresh token clears loaded slices and refetches the first diff page
  useEffect(() => {
    if (appliedRefreshToken.current === refreshToken) return;
    appliedRefreshToken.current = refreshToken;
    setSliceState({ key: scopeKey, cursor: null, slices: NO_SLICES });
    // An equal refetch keeps the answer's identity, so the emptied slices refill only if the
    // applied page is forgotten too.
    setAppliedPage(null);
    refreshFirstDiffPage();
  }, [refreshToken, scopeKey, refreshFirstDiffPage]);
  const appliedBackgroundRefreshToken = useRef(backgroundRefreshToken);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a background refresh token refetches the first diff page while keeping slices
  useEffect(() => {
    if (appliedBackgroundRefreshToken.current === backgroundRefreshToken) return;
    appliedBackgroundRefreshToken.current = backgroundRefreshToken;
    // Keeping slices mounted preserves scroll; the page merge invalidates changed pages.
    setSliceState((previous) => ({ ...previous, cursor: null }));
    refreshFirstDiffPage();
  }, [backgroundRefreshToken, refreshFirstDiffPage]);

  const codeViewReveal = useCodeViewFileReveal();
  const answeredRevealNonce = useRef<number | null>(null);

  const loadDiffFiles = createPullRequestDiffFileContentsLoader(getDiffFileContents, {
    environmentId,
    reference,
    commit,
    cacheKey: `pull-request:${referenceKey}:${detail.updatedAt}:${commit ?? "all"}`,
  });
  const { parsedSlices, loadedFiles, sourceFileStats } = diffModel(
    loadedSlices,
    `pull-request:${scopeKey}:${resolvedTheme}:${ignoreWhitespace}`,
    ignoreWhitespace,
  );
  const linkAnchor = parsePullRequestAnchor(revealUrl);
  const linkFile =
    linkAnchor?.kind === "diff"
      ? loadedFiles.find((file) =>
          pullRequestDiffPathMatches(linkAnchor.digest, resolveFileDiffPath(file)),
        )
      : undefined;
  const pendingLinkPath = linkFile ? resolveFileDiffPath(linkFile) : null;
  // The linked file stays shown past the test-file filter after the link settles.
  const [revealedLink, setRevealedLink] = useState<{
    readonly scope: string;
    readonly path: string;
  } | null>(null);
  const linkPath = pendingLinkPath ?? (revealedLink?.scope === scopeKey ? revealedLink.path : null);
  const testFileCount = loadedFiles.filter((file) =>
    isTestChangedFile(resolveFileDiffPath(file)),
  ).length;
  // A requested file stays visible so a jump to a hidden test still lands.
  const files = hideTestFiles
    ? loadedFiles.filter((file) => {
        const path = resolveFileDiffPath(file);
        return path === revealRequest?.path || path === linkPath || !isTestChangedFile(path);
      })
    : loadedFiles;
  const hiddenTestFileCount = loadedFiles.length - files.length;
  const omittedFileStats = new Map(
    loadedSlices.flatMap((slice) =>
      slice.omittedFileStats.map((file) => [file.path, file] as const),
    ),
  );
  const fileTreeEntries = diffFileTreeEntries(files);

  const imageRevision = commit ?? detail.headSha;
  const rawFileUrl = sourceControlClients.find(detail.provider)?.rawFileUrl;
  const repositoryUrl = sourceControlClients.parseChangeRequestUrl(detail.url)?.link.repositoryUrl;
  // Hosts send no patch for an image, so its expanded row shows the file at this revision.
  const imagePreviewUrl = (fileDiff: FileDiffMetadata, path: string) =>
    fileDiff.hunks.length === 0 &&
    fileDiff.type !== "deleted" &&
    isWorkspaceImagePreviewPath(path) &&
    imageRevision !== undefined &&
    rawFileUrl !== undefined &&
    repositoryUrl !== undefined
      ? rawFileUrl({ repositoryUrl, sha: imageRevision, path })
      : null;

  const annotatedFiles = files.map((fileDiff) => {
    const fileKey = buildFileDiffRenderKey(fileDiff);
    const path = resolveFileDiffPath(fileDiff);
    const annotations: DiffAnnotation[] = [];
    const imageUrl = imagePreviewUrl(fileDiff, path);
    if (imageUrl !== null) {
      annotations.push({
        side: "additions",
        lineNumber: 0,
        metadata: { image: { url: imageUrl, path } },
      });
    }
    return {
      fileKey,
      fileDiff,
      annotations,
      annotationsVersion: fnv1a32(imageUrl ?? ""),
    };
  });

  const nextCursor = loadedSlices.at(-1)?.nextCursor ?? null;
  const withheldContent =
    loadedSlices.some((slice) => slice.truncated) ||
    parsedSlices.some((parsed) => parsed?.kind === "raw");
  // Keep the sentinel until all pages load; returning raw slices early would stop pagination.
  const rawSlices =
    nextCursor === null
      ? parsedSlices.flatMap((parsed) => (parsed?.kind === "raw" ? [parsed] : []))
      : [];
  const rawSlicesView =
    files.length === 0 && rawSlices.length > 0 ? (
      <div className="space-y-4 px-4 py-5">
        {rawSlices.map((slice) => (
          <div key={`${slice.reason}:${slice.text.slice(0, 64)}`} className="space-y-2">
            <p className="text-xs text-muted-foreground">{slice.reason}</p>
            <pre className="whitespace-pre-wrap break-words font-mono text-xs">{slice.text}</pre>
          </div>
        ))}
      </div>
    ) : null;
  const unstructured =
    rawSlices.length === 0 ? null : (
      <div className="space-y-4 border-t border-border/60 px-4 py-5">
        {rawSlices.map((slice) => (
          <div key={`${slice.reason}:${slice.text.slice(0, 64)}`} className="space-y-2">
            <p className="text-xs text-muted-foreground">{slice.reason}</p>
            <pre className="whitespace-pre-wrap break-words font-mono text-xs">{slice.text}</pre>
          </div>
        ))}
      </div>
    );

  const items: CodeViewDiffItem<DiffAnnotationMetadata>[] = annotatedFiles.map(
    ({ fileKey, fileDiff, annotations, annotationsVersion }) => {
      const collapsed = isFileDiffCollapsed(fileKey, effectiveFoldOverride, foldChoices);
      return {
        id: fileKey,
        type: "diff" as const,
        fileDiff,
        annotations,
        collapsed,
        version: fnv1a32(`${collapsed ? "1" : "0"}:${annotationsVersion}`),
      };
    },
  );
  const fileKeys = items.map((item) => item.id);
  const collapsedFileKeys = new Set(
    items.filter((item) => item.collapsed === true).map((item) => item.id),
  );
  const allFilesCollapsed = areAllDiffFilesCollapsed(fileKeys, collapsedFileKeys);

  // Do not re-arm the visible sentinel after failure; it would retry indefinitely.
  const canLoadNextSlice =
    nextCursor !== null &&
    nextCursor !== cursor &&
    !diffQuery.isPending &&
    diffQuery.error === null;
  const loadNextSlice = () => {
    if (nextCursor === null) return;
    setSliceState((previous) => ({ ...previous, cursor: nextCursor }));
  };
  const sentinelRef = (node: HTMLDivElement | null) => {
    if (node === null || !canLoadNextSlice) return;
    return observeIntersection(
      node,
      (entry) => {
        if (entry.isIntersecting) loadNextSlice();
      },
      { rootMargin: "240px" },
    );
  };

  const toggleFile = (fileKey: string) => {
    setFoldChoices((current) =>
      withFileDiffFold(
        current,
        fileKey,
        !isFileDiffCollapsed(fileKey, effectiveFoldOverride, current),
      ),
    );
  };

  const revealFile = (path: string, range?: SelectedLineRange) => {
    const item = items.find((candidate) => resolveFileDiffPath(candidate.fileDiff) === path);
    if (item === undefined) return;
    setFoldChoices((current) => withFileDiffFold(current, item.id, false));
    codeViewReveal.request(item.id, range);
  };

  const toggleAllFiles = () => {
    setFoldOverride(areAllDiffFilesCollapsed(fileKeys, collapsedFileKeys) ? "expanded" : "folded");
    setFoldChoices(new Map());
  };

  const orderedCommits = // GitLab preserves UTC offsets, so compare instants.
    detail.commits.toSorted(
      (left, right) => Date.parse(right.committedDate) - Date.parse(left.committedDate),
    );

  const renderCodeViewFooter = () =>
    nextCursor === null ? null : (
      <div
        ref={sentinelRef}
        className="flex items-center justify-center gap-2 py-2 text-xs text-muted-foreground"
      >
        {diffQuery.error !== null ? (
          <>
            <span>此差异的剩余部分无法加载。</span>
            <Button size="xs" variant="secondary" onClick={() => diffQuery.refresh()}>
              重试
            </Button>
          </>
        ) : diffQuery.isPending ? (
          "正在加载更多文件…"
        ) : null}
      </div>
    );

  const renderHeaderPrefix = (item: CodeViewItem<DiffAnnotationMetadata>) => {
    const collapsed = item.collapsed === true;
    return (
      <Button
        size="xs"
        icon
        variant="muted"
        aria-expanded={!collapsed}
        aria-label={collapsed ? "展开差异" : "折叠差异"}
        className="mr-1"
        onClick={(event) => {
          event.stopPropagation();
          toggleFile(item.id);
        }}
      >
        {collapsed ? (
          <ChevronRightIcon className="size-4" />
        ) : (
          <ChevronDownIcon className="size-4" />
        )}
      </Button>
    );
  };

  const renderHeaderMetadata = (item: CodeViewItem<DiffAnnotationMetadata>) => {
    if (item.type !== "diff") return null;
    let { additions, deletions } = sourceFileStats.get(item.id) ?? getDiffLineStat([item.fileDiff]);
    const path = resolveFileDiffPath(item.fileDiff);
    if (additions === 0 && deletions === 0) {
      const withheld = omittedFileStats.get(path);
      if (withheld) ({ additions, deletions } = withheld);
    }
    return (
      <PullRequestDiffStat
        additions={additions}
        deletions={deletions}
        className="font-mono text-2xs"
      />
    );
  };

  const diffViewOptions = {
    diffStyle: diffLayout === "split" ? ("split" as const) : ("unified" as const),
    lineDiffType: "none" as const,
    overflow: wordWrap ? ("wrap" as const) : ("scroll" as const),
    theme: resolveDiffThemeName(resolvedTheme),
    preferredHighlighter: PREFERRED_HIGHLIGHTER,
    themeType: resolvedTheme,
    stickyHeaders: true,
    loadDiffFiles,
    onPostRender: codeViewReveal.flush,
    // Find may repeat requests before render; only unfold, never toggle.
    onRevealSearchMatch: (item: CodeViewItem<DiffAnnotationMetadata>) =>
      setFoldChoices((current) => withFileDiffFold(current, item.id, false)),
  };

  const renderAnnotation = (...[annotation]: CodeViewAnnotationArgs<DiffAnnotationMetadata>) =>
    annotation.metadata.image ? (
      <div className="relative flex justify-center p-3 font-sans text-foreground">
        <ChatMarkdownAssetImage
          environmentId={environmentId}
          resource={{
            _tag: SOURCE_CONTROL_MEDIA_ASSET,
            cwd: detail.workspaceRoot,
            url: annotation.metadata.image.url,
            repository: detail.repository,
          }}
          alt={annotation.metadata.image.path}
        />
      </div>
    ) : null;

  const selectedCommit = orderedCommits.find((entry) => entry.oid === commit);
  const scopeLabel = selectedCommit ? selectedCommit.messageHeadline : "全部提交";
  const toolbar = (
    <div className="@container flex h-10 min-h-10 shrink-0 items-center justify-between gap-2 border-b border-border/60 bg-background px-4 text-xs text-muted-foreground">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        {orderedCommits.length > 0 ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button size="xs" variant="secondary" />}
              className="min-w-0 max-w-64"
              aria-label={`差异范围：${scopeLabel}`}
            >
              <span className="truncate">{scopeLabel}</span>
              <ChevronDownIcon className="size-3.5 shrink-0 opacity-70" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-w-[min(28rem,calc(100vw-2rem))]">
              <DropdownMenuRadioGroup
                value={commit ?? "all"}
                onValueChange={(value) => onSelectedCommitChange(value === "all" ? null : value)}
              >
                <DropdownMenuRadioItem value="all" closeOnClick>
                  <span>全部提交</span>
                </DropdownMenuRadioItem>
                {orderedCommits.slice(0, visibleCommitCount).map((entry) => (
                  <DropdownMenuRadioItem key={entry.oid} value={entry.oid} closeOnClick>
                    <span className="flex items-center gap-2">
                      <Tooltip>
                        <TooltipTrigger
                          render={<span className="min-w-0 truncate">{entry.messageHeadline}</span>}
                        />
                        <TooltipPopup side="top">{entry.messageHeadline}</TooltipPopup>
                      </Tooltip>
                      <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground">
                        {entry.oid.slice(0, 7)}
                      </span>
                    </span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
              {orderedCommits.length > visibleCommitCount ? (
                <DropdownMenuItem
                  closeOnClick={false}
                  onClick={() => setVisibleCommitCount((count) => count + COMMIT_PAGE_SIZE)}
                >
                  <span className="text-muted-foreground">
                    再显示 {orderedCommits.length - visibleCommitCount} 条
                  </span>
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        <PullRequestMetaLine>
          <span className="shrink-0 tabular-nums">
            {files.length} 文件
            {nextCursor === null ? "" : "+"}
          </span>
          {hiddenTestFileCount > 0 ? (
            <Button type="button" size="xs" variant="link" onClick={() => setHideTestFiles(false)}>
              已隐藏 {hiddenTestFileCount} 个测试文件
            </Button>
          ) : null}
          {withheldContent ? (
            <Tooltip>
              <TooltipTrigger render={<span className="flex shrink-0 items-center" />}>
                <TriangleAlertIcon
                  aria-label="此差异的一部分未显示"
                  className="size-3.5 text-warning-foreground"
                />
              </TooltipTrigger>
              <TooltipPopup side="bottom">
                托管平台未提供此差异的一部分：二进制文件，或体积过大无法内联显示的改动。
              </TooltipPopup>
            </Tooltip>
          ) : null}
        </PullRequestMetaLine>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger
              render={
                <DropdownMenuTrigger
                  render={<Button size="sm" icon variant="ghost" />}
                  className="@lg:hidden"
                  aria-label="差异选项"
                />
              }
            >
              <Settings2Icon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="top">差异选项</TooltipPopup>
          </Tooltip>
          <DropdownMenuContent align="end">
            <DropdownMenuCheckboxItem
              checked={ignoreWhitespace}
              onCheckedChange={(checked) => setIgnoreWhitespace(checked)}
            >
              隐藏空白字符改动
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={wordWrap}
              onCheckedChange={(checked) => setWordWrapOverride(checked)}
            >
              自动换行
            </DropdownMenuCheckboxItem>
            <DropdownMenuSeparator />
            <DropdownMenuRadioGroup
              value={diffLayout}
              onValueChange={(value) => {
                if (value === "stacked" || value === "split") {
                  updateClientSettings({ diffLayout: value });
                }
              }}
            >
              <DropdownMenuRadioItem value="stacked" closeOnClick>
                堆叠
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="split" closeOnClick>
                并排
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="hidden items-center gap-1 @lg:flex">
          <Tooltip>
            <TooltipTrigger
              render={
                <Toggle
                  aria-label={ignoreWhitespace ? "显示空白字符改动" : "隐藏空白字符改动"}
                  variant="ghost"
                  size="sm"
                  pressed={ignoreWhitespace}
                  onPressedChange={(pressed) => setIgnoreWhitespace(Boolean(pressed))}
                />
              }
            >
              <PilcrowIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="top">
              {ignoreWhitespace ? "显示空白字符改动" : "隐藏空白字符改动"}
            </TooltipPopup>
          </Tooltip>
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
        </div>
        {fileKeys.length > 0 ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="sm"
                  icon
                  variant="ghost"
                  aria-label={allFilesCollapsed ? "展开所有文件" : "折叠所有文件"}
                  onClick={toggleAllFiles}
                />
              }
            >
              {allFilesCollapsed ? (
                <ChevronsUpDownIcon className="size-3.5" />
              ) : (
                <ChevronsDownUpIcon className="size-3.5" />
              )}
            </TooltipTrigger>
            <TooltipPopup side="top">
              {allFilesCollapsed ? "展开所有文件" : "折叠所有文件"}
            </TooltipPopup>
          </Tooltip>
        ) : null}
        {testFileCount > 0 ? (
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
              {hideTestFiles ? "显示测试文件" : "隐藏测试文件"}
            </TooltipPopup>
          </Tooltip>
        ) : null}
        {fileKeys.length > 0 ? (
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
        ) : null}
      </div>
    </div>
  );

  // A file not loaded yet pages forward each time a slice arrives; once loaded, the viewer
  // positions it when it renders it.
  const answerReveal = useEffectEvent(() => {
    if (revealRequest === null || answeredRevealNonce.current === revealRequest.nonce) return;
    if (!items.some((item) => resolveFileDiffPath(item.fileDiff) === revealRequest.path)) {
      if (canLoadNextSlice) loadNextSlice();
      return;
    }
    answeredRevealNonce.current = revealRequest.nonce;
    revealFile(revealRequest.path);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls the code view to a requested file once loaded, or pages forward until it arrives
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- A reveal for a file not loaded yet pages forward, which sets the slice cursor.
    answerReveal();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Re-checked as pages load until the requested file arrives.
  }, [canLoadNextSlice, items, revealRequest]);
  // The store clears a settled link after this render, so one link must not reveal twice.
  const answeredLink = useRef<string | null>(null);
  const revealLink = useEffectEvent(() => {
    if (revealUrl === undefined) answeredLink.current = null;
    if (revealUrl === undefined || linkAnchor?.kind !== "diff") return;
    // The panel selects the link's commit after this tab's effects run, so the files on screen
    // can still be another commit's.
    const linkCommit = pullRequestLinkCommit(revealUrl);
    if ((detail.commits.some((entry) => entry.oid === linkCommit) ? linkCommit : null) !== commit) {
      return;
    }
    const key = `${scopeKey}:${revealUrl}`;
    if (answeredLink.current === key) return;
    if (
      !pendingLinkPath ||
      !items.some((item) => resolveFileDiffPath(item.fileDiff) === pendingLinkPath)
    ) {
      if (canLoadNextSlice) loadNextSlice();
      // Every page is loaded and none has the file.
      else if (!pendingLinkPath && loadedSlices.length > 0 && nextCursor === null) {
        answeredLink.current = key;
        onRevealSettled?.(revealUrl);
      }
      return;
    }
    answeredLink.current = key;
    setRevealedLink({ scope: scopeKey, path: pendingLinkPath });
    onRevealSettled?.(revealUrl);
    const range = linkAnchor.range;
    revealFile(
      pendingLinkPath,
      range
        ? {
            start: range.start,
            end: range.end,
            side: toViewerSide(range.side),
            endSide: toViewerSide(range.endSide),
          }
        : undefined,
    );
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pages and scrolls the virtual diff to a clicked file or line range
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- revealing unfolds the target and may request the next diff page
    revealLink();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- retries the reveal as diff pages and viewer items arrive
  }, [revealUrl, pendingLinkPath, canLoadNextSlice, items]);
  const withToolbar = (body: ReactNode) => (
    <div className="flex h-full min-h-0 flex-col">
      {toolbar}
      <div ref={scrollerRef} className="min-h-0 flex-1 overflow-auto">
        {body}
      </div>
    </div>
  );

  const term = sourceControlClients.get(detail.provider).changeRequest.singular;
  if (diffQuery.isPending && loadedSlices.length === 0) {
    return withToolbar(<DiffPanelLoadingState label={`正在加载 ${term} 差异…`} />);
  }

  if (diffQuery.error && loadedSlices.length === 0) {
    return withToolbar(
      <PullRequestDiffUnavailableState
        error={diffQuery.failure ?? diffQuery.error}
        provider={detail.provider}
        url={detail.url}
        onRetry={() => diffQuery.refresh()}
      />,
    );
  }

  if (rawSlicesView !== null) {
    return withToolbar(rawSlicesView);
  }

  if (items.length === 0 && nextCursor === null) {
    return withToolbar(
      <p className="px-4 py-5 text-sm text-muted-foreground">
        {commit === null ? `此 ${term} 没有文件改动。` : "此提交没有文件改动。"}
      </p>,
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {toolbar}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div
          className="relative min-h-0 min-w-0 flex-1"
          onWheelCapture={codeViewReveal.cancel}
          onTouchStartCapture={codeViewReveal.cancel}
          onPointerDownCapture={codeViewReveal.cancel}
          onKeyDownCapture={codeViewReveal.cancel}
          // Headers live in shadow DOM; composedPath crosses that boundary.
          onClickCapture={(event) => {
            const composedPath = event.nativeEvent.composedPath?.() ?? [];
            for (const node of composedPath) {
              if (!(node instanceof HTMLElement)) continue;
              if (node instanceof HTMLButtonElement || node instanceof HTMLAnchorElement) {
                return;
              }
              if (node.hasAttribute("data-diffs-header")) {
                const filePath = node.querySelector("[data-title]")?.textContent?.trim();
                if (filePath === undefined || filePath === "") return;
                const item = items.find(
                  (candidate) => resolveFileDiffPath(candidate.fileDiff) === filePath,
                );
                if (item !== undefined) toggleFile(item.id);
                return;
              }
            }
          }}
        >
          {/* The viewer must own its scroll element to position virtual rows within it. */}
          <StyledDiffCodeView<DiffAnnotationMetadata>
            className="@container h-full overflow-auto [scrollbar-gutter:stable]"
            containerRef={scrollerRef}
            viewerRef={codeViewReveal.attach}
            items={items}
            options={diffViewOptions}
            renderCodeViewFooter={renderCodeViewFooter}
            renderHeaderPrefix={renderHeaderPrefix}
            renderHeaderMetadata={renderHeaderMetadata}
            renderAnnotation={renderAnnotation}
            unsafeCSSExtra={REPLACE_FILE_COUNTS_CSS}
          />
        </div>
        {fileTreeOpen ? (
          <FileExplorerPane
            resizable
            storageKey="t3code:diff-file-tree-width"
            defaultWidth={320}
            defaultWidthFraction={0.4}
            minWidth={192}
            resizeLabel="调整 PR 代码文件区大小"
          >
            <DiffFileTree
              ariaLabel={`${capitalizeTerm(term)} #${detail.number} files`}
              entries={fileTreeEntries}
              onSelectFile={revealFile}
              footer={
                nextCursor === null ? null : (
                  <div className="shrink-0 border-t border-border/60 p-2">
                    <Button
                      type="button"
                      size="xs"
                      variant="secondary"
                      className="w-full"
                      disabled={diffQuery.isPending}
                      onClick={diffQuery.error !== null ? () => diffQuery.refresh() : loadNextSlice}
                    >
                      {diffQuery.error !== null
                        ? "重试"
                        : diffQuery.isPending
                          ? "正在加载更多文件…"
                          : "加载更多文件"}
                    </Button>
                  </div>
                )
              }
            />
          </FileExplorerPane>
        ) : null}
      </div>
      {unstructured}
    </div>
  );
}

export default PullRequestCodeTab;

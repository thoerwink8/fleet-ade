import {
  legacyThreadPullRequestKey,
  threadPullRequestKeyOf,
} from "@t3tools/client-runtime/thread-pull-requests";
import {
  matchComposerEnvironmentItems,
  matchComposerThreadItems,
} from "@t3tools/client-runtime/composerThreadItems";
import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";
import type {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  PullRequestListInput,
  ServerProvider,
  ThreadId,
  ThreadPullRequestLink,
} from "@t3tools/contracts";
import {
  composerPullRequestsFromLinks,
  filterComposerPullRequestMatches,
  withLinkedComposerPullRequestsFirst,
} from "@t3tools/shared/composerPullRequestMatches";
import { formatProviderSkillDisplayName } from "@t3tools/shared/inlineSkills";

import type { ComposerTrigger } from "../../composer-logic";
import type { DraftId } from "../../composerDraftStore";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { basenameOfPath } from "../../pierre-icons";
import { selectThreadRightPanelState, useRightPanelStore } from "../../rightPanelStore";
import { useClosedViewStore } from "../../closedViewStore";
import {
  buildEmptyPathQueryEntries,
  collectRecentThreadFilePaths,
  getRecentComposerPaths,
  resolveComposerPathMenuState,
} from "./composerPathSuggestions.logic";
import {
  getProviderSkillsForSlashMenu,
  getProviderSlashCommandsForSlashMenu,
} from "@t3tools/client-runtime/providerSkills";
import { searchProviderSkills } from "../../providerSkillSearch";
import { useVisibleThreadShells } from "~/state/entities";
import { useEnvironmentIdentities, useEnvironmentMachines } from "~/state/environments";
import { offersLinkedEnvironmentsAtom } from "~/state/peerLinks";
import {
  pullRequestEnvironment,
  usePullRequestList,
  type EnvironmentQueryTarget,
} from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";
import {
  useComposerPathSearch,
  useComposerRootEntries,
  useDebouncedValue,
  useThreadSearch,
} from "~/state/queries";
import {
  matchesPullRequestQuery,
  rankPullRequestMatches,
} from "../pullRequest/pullRequestList.logic";
import type { ComposerCommandItem } from "./ComposerCommandMenu";
import { matchComposerModelItems } from "./composerModelMentions";
import type { ModelEsque } from "./providerIconUtils";
import type { ProviderInstanceEntry } from "../../providerInstances";
import {
  searchSlashCommandItems,
  slashCommandItemsForPromptPosition,
} from "./composerSlashCommandSearch";

const COMPOSER_PULL_REQUEST_LIST_LIMIT = 99;
const COMPOSER_PULL_REQUEST_RESULT_LIMIT = 12;
const EMPTY_PULL_REQUEST_LIST_TARGETS: ReadonlyArray<EnvironmentQueryTarget<PullRequestListInput>> =
  [];

/** Builds the @, /, $ and # suggestion lists, running the searches each trigger needs. */
export function useComposerMenuItems({
  composerTrigger,
  environmentId,
  linkedEnvironments,
  gitCwd,
  activeThreadId,
  pullRequestProjectId,
  pullRequestRepository,
  threadPullRequests,
  sideChatAvailable,
  sideChatDisabledReason,
  freshSessionAvailable,
  compactSlashCommandAvailable,
  selectedProvider,
  selectedProviderSkills,
  selectedProviderSlashCommands,
  showSkillsInSlashMenu,
  workspaceSkillsScanning,
  questionAttachmentTarget,
  modelMentions,
}: {
  readonly composerTrigger: ComposerTrigger | null;
  readonly environmentId: EnvironmentId;
  readonly linkedEnvironments: ReadonlyMap<EnvironmentId, string>;
  readonly gitCwd: string | null;
  readonly activeThreadId: ThreadId | null;
  readonly pullRequestProjectId: ProjectId | null;
  readonly pullRequestRepository: string | null;
  readonly threadPullRequests: ReadonlyArray<ThreadPullRequestLink> | undefined;
  readonly sideChatAvailable: boolean;
  readonly sideChatDisabledReason: string | null;
  readonly freshSessionAvailable: boolean;
  readonly compactSlashCommandAvailable: boolean;
  readonly selectedProvider: ProviderDriverKind;
  readonly selectedProviderSkills: ServerProvider["skills"];
  readonly selectedProviderSlashCommands: ServerProvider["slashCommands"];
  readonly showSkillsInSlashMenu: boolean;
  readonly workspaceSkillsScanning: boolean;
  readonly questionAttachmentTarget: DraftId | null;
  readonly modelMentions: {
    readonly instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
    readonly modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  };
}) {
  // Thread mentions rank by recency as of when the composer mounted.
  const [now] = useState(() => Date.now());
  const composerTriggerKind = composerTrigger?.kind ?? null;
  const pathTriggerQuery = composerTrigger?.kind === "path" ? composerTrigger.query : "";
  const pullRequestTriggerQuery =
    composerTrigger?.kind === "pull-request" ? composerTrigger.query : "";
  const pullRequestTextQuery =
    composerTriggerKind === "pull-request" &&
    pullRequestTriggerQuery.length > 0 &&
    !/^\d+$/u.test(pullRequestTriggerQuery)
      ? pullRequestTriggerQuery
      : null;
  const debouncedPullRequestTextQuery = useDebouncedValue(pullRequestTextQuery, 180);
  const settledPullRequestTextQuery =
    pullRequestTextQuery === debouncedPullRequestTextQuery ? pullRequestTextQuery : null;
  const isPathTrigger = composerTriggerKind === "path";
  const trimmedPathQuery = pathTriggerQuery.trim();
  const isEmptyPathQuery = isPathTrigger && trimmedPathQuery.length === 0;
  const activeThreadRef =
    activeThreadId !== null ? scopeThreadRef(environmentId, activeThreadId) : null;
  const activeThreadKey = activeThreadRef ? scopedThreadKey(activeThreadRef) : null;
  const rightPanelState = useRightPanelStore((state) =>
    selectThreadRightPanelState(state.byThreadKey, activeThreadRef),
  );
  const closedViews = useClosedViewStore((state) => state.entries);
  const environmentThreadShells = useVisibleThreadShells(isPathTrigger);
  // Mounts older settled threads matching the mention, which shells may leave out.
  useThreadSearch(isPathTrigger ? [environmentId] : [], pathTriggerQuery, { titlesOnly: true });
  // The user's machines feed `@` machine matches; the catalog summary is cheap and stable.
  const environmentIdentities = useEnvironmentIdentities();
  const environmentMachines = useEnvironmentMachines();
  const offersMachines = useAtomValue(offersLinkedEnvironmentsAtom(environmentId));
  const mentionableEnvironments = environmentIdentities.map((identity) => ({
    ...identity,
    machine: environmentMachines.get(identity.environmentId) ?? ("server" as const),
  }));
  const workspaceEntries = useComposerPathSearch({
    environmentId,
    cwd: isPathTrigger && !isEmptyPathQuery ? gitCwd : null,
    query: isPathTrigger && !isEmptyPathQuery ? pathTriggerQuery : null,
  });
  const rootEntries = useComposerRootEntries({
    environmentId,
    cwd: gitCwd,
    enabled: isEmptyPathQuery,
  });

  const pullRequestListTargets =
    composerTriggerKind !== "pull-request" ||
    pullRequestProjectId === null ||
    (pullRequestTextQuery !== null && settledPullRequestTextQuery === null)
      ? EMPTY_PULL_REQUEST_LIST_TARGETS
      : [
          {
            environmentId,
            input: {
              state: "all" as const,
              projectId: pullRequestProjectId,
              limit: COMPOSER_PULL_REQUEST_LIST_LIMIT,
              ...(settledPullRequestTextQuery === null
                ? {}
                : { query: settledPullRequestTextQuery }),
            },
          },
        ];
  const pullRequestLookup = usePullRequestList(pullRequestListTargets);
  const pullRequestTriggerNumber = (() => {
    if (composerTrigger?.kind !== "pull-request" || composerTrigger.query.length === 0) {
      return null;
    }
    const number = Number(composerTrigger.query);
    return Number.isSafeInteger(number) && number > 0 ? number : null;
  })();
  const debouncedPullRequestNumber = useDebouncedValue(pullRequestTriggerNumber, 180);
  const settledPullRequestNumber =
    pullRequestTriggerNumber === debouncedPullRequestNumber ? pullRequestTriggerNumber : null;
  const recentHasExactPullRequest =
    settledPullRequestNumber !== null &&
    pullRequestLookup.data?.entries.some(
      (entry) =>
        entry.projectId === pullRequestProjectId &&
        entry.repository.trim().toLowerCase() === pullRequestRepository?.trim().toLowerCase() &&
        entry.number === settledPullRequestNumber,
    ) === true;
  const exactPullRequestLookup = useEnvironmentQuery(
    settledPullRequestNumber === null ||
      pullRequestProjectId === null ||
      pullRequestRepository === null ||
      recentHasExactPullRequest
      ? null
      : pullRequestEnvironment.detail({
          environmentId,
          input: {
            projectId: pullRequestProjectId,
            repository: pullRequestRepository,
            number: settledPullRequestNumber,
          },
        }),
  );

  const linkedPullRequests =
    pullRequestProjectId === null
      ? []
      : composerPullRequestsFromLinks(threadPullRequests ?? [], pullRequestProjectId);

  const items = ((): ComposerCommandItem[] => {
    if (!composerTrigger) return [];
    if (composerTrigger.kind === "path") {
      const activeRightPanelSurface = rightPanelState.surfaces.find(
        (surface) => surface.id === rightPanelState.activeSurfaceId,
      );
      const openSurfaces = activeRightPanelSurface
        ? [
            activeRightPanelSurface,
            ...rightPanelState.surfaces.filter(
              (surface) => surface.id !== activeRightPanelSurface.id,
            ),
          ]
        : rightPanelState.surfaces;
      const closedSurfaces = activeThreadKey
        ? closedViews.flatMap((entry) =>
            scopedThreadKey(entry.threadRef) === activeThreadKey ? [entry.surface] : [],
          )
        : [];
      const recentFilePaths = isEmptyPathQuery
        ? collectRecentThreadFilePaths({
            cwd: gitCwd,
            recentPicks: getRecentComposerPaths(environmentId, gitCwd),
            openSurfaces,
            closedSurfaces,
          })
        : [];
      const suggestedPathEntries = isEmptyPathQuery
        ? buildEmptyPathQueryEntries({
            recentFilePaths,
            rootEntries: rootEntries.entries,
          })
        : workspaceEntries.entries;
      const pathSearchTarget = isEmptyPathQuery
        ? { environmentId, cwd: gitCwd, query: "" }
        : workspaceEntries.searchedTarget;
      return [
        ...matchComposerThreadItems({
          shells: environmentThreadShells,
          environmentId,
          linkedEnvironments,
          excludeThreadId: activeThreadId,
          query: composerTrigger.query,
          now,
        }),
        // An answer to an agent's question carries thread links, not machines.
        ...(questionAttachmentTarget === null && offersMachines
          ? matchComposerEnvironmentItems({
              environments: mentionableEnvironments,
              environmentId,
              query: composerTrigger.query,
            })
          : []),
        ...matchComposerModelItems({
          instanceEntries: modelMentions.instanceEntries,
          modelOptionsByInstance: modelMentions.modelOptionsByInstance,
          query: composerTrigger.query,
        }),
        ...suggestedPathEntries.map((entry) => ({
          id: `path:${entry.kind}:${entry.path}`,
          type: "path" as const,
          path: entry.path,
          pathKind: entry.kind,
          searchTarget: pathSearchTarget,
          label: basenameOfPath(entry.path),
          description: entry.path.slice(0, Math.max(0, entry.path.lastIndexOf("/"))),
        })),
      ];
    }
    if (composerTrigger.kind === "slash-command") {
      const builtInSlashCommandItems = [
        {
          id: "slash:model",
          type: "slash-command",
          command: "model",
          label: "/model",
          description: "切换这个会话使用的回复模型",
        },
        ...(sideChatAvailable
          ? ([
              {
                id: "slash:side",
                type: "slash-command",
                command: "side",
                label: "/side",
                description: sideChatDisabledReason ?? "在新的侧聊中问一个旁支问题",
              },
              {
                id: "slash:btw",
                type: "slash-command",
                command: "btw",
                label: "/btw",
                description: sideChatDisabledReason ?? "与 /side 相同",
              },
            ] as const)
          : []),
        ...(freshSessionAvailable
          ? ([
              {
                id: "slash:clear",
                type: "slash-command",
                command: "clear",
                label: "/clear",
                description: "以全新的上下文重新开始，之前的消息仍会显示",
              },
            ] as const)
          : []),
      ] satisfies ReadonlyArray<Extract<ComposerCommandItem, { type: "slash-command" }>>;
      const slashMenuSkills = getProviderSkillsForSlashMenu(
        selectedProviderSkills,
        showSkillsInSlashMenu,
      );
      const providerSlashCommandItems = getProviderSlashCommandsForSlashMenu(
        selectedProviderSlashCommands,
        slashMenuSkills,
      ).map((command) => ({
        id: `provider-slash-command:${selectedProvider}:${command.name}`,
        type: "provider-slash-command" as const,
        provider: selectedProvider,
        command,
        label: `/${command.name}`,
        description: command.description ?? command.input?.hint ?? "运行智能体命令",
      }));
      const query = composerTrigger.query.trim().toLowerCase();
      const skillItems = slashMenuSkills.map((skill) => ({
        id: `skill:${selectedProvider}:${skill.name}`,
        type: "skill" as const,
        provider: selectedProvider,
        skill,
        label: `/skill:${skill.name}`,
        description:
          skill.shortDescription ?? skill.description ?? (skill.scope ? `${skill.scope} 技能` : ""),
      }));
      // T3's `/clear` replaces the provider's, which would clear a session T3 still treats as live.
      const visibleProviderSlashCommandItems = providerSlashCommandItems.filter(
        (item) =>
          (item.command.name !== "compact" || compactSlashCommandAvailable) &&
          (item.command.name !== "clear" || !freshSessionAvailable),
      );
      const slashCommandItems = slashCommandItemsForPromptPosition(
        [...builtInSlashCommandItems, ...visibleProviderSlashCommandItems, ...skillItems],
        composerTrigger.rangeStart === 0,
      );
      return searchSlashCommandItems(slashCommandItems, query);
    }
    if (composerTrigger.kind === "skill") {
      return searchProviderSkills(selectedProviderSkills, composerTrigger.query).map((skill) => ({
        id: `skill:${selectedProvider}:${skill.name}`,
        type: "skill" as const,
        provider: selectedProvider,
        skill,
        label: formatProviderSkillDisplayName(skill),
        description:
          skill.shortDescription ??
          skill.description ??
          (skill.scope ? `${skill.scope} 技能` : "运行智能体技能"),
      }));
    }
    if (
      composerTrigger.kind === "pull-request" &&
      pullRequestProjectId !== null &&
      pullRequestRepository !== null
    ) {
      const exactPullRequest =
        exactPullRequestLookup.data?.number === pullRequestTriggerNumber
          ? [
              {
                ...exactPullRequestLookup.data,
                // Only the host: the URL's full repository path would not match the project's selector.
                host: legacyThreadPullRequestKey(exactPullRequestLookup.data).host,
              },
            ]
          : [];
      const matches = /^\d*$/u.test(composerTrigger.query)
        ? filterComposerPullRequestMatches({
            keyOf: threadPullRequestKeyOf,
            entries: [...exactPullRequest, ...(pullRequestLookup.data?.entries ?? [])],
            linked: linkedPullRequests,
            projectId: pullRequestProjectId,
            repository: pullRequestRepository,
            query: composerTrigger.query,
            limit: COMPOSER_PULL_REQUEST_RESULT_LIMIT,
          })
        : withLinkedComposerPullRequestsFirst({
            keyOf: threadPullRequestKeyOf,
            matches: rankPullRequestMatches(
              (pullRequestLookup.data?.entries ?? []).filter((entry) => {
                if (
                  entry.projectId !== pullRequestProjectId ||
                  entry.repository.trim().toLowerCase() !==
                    pullRequestRepository.trim().toLowerCase()
                ) {
                  return false;
                }
                const provider = pullRequestLookup.data?.providers.find(
                  (candidate) => candidate.host === entry.host,
                );
                return (
                  provider?.searchesOnHost === true ||
                  matchesPullRequestQuery(entry, composerTrigger.query)
                );
              }),
              composerTrigger.query,
            ),
            linked: linkedPullRequests,
            query: composerTrigger.query,
            limit: COMPOSER_PULL_REQUEST_RESULT_LIMIT,
          });
      return matches.map((pullRequest) => ({
        id: `pull-request:${pullRequest.projectId}:${threadPullRequestKeyOf(pullRequest)}`,
        type: "pull-request",
        pullRequest: {
          number: pullRequest.number,
          title: pullRequest.title,
          url: pullRequest.url,
          headBranch: pullRequest.headBranch,
          baseBranch: pullRequest.baseBranch,
          state: pullRequest.state,
          isDraft: pullRequest.isDraft,
        },
        label: `#${pullRequest.number}`,
        description:
          pullRequest.repository.trim().toLowerCase() === pullRequestRepository.trim().toLowerCase()
            ? pullRequest.title
            : `${pullRequest.repository} · ${pullRequest.title}`,
      }));
    }
    return [];
  })();
  const pathMenuState = resolveComposerPathMenuState({
    query: pathTriggerQuery,
    isRootPending: rootEntries.isPending,
    isSearchPending: workspaceEntries.isPending,
  });
  const isLoading =
    (composerTriggerKind === "path" && pathMenuState.isLoading) ||
    ((composerTriggerKind === "skill" || composerTriggerKind === "slash-command") &&
      workspaceSkillsScanning) ||
    (composerTriggerKind === "pull-request" &&
      pullRequestProjectId !== null &&
      pullRequestRepository !== null &&
      (pullRequestLookup.isPending ||
        pullRequestTextQuery !== debouncedPullRequestTextQuery ||
        pullRequestTriggerNumber !== debouncedPullRequestNumber ||
        exactPullRequestLookup.isPending));
  const loadingState = composerTriggerKind === "path" ? pathMenuState.loadingStateText : undefined;
  const emptyState = (() => {
    if (composerTriggerKind === "skill") {
      return "未找到技能。试试输入 / 浏览智能体命令。";
    }
    if (composerTriggerKind === "pull-request") {
      if (pullRequestProjectId === null || pullRequestRepository === null) {
        return "这个项目无法使用 PR。";
      }
      if (
        pullRequestLookup.error !== null ||
        pullRequestLookup.data?.errors.some((error) => error.projectId === pullRequestProjectId)
      ) {
        return "无法读取这个项目的 PR。";
      }
      return composerTrigger?.query
        ? `没有匹配 ${composerTrigger.query} 的 PR。`
        : "这个仓库中没有 PR。";
    }
    return composerTriggerKind === "path" ? pathMenuState.emptyStateText : "没有匹配的命令。";
  })();

  return { items, isLoading, loadingState, emptyState };
}

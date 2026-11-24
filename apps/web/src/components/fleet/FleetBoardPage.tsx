import { fleetSummaryRowKey } from "@t3tools/client-runtime/state/fleet-summary";
import type { EnvironmentId, FleetSummaryRow } from "@t3tools/contracts";
import { resolveEnvironmentMachineKind } from "@t3tools/contracts";
import { Link, useNavigate, useRouter, useSearch } from "@tanstack/react-router";
import {
  ChevronDownIcon,
  MonitorIcon,
  RefreshCwIcon,
  SearchIcon,
  SlidersHorizontalIcon,
} from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { useMediaQuery } from "~/hooks/useMediaQuery";
import { useNowMinute } from "~/hooks/useNowMinute";
import { useStableCallback } from "~/hooks/useStableCallback";
import { cn } from "~/lib/utils";
import type { EnvironmentServerConfig } from "@t3tools/client-runtime/connection";
import {
  useEnvironmentIdentities,
  useEnvironments,
  usePrimaryEnvironmentId,
} from "~/state/environments";
import { useServerConfigs } from "~/state/entities";
import { useLinkedEnvironments } from "~/state/peerLinks";
import {
  useEnvironmentsWithScope,
  useEnvironmentSessionRetry,
  useEnvironmentSessionState,
} from "~/state/session";
import { useFleetSummary, useFleetSummaryRetry } from "~/state/fleetSummary";
import { AuthOrchestrationReadScope } from "@t3tools/contracts";

import { AppRouteModal, AppRouteModalClose } from "../AppRouteModal";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbText,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { Badge } from "../ui/badge";
import { Button, InlineButton } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { ScrollArea } from "../ui/scroll-area";
import { Sheet, SheetHeader, SheetPopup, SheetTitle } from "../ui/sheet";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  FLEET_BOARD_STATUSES,
  defaultFleetSource,
  disambiguateMachineNames,
  filterFleetRows,
  fleetMachineName,
  fleetStatusCounts,
  groupFleetRows,
  type FleetBoardStatus,
} from "./FleetBoard.logic";
import { FleetBoardRow } from "./FleetBoardRow";
import { FleetRowDetail } from "./FleetRowDetail";

export interface FleetSearch {
  readonly q?: string | undefined;
  readonly machine?: EnvironmentId | undefined;
  readonly repo?: string | undefined;
  readonly status?: FleetBoardStatus | undefined;
  readonly source?: EnvironmentId | undefined;
  readonly row?: string | undefined;
}

const STATUS_LABELS: Record<FleetBoardStatus, string> = {
  needsYou: "要你看",
  stuck: "卡住",
  working: "在做",
  done: "做完",
};

function useFleetSearch(): FleetSearch {
  return useSearch({ strict: false }) as FleetSearch;
}

function FleetStatusChips({
  status: selectedStatus,
  counts,
  sourceUpdating,
  offlineCount,
  onChange,
  className,
}: {
  status: FleetBoardStatus | undefined;
  counts: Readonly<Record<FleetBoardStatus, number>>;
  sourceUpdating: boolean;
  offlineCount: number;
  onChange: (status: FleetBoardStatus | undefined) => void;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      <ToggleGroup
        aria-label="按状态筛选"
        variant="default"
        value={selectedStatus === undefined ? [] : [selectedStatus]}
        onValueChange={(value) => onChange(value[0] as FleetBoardStatus | undefined)}
        className="max-sm:grid max-sm:w-full max-sm:grid-cols-2"
      >
        {FLEET_BOARD_STATUSES.map((status) => (
          <Toggle key={status} value={status} size="xs" variant="outline">
            {sourceUpdating ? <span className="text-muted-foreground">最后已知</span> : null}
            {status === "needsYou" && counts.needsYou > 0 ? (
              <Badge variant="dot-attention">
                {STATUS_LABELS[status]} {counts.needsYou}
              </Badge>
            ) : (
              <>
                {STATUS_LABELS[status]}
                {status !== "done" ? (
                  <span className="text-muted-foreground tabular-nums">{counts[status]}</span>
                ) : null}
              </>
            )}
          </Toggle>
        ))}
      </ToggleGroup>
      {offlineCount > 0 ? (
        <span className="text-xs text-muted-foreground tabular-nums">含失联 {offlineCount} 条</span>
      ) : null}
    </div>
  );
}

function FleetMachineFilter({
  label,
  emptyLabel,
  options,
  optionName,
  onSelect,
}: {
  label: string;
  emptyLabel: string;
  options: readonly string[];
  optionName: (option: string) => string;
  onSelect: (option: string | undefined) => void;
}) {
  return (
    <Menu>
      <MenuTrigger render={<InlineButton tone="muted" />} className="min-w-0">
        <WorkspaceBreadcrumbText>{label}</WorkspaceBreadcrumbText>
        <ChevronDownIcon aria-hidden className="size-3.5 shrink-0 opacity-60" />
      </MenuTrigger>
      <MenuPopup align="start">
        <MenuItem onClick={() => onSelect(undefined)}>{emptyLabel}</MenuItem>
        <MenuSeparator />
        {options.map((option) => (
          <MenuItem key={option} onClick={() => onSelect(option)}>
            {optionName(option)}
          </MenuItem>
        ))}
        {options.length === 0 ? (
          <p className="px-2 py-2 text-xs text-muted-foreground">还没有电脑记过活。</p>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}

function FleetSourcePicker({
  sourceName,
  candidates,
  machineName,
  selected,
  onSelect,
}: {
  sourceName: string;
  candidates: readonly EnvironmentId[];
  machineName: (environmentId: EnvironmentId) => string;
  selected: EnvironmentId | null;
  onSelect: (environmentId: EnvironmentId | undefined) => void;
}) {
  if (candidates.length <= 1) {
    return <span className="text-muted-foreground">{sourceName}</span>;
  }
  return (
    <Menu>
      <MenuTrigger render={<InlineButton tone="muted" />} className="min-w-0">
        <span className="truncate">{sourceName}</span>
        <ChevronDownIcon aria-hidden className="size-3 shrink-0 opacity-60" />
      </MenuTrigger>
      <MenuPopup align="start">
        <MenuItem onClick={() => onSelect(undefined)}>默认</MenuItem>
        <MenuSeparator />
        {candidates.map((environmentId) => (
          <MenuItem key={environmentId} onClick={() => onSelect(environmentId)}>
            <span className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 flex-1 truncate">{machineName(environmentId)}</span>
              {environmentId === selected ? (
                <span className="shrink-0 text-xs text-muted-foreground">当前</span>
              ) : null}
            </span>
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}

function FleetBoardEmpty({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <Empty size="compact-prose">
      <EmptyHeader>
        <EmptyMedia variant="icon">{icon}</EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        {description !== undefined ? <EmptyDescription>{description}</EmptyDescription> : null}
      </EmptyHeader>
      {action}
    </Empty>
  );
}

export function FleetBoardPage() {
  const search = useFleetSearch();
  const filterStatus = search.status;
  const router = useRouter();
  const navigate = useNavigate();
  const isMobile = useMediaQuery("max-sm");
  const nowMinute = useNowMinute();
  // minuteTick is a UTC ISO prefix ("YYYY-MM-DDTHH:mm"); appending :00Z keeps
  // Date.parse from reading it as local time.
  const now = Date.parse(`${nowMinute}:00Z`);

  const { environments } = useEnvironments();
  const connectedIds = new Set(
    environments
      .filter((environment) => environment.connection.phase === "connected")
      .map((environment) => environment.environmentId),
  );
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const readableIds = useEnvironmentsWithScope(environments, AuthOrchestrationReadScope);
  const fleetSourceCandidates = environments
    .filter((environment) => readableIds.has(environment.environmentId))
    .map((environment) => environment.environmentId);
  const sourceEnvironmentId = defaultFleetSource(
    search.source ?? primaryEnvironmentId,
    fleetSourceCandidates,
  );
  const sourceEnvironment =
    sourceEnvironmentId === null
      ? null
      : (environments.find((environment) => environment.environmentId === sourceEnvironmentId) ??
        null);
  const sourcePhase = sourceEnvironment?.connection.phase ?? null;
  const sourceConnected = sourcePhase === "connected";
  const fallbackSourceId =
    sourceEnvironmentId ??
    (search.source !== undefined &&
    environments.some((environment) => environment.environmentId === search.source)
      ? search.source
      : (primaryEnvironmentId ?? environments[0]?.environmentId ?? null));
  const fallbackEnvironment =
    fallbackSourceId === null
      ? null
      : (environments.find((environment) => environment.environmentId === fallbackSourceId) ??
        null);
  const fallbackPhase = fallbackEnvironment?.connection.phase ?? null;
  const fallbackSession = useEnvironmentSessionState(fallbackSourceId);
  const missingReadScopeError =
    fallbackPhase === "error" &&
    (fallbackEnvironment?.connection.error?.includes(AuthOrchestrationReadScope) ?? false);
  const fallbackActivePhase =
    fallbackPhase === "connecting" ||
    fallbackPhase === "reconnecting" ||
    fallbackPhase === "connected";
  const scopeLoading =
    environments.length > 0 &&
    fleetSourceCandidates.length === 0 &&
    fallbackActivePhase &&
    fallbackSession.data === null &&
    !fallbackSession.hasError &&
    !missingReadScopeError;
  const summary = useFleetSummary(sourceEnvironmentId);
  const sessionReadError =
    environments.length > 0 && fleetSourceCandidates.length === 0 && fallbackSession.hasError;
  const sourceDisconnected =
    environments.length > 0 &&
    !scopeLoading &&
    !missingReadScopeError &&
    !sessionReadError &&
    (sourceEnvironmentId === null
      ? !fallbackActivePhase
      : !sourceConnected && sourcePhase !== "connecting" && sourcePhase !== "reconnecting");
  const summaryForbidden =
    summary.error === "forbidden" ||
    missingReadScopeError ||
    (environments.length > 0 &&
      !scopeLoading &&
      !sessionReadError &&
      !sourceDisconnected &&
      fleetSourceCandidates.length === 0);
  const retry = useFleetSummaryRetry(sourceEnvironmentId);
  const retrySession = useEnvironmentSessionRetry(fallbackSourceId);
  const [retryPending, setRetryPending] = useState(false);
  const [doneOpenIds, setDoneOpenIds] = useState<ReadonlySet<string>>(new Set());
  const [doneLimit, setDoneLimit] = useState(50);
  const [filtersOpen, setFiltersOpen] = useState(false);

  const linkedNames = useLinkedEnvironments(sourceEnvironmentId);
  const identities = useEnvironmentIdentities();
  const serverConfigs = useServerConfigs();
  const directory = new Map(identities.map((identity) => [identity.environmentId, identity.label]));
  const allRows = [...summary.rows.values()];
  const machineIds = [...new Set(allRows.map((row) => row.environmentId))];
  const knownMachineIds = [
    ...new Set([
      ...environments.map((environment) => environment.environmentId as string),
      ...machineIds,
    ]),
  ];
  const disambiguatedNames = disambiguateMachineNames(knownMachineIds, (environmentId) =>
    fleetMachineName(environmentId, linkedNames, directory),
  );
  const machineName = (environmentId: string) =>
    disambiguatedNames.get(environmentId) ??
    fleetMachineName(environmentId, linkedNames, directory);
  const displaySourceId = sourceEnvironmentId ?? fallbackSourceId;
  const sourceName =
    displaySourceId === null ? "这台电脑" : (directory.get(displaySourceId) ?? "这台电脑");
  const repoNames = [
    ...new Set(allRows.flatMap((row) => (row.repo === undefined ? [] : [row.repo]))),
  ].sort((a, b) => a.localeCompare(b));

  const scopedRows = filterFleetRows(allRows, {
    machine: search.machine,
    repo: search.repo,
    search: search.q,
  });
  const statusCounts = fleetStatusCounts(scopedRows);
  const offlineCount = statusCounts.offline;
  const visibleRows =
    filterStatus === undefined ? scopedRows : filterFleetRows(scopedRows, { status: filterStatus });
  const groups = groupFleetRows(visibleRows, machineName);
  const activeRows = new Map<string, { done: FleetSummaryRow[]; active: FleetSummaryRow[] }>();
  for (const group of groups) {
    activeRows.set(group.environmentId, {
      done: group.rows.filter((row) => row.phase === "done" && !row.needsYou),
      active: group.rows.filter((row) => row.phase !== "done" || row.needsYou),
    });
  }

  const patchSearch = (patch: Partial<FleetSearch>, replace = false) =>
    navigate({
      to: "/fleet",
      search: (previous: Record<string, unknown>) => ({ ...previous, ...patch }),
      replace,
    });

  const machineLabel = search.machine === undefined ? "所有电脑" : machineName(search.machine);
  const activeFilterCount =
    (filterStatus !== undefined ? 1 : 0) +
    (search.machine !== undefined ? 1 : 0) +
    (search.repo !== undefined ? 1 : 0);
  const selectedRow = search.row === undefined ? null : (summary.rows.get(search.row) ?? null);
  const selectedMachineName = selectedRow === null ? "" : machineName(selectedRow.environmentId);
  const selectedMachineConnected =
    selectedRow !== null && connectedIds.has(selectedRow.environmentId as EnvironmentId);

  const machineFilterVisible = machineIds.length >= 2 || search.machine !== undefined;
  const repoFilterVisible = repoNames.length >= 2 || search.repo !== undefined;

  const machineFilter = machineFilterVisible ? (
    <FleetMachineFilter
      label={machineLabel}
      emptyLabel="所有电脑"
      options={machineIds}
      optionName={machineName}
      onSelect={(environmentId) =>
        patchSearch({ machine: environmentId as EnvironmentId | undefined })
      }
    />
  ) : null;
  const repoFilter = repoFilterVisible ? (
    <FleetMachineFilter
      label={search.repo ?? "所有仓库"}
      emptyLabel="所有仓库"
      options={repoNames}
      optionName={(repo) => repo}
      onSelect={(repo) => patchSearch({ repo })}
    />
  ) : null;
  const statusChips = (
    <FleetStatusChips
      status={filterStatus}
      counts={statusCounts}
      sourceUpdating={
        sourceEnvironmentId !== null &&
        (!sourceConnected || summary.status === "updating") &&
        summary.status !== "error"
      }
      offlineCount={offlineCount}
      onChange={(status) => patchSearch({ status })}
    />
  );
  const clearFilters = (
    <Button
      variant="ghost-muted"
      size="sm"
      onClick={() => {
        patchSearch({ q: undefined, status: undefined, machine: undefined, repo: undefined });
        setFiltersOpen(false);
      }}
    >
      清除筛选
    </Button>
  );

  const containerRef = useRef<HTMLDivElement | null>(null);
  const openedRowInSessionRef = useRef(false);
  const handleOpenRow = useStableCallback((selectedKey: string) => {
    openedRowInSessionRef.current = true;
    void patchSearch({ row: selectedKey });
  });
  const handleCloseDetail = () => {
    const key = search.row;
    if (openedRowInSessionRef.current) {
      openedRowInSessionRef.current = false;
      router.history.back();
    } else {
      void patchSearch({ row: undefined }, true);
    }
    if (key !== undefined) {
      queueMicrotask(() => {
        const container = containerRef.current;
        if (container === null) return;
        const buttons = container.querySelectorAll<HTMLButtonElement>("button[data-fleet-row]");
        for (const button of buttons) {
          if (button.dataset.fleetRow === key) {
            button.focus();
            break;
          }
        }
      });
    }
  };

  return (
    <AppRouteModal label="机群">
      <div ref={containerRef} className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex min-h-12 shrink-0 items-center gap-2 border-b ps-5 pe-2">
          <WorkspaceBreadcrumb ariaLabel="机群导航" className="min-w-0 flex-1">
            <WorkspaceBreadcrumbItem current>
              <h1>机群</h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
          <AppRouteModalClose />
        </header>

        <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b px-5 py-2 text-xs text-muted-foreground">
          <span className="flex min-w-0 items-center gap-1">
            汇总来自：
            <FleetSourcePicker
              sourceName={sourceName}
              candidates={fleetSourceCandidates}
              machineName={machineName}
              selected={sourceEnvironmentId}
              onSelect={(environmentId) => patchSearch({ source: environmentId })}
            />
          </span>
          <span className="min-w-0">（只含这台电脑记下的活）</span>
          {environments.length === 0 ? null : summary.status === "live" && sourceConnected ? (
            <Badge variant="success">已连接</Badge>
          ) : summary.status === "error" || summaryForbidden || sessionReadError ? (
            <Badge variant="error">读不到</Badge>
          ) : sourceDisconnected ? (
            <Badge variant="warning">连不上</Badge>
          ) : summary.status === "loading" || scopeLoading ? (
            <Badge variant="secondary">正在读取</Badge>
          ) : (
            <Badge variant="warning">旧数据 · 正在更新</Badge>
          )}
        </div>

        {allRows.length > 0 ||
        (environments.length > 0 &&
          !summaryForbidden &&
          !sessionReadError &&
          !sourceDisconnected &&
          summary.status !== "error") ? (
          <>
            <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-5 py-2">
              <InputGroup className="min-w-0 flex-1 **:[input]:h-9 sm:**:[input]:h-8 sm:min-w-44 sm:max-w-72">
                <InputGroupAddon>
                  <SearchIcon aria-hidden />
                </InputGroupAddon>
                <InputGroupInput
                  type="search"
                  value={search.q ?? ""}
                  onChange={(event) =>
                    patchSearch({ q: event.currentTarget.value || undefined }, true)
                  }
                  placeholder="搜索标题或 # 单号"
                  aria-label="搜索机群任务"
                />
              </InputGroup>
              {isMobile ? (
                machineFilterVisible || repoFilterVisible || activeFilterCount > 0 ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setFiltersOpen(true)}
                    aria-label="筛选"
                  >
                    <SlidersHorizontalIcon aria-hidden />
                    筛选{activeFilterCount > 0 ? ` ${activeFilterCount}` : ""}
                  </Button>
                ) : null
              ) : (
                <>
                  {statusChips}
                  {machineFilter}
                  {repoFilter}
                </>
              )}
            </div>

            {isMobile ? (
              <div className="flex shrink-0 border-b px-5 py-2">{statusChips}</div>
            ) : null}
          </>
        ) : null}

        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="wide">
            {allRows.length === 0 && environments.length === 0 ? (
              <FleetBoardEmpty
                icon={<MonitorIcon />}
                title="还没有连上的电脑"
                description="连上一台运行 Fleet ADE 的电脑后，这里会汇总它记下的各台电脑的活。"
                action={
                  <Button variant="outline" size="sm" render={<Link to="/settings/connections" />}>
                    去连接
                  </Button>
                }
              />
            ) : allRows.length === 0 && scopeLoading ? (
              <FleetBoardEmpty
                icon={<MonitorIcon />}
                title="正在读取"
                description="第一次读取要等这台电脑把它记下的活送过来。"
              />
            ) : allRows.length === 0 && summaryForbidden ? (
              <FleetBoardEmpty
                icon={<MonitorIcon />}
                title="这个连接没有读取会话的权限，看不到机群汇总"
                action={
                  <Button variant="outline" size="sm" render={<Link to="/settings/connections" />}>
                    去设置
                  </Button>
                }
              />
            ) : allRows.length === 0 && sourceDisconnected ? (
              <FleetBoardEmpty
                icon={<MonitorIcon />}
                title={`汇总电脑 ${sourceName} 连不上`}
                description="连上这台电脑后，这里会显示它记下的各台电脑的活。"
                action={
                  <Button variant="outline" size="sm" render={<Link to="/settings/connections" />}>
                    去连接
                  </Button>
                }
              />
            ) : allRows.length === 0 && (summary.status === "error" || sessionReadError) ? (
              <FleetBoardEmpty
                icon={<MonitorIcon />}
                title="读不到机群汇总"
                description="汇总读取失败，电脑恢复后重试。"
                action={
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={retryPending}
                    onClick={() => {
                      setRetryPending(true);
                      void Promise.resolve(sessionReadError ? retrySession() : retry()).finally(
                        () => setRetryPending(false),
                      );
                    }}
                  >
                    <RefreshCwIcon aria-hidden />
                    重试
                  </Button>
                }
              />
            ) : summary.status === "loading" && allRows.length === 0 ? (
              <FleetBoardEmpty
                icon={<MonitorIcon />}
                title="正在读取"
                description="第一次读取要等这台电脑把它记下的活送过来。"
              />
            ) : allRows.length === 0 ? (
              <FleetBoardEmpty
                icon={<MonitorIcon />}
                title="这台汇总电脑上没有在跑或 24 小时内做完的活"
              />
            ) : groups.length === 0 ? (
              <FleetBoardEmpty icon={<SearchIcon />} title="没有符合筛选的" action={clearFilters} />
            ) : (
              <div className="flex flex-col gap-6">
                {groups.map((group) => {
                  const rows = activeRows.get(group.environmentId) ?? { done: [], active: [] };
                  const open = doneOpenIds.has(group.environmentId);
                  const visibleDone = open ? rows.done.slice(0, doneLimit) : [];
                  return (
                    <section
                      key={group.environmentId}
                      aria-label={group.name}
                      className="flex min-w-0 flex-col"
                    >
                      <div className="flex items-center gap-2 px-2 text-meta font-medium text-secondary-label">
                        <MachineIcon
                          serverConfig={serverConfigs.get(group.environmentId as EnvironmentId)}
                        />
                        <span className="min-w-0 truncate">{group.name}</span>
                        <span className="h-px min-w-2 flex-1 bg-sidebar-border/50" aria-hidden />
                        <span className="flex shrink-0 items-center gap-2 font-normal text-muted-foreground tabular-nums">
                          {FLEET_BOARD_STATUSES.map((status) =>
                            status !== "done" && group.counts[status] > 0 ? (
                              <span key={status}>
                                {STATUS_LABELS[status]} {group.counts[status]}
                              </span>
                            ) : null,
                          )}
                        </span>
                        {group.counts.offline > 0 ? (
                          <Badge variant="warning" title="连不上">
                            连不上
                          </Badge>
                        ) : null}
                      </div>
                      <div className="mt-1 flex flex-col">
                        {rows.active.map((row) => {
                          const key = fleetSummaryRowKey(row);
                          return (
                            <FleetBoardRow
                              key={key}
                              row={row}
                              machineName={machineName(row.environmentId)}
                              machineConnected={connectedIds.has(
                                row.environmentId as EnvironmentId,
                              )}
                              now={now}
                              selected={search.row === key}
                              onSelect={handleOpenRow}
                            />
                          );
                        })}
                      </div>
                      {rows.done.length > 0 ? (
                        <Collapsible
                          open={open}
                          onOpenChange={(nextOpen) => {
                            const next = new Set(doneOpenIds);
                            if (nextOpen) next.add(group.environmentId);
                            else next.delete(group.environmentId);
                            setDoneOpenIds(next);
                          }}
                        >
                          <CollapsibleTrigger className="mt-1 flex w-full items-center gap-2 rounded-md px-2 text-meta text-muted-foreground hover:text-foreground">
                            <ChevronDownIcon
                              aria-hidden
                              className={cn(
                                "size-3 shrink-0 transition-transform",
                                !open && "-rotate-90",
                              )}
                            />
                            做完 {rows.done.length}
                          </CollapsibleTrigger>
                          <CollapsiblePanel>
                            <div className="flex flex-col">
                              {visibleDone.map((row) => {
                                const key = fleetSummaryRowKey(row);
                                return (
                                  <FleetBoardRow
                                    key={key}
                                    row={row}
                                    machineName={machineName(row.environmentId)}
                                    machineConnected={connectedIds.has(
                                      row.environmentId as EnvironmentId,
                                    )}
                                    now={now}
                                    selected={search.row === key}
                                    onSelect={handleOpenRow}
                                  />
                                );
                              })}
                              {open && rows.done.length > visibleDone.length ? (
                                <Button
                                  variant="ghost-muted"
                                  size="sm"
                                  className="self-start"
                                  onClick={() => setDoneLimit((limit) => limit + 50)}
                                >
                                  再显示 50 条
                                </Button>
                              ) : null}
                            </div>
                          </CollapsiblePanel>
                        </Collapsible>
                      ) : null}
                    </section>
                  );
                })}
              </div>
            )}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>

      <FleetRowDetail
        row={selectedRow}
        machineName={selectedMachineName}
        machineConnected={selectedMachineConnected}
        isMobile={isMobile}
        now={now}
        onClose={handleCloseDetail}
      />

      <Sheet open={filtersOpen} onOpenChange={setFiltersOpen}>
        <SheetPopup side="bottom" layer="nested" aria-label="筛选机群">
          <SheetHeader>
            <SheetTitle>筛选</SheetTitle>
          </SheetHeader>
          <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-6 pb-8">
            {machineFilter !== null ? (
              <section className="flex flex-col gap-2">
                <p className="text-xs text-muted-foreground">电脑</p>
                {machineFilter}
              </section>
            ) : null}
            {repoFilter !== null ? (
              <section className="flex flex-col gap-2">
                <p className="text-xs text-muted-foreground">仓库</p>
                {repoFilter}
              </section>
            ) : null}
            {activeFilterCount > 0 ? clearFilters : null}
          </div>
        </SheetPopup>
      </Sheet>
    </AppRouteModal>
  );
}

function MachineIcon({ serverConfig }: { serverConfig: EnvironmentServerConfig | undefined }) {
  if (serverConfig === undefined) {
    return <MonitorIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />;
  }
  return (
    <EnvironmentMachineIcon
      aria-hidden
      kind={resolveEnvironmentMachineKind(serverConfig)}
      className="size-3.5 shrink-0 text-muted-foreground"
    />
  );
}

import { isListedThreadLineage, isWebhookDedupeTemplate } from "@t3tools/contracts";
import {
  EnvironmentId,
  MAX_WEBHOOK_DELIVERY_AGE_MINUTES,
  MIN_SCHEDULED_TASK_INTERVAL_MS,
  type ProjectId,
  ScheduledTaskId,
  type ScheduledTask,
  type ScheduledTaskSchedule,
  type ScheduledTaskThreadMode,
  type ScheduledTaskUpsertSchedule,
  scheduledTaskThreadMode,
  type ModelSelection,
  type RuntimeMode,
  type ProviderInteractionMode,
  type ServerSettings,
  type ThreadId,
} from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  parseMaxDeliveryAge,
  parseWebhookFilterDrafts,
  webhookFilterDrafts,
  webhookFilterDraftsChanged,
  type WebhookFilterDraft,
} from "@t3tools/client-runtime/scheduled-task-webhook";
import { scheduleTimeZoneLabel } from "@t3tools/client-runtime/scheduled-task-time-zone";

import {
  resolveProjectSettings,
  type LegacyProjectSettingsFields,
} from "@t3tools/shared/projectSettings";
import type { ProviderInstanceEntry } from "../../providerInstances";

import type { ResolvedSettingsScope } from "./settingsScope";

export const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

const ONCE_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  dateStyle: "medium",
  timeStyle: "short",
});

export function scheduleLabel(
  schedule: ScheduledTaskSchedule,
  timeZone?: string,
  runAt?: string | null,
): string {
  if (schedule.type === "webhook") return "收到 webhook 时";
  if (schedule.type === "once") return `单次，${ONCE_FORMATTER.format(new Date(schedule.runAt))}`;
  if (schedule.type === "interval") {
    const minutes = schedule.everyMs / 60_000;
    return Number.isInteger(minutes)
      ? `每 ${minutes} 分钟`
      : `每 ${Math.round(schedule.everyMs / 1000)} 秒`;
  }
  const weekdays = schedule.weekdays ?? [];
  const days =
    weekdays.length === 0
      ? "Daily"
      : weekdays.length === 5 && weekdays.every((day) => day >= 1 && day <= 5)
        ? "Weekdays"
        : weekdays.map((day) => WEEKDAY_LABELS[day]).join(", ");
  const zone = scheduleTimeZoneLabel(timeZone, runAt);
  return `${days} at ${schedule.timeOfDay}${zone === undefined ? "" : ` ${zone}`}`;
}

export function matchesScheduledTaskScope(
  scope: ResolvedSettingsScope,
  environmentId: EnvironmentId,
  projectId: ProjectId,
): boolean {
  if (scope.kind === "unavailable" || !scope.environmentIds.includes(environmentId)) return false;
  if (scope.kind === "project" || scope.kind === "checkout") {
    return scope.members.some(
      (member) => member.environmentId === environmentId && member.id === projectId,
    );
  }
  return true;
}

export function validateScheduledTasksSearch(raw: Record<string, unknown>) {
  return {
    ...(typeof raw.environmentId === "string" && raw.environmentId.trim()
      ? { environmentId: EnvironmentId.make(raw.environmentId) }
      : {}),
    ...(typeof raw.taskId === "string" && raw.taskId.trim()
      ? { taskId: ScheduledTaskId.make(raw.taskId) }
      : {}),
  };
}

export type ScheduleMode = "fixed" | "once" | "interval" | "webhook";
export type WorkspaceMode = "root" | "worktree" | "existing_worktree";

export interface DraftState {
  readonly editingId: string | null;
  readonly title: string;
  readonly prompt: string;
  readonly enabled: boolean;
  readonly scheduleMode: ScheduleMode;
  readonly intervalMinutes: string;
  readonly timeOfDay: string;
  /** Local date and time as a `datetime-local` input value, such as 2026-11-02T15:00. */
  readonly runAt: string;
  /** The stored ISO run time, sent back unchanged when the field was not edited. */
  readonly savedRunAt: string;
  readonly weekdays: ReadonlySet<number>;
  readonly projectId: string;
  readonly threadId: string;
  readonly threadMode: ScheduledTaskThreadMode;
  readonly workspaceMode: WorkspaceMode;
  readonly baseRef: string;
  readonly startFromOrigin: boolean;
  readonly existingWorktreePath: string;
  readonly modelKey: string;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  /** Retain the source selection's provider options when the picker leaves instanceId:model unchanged. */
  readonly baseModelSelection: ModelSelection | null;
  readonly signatureEnabled: boolean;
  readonly signatureHeader: string;
  readonly signatureEncoding: "hex" | "base64";
  readonly signaturePrefix: string;
  /** Write-only: empty keeps the secret already stored on the server. */
  readonly signatureSecret: string;
  readonly maxDeliveryAgeMinutes: string;
  readonly replayKey: string;
  readonly coalesceKey: string;
  readonly coalesceWindowSeconds: string;
  readonly filters: ReadonlyArray<WebhookFilterDraft>;
  /** The filter rows the form opened with. */
  readonly savedFilters: ReadonlyArray<WebhookFilterDraft>;
}

export const WEBHOOK_SIGNATURE_DEFAULTS = {
  signatureHeader: "x-hub-signature-256",
  signatureEncoding: "hex",
  signaturePrefix: "sha256=",
} as const;

/** Formats a date as a `datetime-local` input value in the browser's time zone. */
export function toDateTimeLocalValue(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function scheduleDraftErrors(draft: DraftState) {
  if (draft.scheduleMode === "once") {
    const runAt = new Date(draft.runAt);
    if (Number.isNaN(runAt.getTime()))
      return [{ title: "运行时间无效", description: "请选择日期和时间。" }];
    // A time skipped by a daylight saving change parses to a different clock time.
    if (toDateTimeLocalValue(runAt) !== draft.runAt)
      return [{ title: "运行时间无效", description: "你所在的时区不存在这个时间。" }];
    return [];
  }
  if (draft.scheduleMode !== "webhook") return [];
  if (parseMaxDeliveryAge(draft.maxDeliveryAgeMinutes) === undefined)
    return [
      {
        title: "请求时效限制无效",
        description: `请输入 1 到 ${MAX_WEBHOOK_DELIVERY_AGE_MINUTES} 之间的整数分钟数，或留空。`,
      },
    ];
  const errors: Array<{ title: string; description: string }> = [];
  for (const [label, value] of [
    ["重复请求键", draft.replayKey],
    ["合并键", draft.coalesceKey],
  ] as const) {
    if (value.trim() && !isWebhookDedupeTemplate(value.trim()))
      errors.push({
        title: "webhook 设置无效",
        description: `${label} 必须包含有效的请求占位符。`,
      });
  }
  const window = draft.coalesceWindowSeconds.trim();
  if (window && (!Number.isInteger(Number(window)) || Number(window) < 10 || Number(window) > 3600))
    errors.push({
      title: "webhook 设置无效",
      description: "合并窗口必须是 10 到 3600 之间的整数秒。",
    });
  return errors;
}

export function webhookDeliveryLabel(delivery: {
  readonly outcome: string;
  readonly pendingWindow?: boolean | undefined;
}) {
  if (delivery.outcome === "accepted") return delivery.pendingWindow ? "已开始合并窗口" : "已运行";
  const labels: Record<string, string> = {
    dispatch_failed: "运行失败",
    duplicate: "重复",
    coalesced: "已合并",
    filtered: "已过滤",
    rejected_signature: "签名无效",
    disabled: "任务已暂停",
    rate_limited: "已限流",
    expired: "已过期",
  };
  return labels[delivery.outcome] ?? delivery.outcome.replaceAll("_", " ");
}

export function scheduleFromDraft(draft: DraftState): ScheduledTaskUpsertSchedule | null {
  if (scheduleDraftErrors(draft).length > 0) return null;
  if (draft.scheduleMode === "once") {
    const saved = draft.savedRunAt ? new Date(draft.savedRunAt) : null;
    if (saved !== null && toDateTimeLocalValue(saved) === draft.runAt)
      return { type: "once", runAt: draft.savedRunAt };
    // A `datetime-local` value has no offset. In an hour that repeats when clocks go
    // back, keep the saved time's offset; otherwise Date reads it as local time.
    const withSavedOffset =
      saved === null
        ? null
        : new Date(Date.parse(`${draft.runAt}Z`) + saved.getTimezoneOffset() * 60_000);
    return {
      type: "once",
      runAt:
        withSavedOffset !== null && toDateTimeLocalValue(withSavedOffset) === draft.runAt
          ? withSavedOffset.toISOString()
          : new Date(draft.runAt).toISOString(),
    };
  }
  if (draft.scheduleMode === "webhook") {
    const maxDeliveryAgeMinutes = parseMaxDeliveryAge(draft.maxDeliveryAgeMinutes);
    const replayKey = draft.replayKey.trim();
    const coalesceKey = draft.coalesceKey.trim();
    const coalesceWindowSeconds = draft.coalesceWindowSeconds.trim()
      ? Number(draft.coalesceWindowSeconds)
      : undefined;
    if (maxDeliveryAgeMinutes === undefined) return null;
    const parsedFilters = parseWebhookFilterDrafts(draft.filters);
    if (!("filters" in parsedFilters)) return null;
    const secret = draft.signatureSecret.trim();
    return {
      type: "webhook",
      signature: draft.signatureEnabled
        ? {
            header: draft.signatureHeader.trim(),
            encoding: draft.signatureEncoding,
            prefix: draft.signaturePrefix,
            ...(secret ? { secret } : {}),
          }
        : null,
      maxDeliveryAgeMinutes,
      ...(replayKey || coalesceKey || coalesceWindowSeconds !== undefined
        ? {
            dedupe: {
              ...(replayKey ? { replayKey } : {}),
              ...(coalesceKey ? { coalesceKey } : {}),
              ...(coalesceWindowSeconds === undefined ? {} : { coalesceWindowSeconds }),
            },
          }
        : { dedupe: {} }),
      // Only edited filters are sent; the server keeps the stored ones otherwise.
      ...(webhookFilterDraftsChanged(draft.savedFilters, draft.filters)
        ? { filters: parsedFilters.filters }
        : {}),
    };
  }
  if (draft.scheduleMode === "interval") {
    const everyMs = Math.round(Number(draft.intervalMinutes) * 60_000);
    return { type: "interval", everyMs };
  }
  const selectedEveryDay = draft.weekdays.size === 0 || draft.weekdays.size === 7;
  return {
    type: "fixed_time",
    timeOfDay: draft.timeOfDay || "09:00",
    ...(selectedEveryDay ? {} : { weekdays: [...draft.weekdays].toSorted() }),
  };
}

export function taskToDraft(task: ScheduledTask): DraftState {
  const schedule = task.schedule;
  const filters = webhookFilterDrafts(schedule.type === "webhook" ? schedule.filters : undefined);
  const weekdays =
    schedule.type === "fixed_time" && schedule.weekdays && schedule.weekdays.length > 0
      ? new Set(schedule.weekdays)
      : new Set([0, 1, 2, 3, 4, 5, 6]);
  return {
    editingId: task.id,
    title: task.title,
    prompt: task.prompt,
    enabled: task.enabled,
    scheduleMode: schedule.type === "fixed_time" ? "fixed" : schedule.type,
    intervalMinutes:
      schedule.type === "interval" ? String(Math.max(1, schedule.everyMs / 60_000)) : "15",
    // A time input shows nothing for an unpadded hour such as 9:05, which agents may save.
    timeOfDay: schedule.type === "fixed_time" ? schedule.timeOfDay.padStart(5, "0") : "09:00",
    runAt: schedule.type === "once" ? toDateTimeLocalValue(new Date(schedule.runAt)) : "",
    savedRunAt: schedule.type === "once" ? schedule.runAt : "",
    weekdays,
    projectId: task.projectId,
    threadId: task.threadId ?? "",
    threadMode: scheduledTaskThreadMode(task),
    workspaceMode: task.workspaceStrategy.type,
    baseRef: task.workspaceStrategy.type === "worktree" ? task.workspaceStrategy.baseRef : "main",
    startFromOrigin:
      task.workspaceStrategy.type === "worktree"
        ? (task.workspaceStrategy.startFromOrigin ?? false)
        : true,
    existingWorktreePath:
      task.workspaceStrategy.type === "existing_worktree"
        ? task.workspaceStrategy.worktreePath
        : "",
    modelKey: `${task.modelSelection.instanceId}:${task.modelSelection.model}`,
    runtimeMode: task.runtimeMode,
    interactionMode: task.interactionMode,
    baseModelSelection: task.modelSelection,
    ...(schedule.type === "webhook" && schedule.signature !== null
      ? {
          signatureEnabled: true,
          signatureHeader: schedule.signature.header,
          signatureEncoding: schedule.signature.encoding,
          signaturePrefix: schedule.signature.prefix,
        }
      : { signatureEnabled: false, ...WEBHOOK_SIGNATURE_DEFAULTS }),
    signatureSecret: "",
    replayKey: schedule.type === "webhook" ? (schedule.dedupe?.replayKey ?? "") : "",
    coalesceKey: schedule.type === "webhook" ? (schedule.dedupe?.coalesceKey ?? "") : "",
    coalesceWindowSeconds:
      schedule.type === "webhook" && schedule.dedupe?.coalesceWindowSeconds !== undefined
        ? String(schedule.dedupe.coalesceWindowSeconds)
        : "",
    maxDeliveryAgeMinutes:
      schedule.type === "webhook" && schedule.maxDeliveryAgeMinutes != null
        ? String(schedule.maxDeliveryAgeMinutes)
        : "",
    filters,
    savedFilters: filters,
  };
}

export function moveDraftToThread(
  draft: DraftState,
  thread: { readonly id: ThreadId; readonly projectId: ProjectId },
): DraftState {
  return {
    ...draft,
    threadId: thread.id,
    projectId: thread.projectId,
    threadMode: draft.threadMode === "new_thread" ? "continue" : draft.threadMode,
  };
}

/** Leaves the thread but keeps the mode. Matches MCP: new threads stay out of the shared checkout. */
export function unbindDraftFromThread(draft: DraftState): DraftState {
  if (!draft.threadId) return draft;
  return {
    ...draft,
    threadId: "",
    ...(draft.workspaceMode === "root"
      ? { workspaceMode: "worktree" as const, startFromOrigin: true }
      : {}),
  };
}

export function changeDraftProject(draft: DraftState, projectId: string): DraftState {
  if (projectId === draft.projectId) return draft;
  return { ...unbindDraftFromThread(draft), projectId };
}

/** Threads a task can move to. The current one is left out; the picker always shows it. */
export function scheduledTaskDestinationThreads(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  target: {
    readonly environmentId: EnvironmentId;
    readonly projectId: string;
    readonly currentThreadId: ThreadId | null;
    readonly query: string;
  },
): ReadonlyArray<EnvironmentThreadShell> {
  const search = target.query.trim().toLocaleLowerCase();
  return threads
    .filter(
      (thread) =>
        thread.environmentId === target.environmentId &&
        thread.projectId === target.projectId &&
        thread.id !== target.currentThreadId &&
        thread.archivedAt === null &&
        isListedThreadLineage(thread.lineage) &&
        thread.title.toLocaleLowerCase().includes(search),
    )
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function scheduledTaskDefaultModel(
  settings: ServerSettings,
  project: (LegacyProjectSettingsFields & { readonly id: ProjectId }) | null,
  entries: readonly ProviderInstanceEntry[],
): ModelSelection | null {
  const available = entries.filter(
    (entry) =>
      entry.enabled &&
      entry.installed &&
      entry.isAvailable &&
      entry.snapshot.auth.status !== "unauthenticated",
  );
  const configured = resolveProjectSettings(settings, project?.id ?? null, project).settings
    .defaultModelSelection;
  for (const selection of [configured, settings.defaultModelSelection]) {
    if (
      selection &&
      available.some(
        (entry) =>
          entry.instanceId === selection.instanceId &&
          entry.models.find((model) => model.slug === selection.model)?.isLegacy !== true,
      )
    )
      return selection;
  }
  const models = available.flatMap((entry) =>
    entry.models
      .filter((model) => !model.isLegacy)
      .map((model) => ({ instanceId: entry.instanceId, model })),
  );
  const fallback = models.find(({ model }) => model.isDefault) ?? models[0];
  return fallback ? { instanceId: fallback.instanceId, model: fallback.model.slug } : null;
}

/**
 * A new task's project: a pinned open project, then any open one. An archived
 * project only when Settings is scoped to it, so that scope can still save.
 */
export function defaultScheduledTaskProjectId<
  TProject extends {
    readonly id: ProjectId;
    readonly pinnedAt?: string | null | undefined;
    readonly archivedAt?: string | null | undefined;
  },
>(scopedProjects: ReadonlyArray<TProject>, scope: ResolvedSettingsScope): ProjectId | "" {
  const open = scopedProjects.filter((project) => project.archivedAt == null);
  const scopedToProject = scope.kind === "project" || scope.kind === "checkout";
  return (
    (
      open.find((project) => project.pinnedAt != null) ??
      open[0] ??
      (scopedToProject ? scopedProjects[0] : undefined)
    )?.id ?? ""
  );
}

export type ScheduledTaskTemplateSchedule = Extract<
  ScheduledTaskUpsertSchedule,
  { readonly type: "interval" | "fixed_time" }
>;

export interface ScheduledTaskTemplate {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly name: string;
  readonly prompt: string;
  readonly schedule: ScheduledTaskTemplateSchedule;
}

export const SCHEDULED_TASK_TEMPLATES: ReadonlyArray<ScheduledTaskTemplate> = [
  {
    id: "daily-morning-brief",
    label: "每日晨报",
    description: "每天 09:00 总结昨天以来的提交、未合 PR 和失败检查，并列出今天优先做的三件事",
    name: "每日晨报",
    prompt:
      "总结昨天以来的代码提交、尚未合并的 PR 以及失败的检查项，按优先级列出今天最先需要处理的三件事。",
    schedule: { type: "fixed_time", timeOfDay: "09:00" },
  },
  {
    id: "ci-patrol",
    label: "巡检 CI",
    description: "每 30 分钟检查一次 CI 状态，失败时给出原因和修复建议，全绿只回「全绿」",
    name: "巡检 CI",
    prompt:
      "检查当前项目的 CI 和自动检查状态。如果有失败项，简要说明失败原因和建议的修复方法；如果全部通过，只回复「全绿」。",
    schedule: { type: "interval", everyMs: Math.max(30 * 60_000, MIN_SCHEDULED_TASK_INTERVAL_MS) },
  },
  {
    id: "weekly-pr-triage",
    label: "每周整理 PR",
    description: "每周一 10:00 梳理打开超过 7 天的 PR 及其卡点",
    name: "每周整理 PR",
    prompt: "列出当前打开超过 7 天的 PR，说明每个 PR 的当前状态、主要卡点以及建议的下一步动作。",
    schedule: { type: "fixed_time", timeOfDay: "10:00", weekdays: [1] },
  },
  {
    id: "daily-wrap-up",
    label: "收工小结",
    description: "每天 18:00 总结今天完成的改动和尚未做完的事项",
    name: "收工小结",
    prompt: "总结今天完成的改动、已提交或待合并的进展，以及尚未做完、明天需要继续跟进的事项。",
    schedule: { type: "fixed_time", timeOfDay: "18:00" },
  },
];

export function applyScheduledTaskTemplate(
  draft: DraftState,
  template: ScheduledTaskTemplate,
): DraftState {
  if (template.schedule.type === "interval") {
    return {
      ...draft,
      title: template.name,
      prompt: template.prompt,
      scheduleMode: "interval",
      intervalMinutes: String(Math.max(1, Math.round(template.schedule.everyMs / 60_000))),
    };
  }
  const weekdays =
    template.schedule.weekdays && template.schedule.weekdays.length > 0
      ? new Set(template.schedule.weekdays)
      : new Set([0, 1, 2, 3, 4, 5, 6]);
  return {
    ...draft,
    title: template.name,
    prompt: template.prompt,
    scheduleMode: "fixed",
    timeOfDay: template.schedule.timeOfDay.padStart(5, "0"),
    weekdays,
  };
}

export type ScheduledTaskDraftKey = string;

export interface SavedScheduledTaskDraft {
  readonly environmentId: EnvironmentId;
  readonly draft: DraftState;
  readonly taskUpdatedAt: string | null;
}

export function scheduledTaskDraftKey(target: {
  readonly environmentId: EnvironmentId;
  readonly taskId: ScheduledTaskId | null;
}): ScheduledTaskDraftKey {
  return target.taskId === null ? "new" : `edit:${target.environmentId}:${target.taskId}`;
}

function setsEqual(left: ReadonlySet<number>, right: ReadonlySet<number>): boolean {
  if (left.size !== right.size) return false;
  for (const item of left) {
    if (!right.has(item)) return false;
  }
  return true;
}

export function areScheduledTaskDraftsEqual(left: DraftState, right: DraftState): boolean {
  if (
    left.editingId !== right.editingId ||
    left.title !== right.title ||
    left.prompt !== right.prompt ||
    left.enabled !== right.enabled ||
    left.scheduleMode !== right.scheduleMode ||
    left.projectId !== right.projectId ||
    left.threadId !== right.threadId ||
    left.threadMode !== right.threadMode ||
    left.workspaceMode !== right.workspaceMode ||
    left.baseRef !== right.baseRef ||
    left.startFromOrigin !== right.startFromOrigin ||
    left.existingWorktreePath !== right.existingWorktreePath ||
    left.modelKey !== right.modelKey ||
    left.runtimeMode !== right.runtimeMode ||
    left.interactionMode !== right.interactionMode
  ) {
    return false;
  }
  if (left.scheduleMode === "fixed") {
    return left.timeOfDay === right.timeOfDay && setsEqual(left.weekdays, right.weekdays);
  }
  if (left.scheduleMode === "once") {
    return left.runAt === right.runAt;
  }
  if (left.scheduleMode === "interval") {
    return left.intervalMinutes === right.intervalMinutes;
  }
  return (
    left.signatureEnabled === right.signatureEnabled &&
    left.signatureHeader === right.signatureHeader &&
    left.signatureEncoding === right.signatureEncoding &&
    left.signaturePrefix === right.signaturePrefix &&
    left.signatureSecret === right.signatureSecret &&
    left.maxDeliveryAgeMinutes === right.maxDeliveryAgeMinutes &&
    left.replayKey === right.replayKey &&
    left.coalesceKey === right.coalesceKey &&
    left.coalesceWindowSeconds === right.coalesceWindowSeconds &&
    !webhookFilterDraftsChanged(left.filters, right.filters)
  );
}

export function isScheduledTaskDraftDirty(input: {
  readonly baseline: DraftState;
  readonly current: DraftState;
  readonly baselineEnvironmentId: EnvironmentId;
  readonly currentEnvironmentId: EnvironmentId;
}): boolean {
  return (
    input.baselineEnvironmentId !== input.currentEnvironmentId ||
    !areScheduledTaskDraftsEqual(input.baseline, input.current)
  );
}

export function resolveScheduledTaskDraftOnClose(input: {
  readonly existingDrafts: ReadonlyMap<ScheduledTaskDraftKey, SavedScheduledTaskDraft>;
  readonly key: ScheduledTaskDraftKey;
  readonly baseline: DraftState;
  readonly current: DraftState;
  readonly baselineEnvironmentId: EnvironmentId;
  readonly currentEnvironmentId: EnvironmentId;
  readonly taskUpdatedAt: string | null;
}): {
  readonly nextDrafts: Map<ScheduledTaskDraftKey, SavedScheduledTaskDraft>;
  readonly saved: boolean;
} {
  const nextDrafts = new Map(input.existingDrafts);
  if (
    !isScheduledTaskDraftDirty({
      baseline: input.baseline,
      current: input.current,
      baselineEnvironmentId: input.baselineEnvironmentId,
      currentEnvironmentId: input.currentEnvironmentId,
    })
  ) {
    nextDrafts.delete(input.key);
    return { nextDrafts, saved: false };
  }
  nextDrafts.set(input.key, {
    environmentId: input.currentEnvironmentId,
    draft: input.current,
    taskUpdatedAt: input.taskUpdatedAt,
  });
  return { nextDrafts, saved: true };
}

export function clearScheduledTaskDraft(
  existingDrafts: ReadonlyMap<ScheduledTaskDraftKey, SavedScheduledTaskDraft>,
  key: ScheduledTaskDraftKey,
): Map<ScheduledTaskDraftKey, SavedScheduledTaskDraft> {
  if (!existingDrafts.has(key)) return new Map(existingDrafts);
  const nextDrafts = new Map(existingDrafts);
  nextDrafts.delete(key);
  return nextDrafts;
}

export function initialScheduledTaskEditorState(input: {
  readonly savedDraft: SavedScheduledTaskDraft | undefined;
  readonly initialEnvironmentId: EnvironmentId;
  readonly connectedEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly baseline: DraftState;
  readonly currentTaskUpdatedAt: string | null;
}): {
  readonly environmentId: EnvironmentId;
  readonly draft: DraftState;
  readonly restoredFromDraft: boolean;
  readonly taskChangedSinceDraft: boolean;
} {
  if (input.savedDraft === undefined) {
    return {
      environmentId: input.initialEnvironmentId,
      draft: input.baseline,
      restoredFromDraft: false,
      taskChangedSinceDraft: false,
    };
  }
  const resolvedEnvironmentId = input.connectedEnvironmentIds.has(input.savedDraft.environmentId)
    ? input.savedDraft.environmentId
    : input.initialEnvironmentId;
  if (
    resolvedEnvironmentId === input.initialEnvironmentId &&
    areScheduledTaskDraftsEqual(input.baseline, input.savedDraft.draft)
  ) {
    return {
      environmentId: input.initialEnvironmentId,
      draft: input.baseline,
      restoredFromDraft: false,
      taskChangedSinceDraft: false,
    };
  }
  return {
    environmentId: resolvedEnvironmentId,
    draft: input.savedDraft.draft,
    restoredFromDraft: true,
    taskChangedSinceDraft:
      input.currentTaskUpdatedAt !== null &&
      input.savedDraft.taskUpdatedAt !== null &&
      input.currentTaskUpdatedAt !== input.savedDraft.taskUpdatedAt,
  };
}

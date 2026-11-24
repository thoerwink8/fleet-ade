import type {
  StorageCleanupPreview,
  StorageCleanupReport,
  StorageCleanupSettings,
  WorktreeCleanupRules,
} from "@t3tools/contracts";
import { resolvePastedPath } from "@t3tools/shared/path";
import { resolveWorktreeCleanup } from "@t3tools/shared/projectSettings";
import { useRef, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { formatBytes } from "../../lib/formatBytes";
import { environmentAtomList, environmentIdsKey } from "../../state/environmentAtomList";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useDebouncedValue } from "../../state/queries";
import { AnimatedHeight } from "../AnimatedHeight";
import { Button } from "../ui/button";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";

import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { DatabaseStorageNotice } from "./DatabaseStorageNotice";
import { AdvancedSettings } from "./AdvancedSettings";
import { FoldedSettingsSection } from "./FoldedSettingsSection";
import { SettingsScopeNotice } from "./SettingsScopeNotice";
import { SettingsGroup } from "./SettingsGroup";
import type { ScopedSettingsTarget } from "./scopedSettings";
import { useSettingsScope } from "./SettingsScopeContext";
import { searchableSetting } from "./settingsSearch";
import {
  useClearScopedSettings,
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";
import { settingsScopeEnvironmentLabel } from "./settingsScopeAxis";
import {
  runStorageCleanupIfConfirmed,
  storageCleanupAmounts,
  storageCleanupButtonLabel,
  storageCleanupConfirmState,
  storageCleanupFailureMessage,
  storageCleanupFreedMessage,
  type StorageCleanupConfirmState,
} from "./storageCleanupConfirm.logic";

export function WorktreesDirectoryRow() {
  const { connectedEnvironments, targets } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["worktreesDirectory"]);
  const edited = useRef(false);
  const draft = useRef("");
  if (
    connectedEnvironments.some(
      (environment) =>
        environment.serverConfig?.environment.capabilities.worktreesDirectory !== true,
    )
  )
    return null;
  const scopeKey = targets.map((target) => target.environmentId).join(",");

  return (
    <SettingsRow
      {...searchableSetting("storage-worktrees-location")}
      description={
        "新工作树的创建位置，可选择任意磁盘，例如 D:\\worktrees 或 ~/worktrees。现有工作树的位置不变。留空时使用 T3 主目录。"
      }
      serverScoped
      settingKeys={["worktreesDirectory"]}
      resetAction={
        mixed || settings.worktreesDirectory !== "" ? (
          <SettingResetButton
            label="工作树位置"
            onClick={() => updateSettings({ worktreesDirectory: "" })}
          />
        ) : null
      }
      control={
        <Input
          key={`${scopeKey}:${mixed}:${settings.worktreesDirectory}`}
          aria-label="工作树位置"
          autoCapitalize="none"
          spellCheck={false}
          placeholder={mixed ? "各不相同" : "默认"}
          defaultValue={mixed ? "" : settings.worktreesDirectory}
          onFocus={(event) => {
            draft.current = event.target.value;
          }}
          onChange={(event) => {
            edited.current = true;
            draft.current = resolvePastedPath(draft.current, event.target.value);
            event.target.value = draft.current;
          }}
          onBlur={(event) => {
            const value = event.target.value.trim();
            if (edited.current && (mixed || value !== settings.worktreesDirectory))
              updateSettings({ worktreesDirectory: value });
            edited.current = false;
          }}
        />
      }
    />
  );
}

type SaveOptions = Parameters<ReturnType<typeof useUpdateScopedSettings>>[1];

function RetentionControl({
  label,
  value,
  onChange,
  minimum = 1,
}: {
  label: string;
  value: number | null;
  onChange: (value: number | null, onFailed: () => void) => void;
  minimum?: number;
}) {
  const [draft, setDraft] = useState(value);
  const [savedValue, setSavedValue] = useState(value);
  // Saving an age can start a cleanup sweep, so turning a rule on only opens a draft.
  // While its first save is in flight this holds that submission.
  const [enabling, setEnabling] = useState<"draft" | "edited" | { days: number } | null>(null);
  // Holds an age until Enter or focus leaves the row: one edited before focus moved to the
  // switch, so switching off never saves it first, or one stepped toward a rule's first age,
  // so raising it from 8 never saves a shorter age on the way.
  const [held, setHeld] = useState(false);
  // Hides a saved rule's age once it is switched off, so no blur can save it after null.
  const [switchedOff, setSwitchedOff] = useState(false);
  if (savedValue !== value) {
    setSavedValue(value);
    setDraft(value);
    setEnabling(null);
    setHeld(false);
    setSwitchedOff(false);
  }
  const pending = typeof enabling === "object" ? enabling : null;
  const on = (value !== null && !switchedOff) || enabling !== null;
  const row = useRef<HTMLDivElement>(null);

  const commit = (next: number) => {
    const days = Math.min(3650, Math.max(minimum, Math.round(next)));
    setDraft(days);
    setHeld(false);
    if (days === pending?.days) return;
    if (value !== null) {
      onChange(days, () => {});
      return;
    }
    const submission = { days };
    setEnabling(submission);
    onChange(days, () => setEnabling((current) => (current === submission ? null : current)));
  };

  const switchOff = () => {
    setDraft(value);
    setHeld(false);
    setEnabling(null);
    if (value === null && pending === null) return;
    setSwitchedOff(true);
    onChange(null, () => setSwitchedOff(false));
  };

  return (
    <div
      ref={row}
      className="flex items-center gap-3"
      onBlur={(event) => {
        if (event.currentTarget.contains(event.relatedTarget)) return;
        if (held && draft !== null) commit(draft);
        else setEnabling((current) => (typeof current === "string" ? null : current));
      }}
    >
      {on ? (
        <NumberField
          value={draft}
          min={minimum}
          max={3650}
          step={1}
          size="sm"
          className="w-auto"
          onValueChange={(next) => {
            setDraft(next);
            setEnabling((current) => (current === "draft" ? "edited" : current));
          }}
          onValueCommitted={(next, { reason, event }) => {
            if (next === null) setDraft(value);
            else if (
              reason === "input-blur"
                ? event instanceof FocusEvent &&
                  event.relatedTarget instanceof Node &&
                  row.current?.contains(event.relatedTarget)
                : value === null
            ) {
              setDraft(next);
              setHeld(true);
            } else commit(next);
          }}
        >
          <NumberFieldGroup>
            <NumberFieldDecrement aria-label={`减少 ${label}`} />
            <NumberFieldInput
              aria-label={`${label}（天）`}
              autoFocus={value === null}
              size={5}
              className="w-auto grow-0 text-right"
              // Any typed or pasted edit replaces a held age: NumberField commits it on blur itself,
              // and text it cannot parse yet must not leave the held age to be saved.
              onChange={() => setHeld(false)}
              onPaste={() => setHeld(false)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                if (event.key === "Enter") {
                  // Blurring lets NumberField parse the visible text and commit it once. It
                  // skips an unedited value, so an untouched draft is committed here.
                  const input = event.currentTarget;
                  const shown =
                    draft !== null && input.value === new Intl.NumberFormat().format(draft);
                  if (enabling === "draft" && shown) commit(draft);
                  input.blur();
                } else if (event.key === "Escape" && (held || typeof enabling === "string")) {
                  // An unhandled Escape closes the settings page.
                  event.preventDefault();
                  event.stopPropagation();
                  setDraft(pending?.days ?? value);
                  setHeld(false);
                  setEnabling((current) => (typeof current === "string" ? null : current));
                }
              }}
            />
            <span aria-hidden="true" className="self-center pr-2 text-xs">
              天
            </span>
            <NumberFieldIncrement aria-label={`增加 ${label}`} />
          </NumberFieldGroup>
        </NumberField>
      ) : (
        <span className="text-xs text-muted-foreground">关闭</span>
      )}
      <Switch
        aria-label={label}
        checked={on}
        // Keeps focus in the age field, so switching off never commits an edited age first.
        onMouseDown={(event) => event.preventDefault()}
        onCheckedChange={(enabled) => {
          if (enabled) {
            setDraft(8);
            setEnabling("draft");
          } else switchOff();
        }}
      />
    </div>
  );
}

const KEEP_WHEN_LABELS = {
  "any-local-files": "任何本地文件",
  "uncommitted-changes": "未提交的改动",
  "tracked-changes": "已编辑的跟踪文件",
} as const;

function lastRunSummary(
  entries: readonly { readonly label: string; readonly counts: string }[],
  machineCount: number,
) {
  const first = entries[0];
  if (!first) return "";
  if (machineCount <= 1) return first.counts;
  if (entries.length === machineCount && entries.every((entry) => entry.counts === first.counts)) {
    return `每台机器均为 ${first.counts}`;
  }
  return entries.map((entry) => `${entry.label}: ${entry.counts}`).join(" · ");
}

function CleanupResults({
  report,
  environmentLabel,
}: {
  report: StorageCleanupReport;
  environmentLabel: string;
}) {
  return (
    <>
      {report.entries.map((entry, index) => {
        const name =
          entry.kind === "worktree"
            ? ((entry.threadId === null
                ? entry.path
                : entry.path?.split(/[\\/]/).findLast(Boolean)) ?? "工作树")
            : entry.kind === "logs"
              ? "轮转日志"
              : "浏览器产物";
        return (
          <SettingsRow
            key={`${entry.path ?? entry.kind}:${entry.threadId ?? index}`}
            title={<span className="wrap-anywhere select-text">{name}</span>}
            description={
              <span className="block space-y-2 wrap-anywhere select-text">
                <span className={`block ${entry.outcome === "failed" ? "text-destructive" : ""}`}>
                  {entry.reason}
                </span>
                <span className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 border-l border-border/60 pl-3">
                  <span>机器</span>
                  <span className="text-foreground/80">{environmentLabel}</span>
                  {entry.projectPath && (
                    <>
                      <span>项目</span>
                      <code className="text-foreground/80">{entry.projectPath}</code>
                    </>
                  )}
                  {entry.path && (
                    <>
                      <span>文件夹</span>
                      <code className="text-foreground/80">{entry.path}</code>
                    </>
                  )}
                  {entry.threadTitle && (
                    <>
                      <span>会话</span>
                      <span>{entry.threadTitle}</span>
                    </>
                  )}
                </span>
              </span>
            }
            control={
              (entry.outcome === "removed" ||
                (entry.outcome === "kept" && entry.bytes !== null)) && (
                <span className="text-xs text-muted-foreground">
                  {[
                    entry.kind !== "worktree" && entry.files !== null
                      ? `${entry.files.toLocaleString("zh-CN")} 个文件`
                      : null,
                    entry.bytes !== null ? formatBytes(entry.bytes) : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              )
            }
          />
        );
      })}
      {report.omittedCount > 0 && (
        <p className="px-3 py-2.5 text-xs text-muted-foreground sm:px-4">
          {environmentLabel}：还有 {report.omittedCount.toLocaleString("zh-CN")} 条结果。
        </p>
      )}
      {report.entries.length === 0 && report.omittedCount === 0 && (
        <p className="px-3 py-2.5 text-xs text-muted-foreground sm:px-4">
          {environmentLabel}：无需清理。
        </p>
      )}
    </>
  );
}

const storageCleanupReportsAtom = environmentAtomList(
  "web-storage-cleanup-reports",
  (environmentId) => serverEnvironment.storageCleanupReport({ environmentId, input: {} }),
);
const storageCleanupPermissionsAtom = environmentAtomList(
  "web-storage-cleanup-permissions",
  serverEnvironment.runStorageCleanup.permissionAtom,
);

function CleanupSection() {
  const nowMinute = useNowMinute();
  const nowMs = Date.parse(`${nowMinute}:00.000Z`);
  const { connectedEnvironments } = useSettingsScope();
  const [phase, setPhase] = useState<
    | { readonly kind: "idle" }
    | { readonly kind: "previewing" }
    | {
        readonly kind: "confirm";
        readonly dialog: StorageCleanupConfirmState;
        readonly amounts: ReturnType<typeof storageCleanupAmounts>;
      }
    | { readonly kind: "running" }
    | { readonly kind: "done"; readonly message: string }
    | { readonly kind: "failed"; readonly message: string }
  >({ kind: "idle" });
  const cleanupLock = useRef(false);
  const ignoreDialogClose = useRef(false);
  const previewCleanup = useAtomCommand(serverEnvironment.previewStorageCleanup, {
    reportFailure: false,
    reportDefect: false,
  });
  const run = useAtomCommand(serverEnvironment.runStorageCleanup, {
    reportFailure: false,
    reportDefect: false,
  });
  const supported = connectedEnvironments.filter(
    (environment) => environment.serverConfig?.environment.capabilities.storageCleanupRun === true,
  );
  const supportedIds = supported.map(({ environmentId }) => environmentId);
  const reports = useAtomValue(storageCleanupReportsAtom(environmentIdsKey(supportedIds)));
  const permissions = useAtomValue(storageCleanupPermissionsAtom(environmentIdsKey(supportedIds)));
  const state = supportedIds.map((environmentId, index) => {
    const query = reports[index]!;
    return {
      environmentId,
      allowed: permissions[index]!,
      report: query._tag === "Success" ? query.value : null,
      loading: query.waiting,
      failed: query._tag === "Failure",
    };
  });
  const hasRules = supported.some((environment) => {
    const settings = environment.serverConfig?.settings;
    if (!settings) return false;
    const enabled = (rules: WorktreeCleanupRules) =>
      rules.worktreeAfterDays !== null ||
      rules.worktreeSettledAfterDays !== null ||
      rules.worktreeOnMerge ||
      rules.worktreeOnDelete ||
      rules.worktreeUnchanged;
    return (
      settings.storageCleanup.browserArtifactsAfterDays !== null ||
      settings.storageCleanup.logsAfterDays !== null ||
      enabled(resolveWorktreeCleanup(settings, null)) ||
      Object.values(settings.projectSettingsOverrides).some(
        (override) =>
          override.worktreeCleanup?.mode === "custom" && enabled(override.worktreeCleanup.rules),
      )
    );
  });
  if (supported.length === 0) return null;
  const summaries = supported.map((environment) => {
    const query = state.find((entry) => entry.environmentId === environment.environmentId);
    const report = query?.report ?? null;
    return {
      environment,
      report,
      label: settingsScopeEnvironmentLabel(environment, connectedEnvironments),
      counts: report
        ? `已清理 ${report.counts.removed} 项，保留 ${report.counts.kept} 项${report.counts.failed > 0 ? `，失败 ${report.counts.failed} 项` : ""}`
        : "",
      description: report
        ? `上次运行于 ${formatRelativeTimeLabel(report.finishedAt, nowMs)}，已回收 ${formatBytes(report.bytesFreed)}。${report.counts.failed > 0 ? `有 ${report.counts.failed} 项未能清理。` : ""}`
        : query?.failed
          ? "无法加载上次运行记录。"
          : query?.loading
            ? "正在加载上次运行记录…"
            : "尚未运行清理。",
    };
  });
  const targets = supported.filter((environment) =>
    state.some((entry) => entry.environmentId === environment.environmentId && entry.allowed),
  );
  const missingPreview = supported.filter(
    (environment) =>
      environment.serverConfig?.environment.capabilities.storageCleanupPreview !== true,
  );
  const previewReady = missingPreview.length === 0;
  const buttonPhase =
    phase.kind === "previewing" || phase.kind === "running" || phase.kind === "failed"
      ? phase.kind
      : "idle";
  const openPreview = async () => {
    if (cleanupLock.current || !hasRules || !previewReady || targets.length === 0) return;
    cleanupLock.current = true;
    ignoreDialogClose.current = false;
    setPhase({ kind: "previewing" });
    const results = await Promise.all(
      targets.map(async (environment) => ({
        environment,
        result: await previewCleanup({ environmentId: environment.environmentId, input: {} }),
      })),
    ).catch((error: unknown) => {
      cleanupLock.current = false;
      setPhase({
        kind: "failed",
        message: storageCleanupFailureMessage(
          0,
          error instanceof Error ? error.message : "无法计算将要删除的内容。",
        ),
      });
      return null;
    });
    if (results === null) return;
    const failures: string[] = [];
    const previews: Array<{
      environmentLabel: string | null;
      categories: StorageCleanupPreview["categories"];
    }> = [];
    for (const { environment, result } of results) {
      const label = settingsScopeEnvironmentLabel(environment, connectedEnvironments);
      const prefix = targets.length > 1 ? `${label}：` : "";
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result))
          failures.push(`${prefix}${String(squashAtomCommandFailure(result))}`);
        continue;
      }
      previews.push({
        environmentLabel: targets.length > 1 ? label : null,
        categories: result.value.categories,
      });
      for (const failure of result.value.failures) failures.push(`${prefix}${failure.reason}`);
    }
    cleanupLock.current = false;
    if (failures.length === 0 && previews.length === 0) {
      setPhase({ kind: "idle" });
      return;
    }
    const amounts = storageCleanupAmounts(previews);
    setPhase({
      kind: "confirm",
      amounts,
      dialog: storageCleanupConfirmState({ amounts, failures }),
    });
  };
  const confirmDelete = async () => {
    if (phase.kind !== "confirm" || cleanupLock.current) return;
    const dialog = phase.dialog;
    cleanupLock.current = true;
    ignoreDialogClose.current = true;
    setPhase({ kind: "running" });
    let freed = 0;
    const failures: string[] = [];
    const ran = await runStorageCleanupIfConfirmed("confirm", dialog, async () => {
      const results = await Promise.all(
        targets.map(async (environment) => ({
          environment,
          result: await run({ environmentId: environment.environmentId, input: {} }),
        })),
      );
      for (const { environment, result } of results) {
        const label = settingsScopeEnvironmentLabel(environment, connectedEnvironments);
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result))
            failures.push(`${label}：${String(squashAtomCommandFailure(result))}`);
          continue;
        }
        freed += result.value.bytesFreed;
        const entryFailure = result.value.entries.find((entry) => entry.outcome === "failed");
        if (entryFailure) failures.push(`${label}：${entryFailure.reason}`);
      }
    }).catch((error: unknown) => {
      failures.push(error instanceof Error ? error.message : "清理没有完成。");
      return true;
    });
    cleanupLock.current = false;
    ignoreDialogClose.current = false;
    if (!ran) {
      setPhase({ kind: "idle" });
      return;
    }
    setPhase(
      failures.length > 0
        ? { kind: "failed", message: storageCleanupFailureMessage(freed, failures.join("；")) }
        : { kind: "done", message: storageCleanupFreedMessage(freed) },
    );
  };
  return (
    <SettingsSection id="storage-cleanup" title="清理" variant="plain">
      <SettingsGroup>
        <SettingsRow
          {...searchableSetting("storage-delete-now")}
          description={
            <span>
              {!hasRules
                ? "请先启用一条清理规则。"
                : !previewReady
                  ? supported.length > 1
                    ? "有的电脑还不能在删除前列出将要清掉的内容。请先更新。"
                    : "这台电脑的版本还不能在删除前列出将要清掉的内容。请先更新。"
                  : summaries.map(({ environment, label, description }) => (
                      <span key={environment.environmentId} className="block">
                        {supported.length > 1 ? `${label}：` : ""}
                        {description}
                      </span>
                    ))}
              {phase.kind === "done" || phase.kind === "failed" ? (
                <span className="block">{phase.message}</span>
              ) : null}
            </span>
          }
          control={
            <Button
              variant="outline"
              size="sm"
              disabled={
                buttonPhase === "previewing" ||
                buttonPhase === "running" ||
                phase.kind === "confirm" ||
                !hasRules ||
                !previewReady ||
                targets.length === 0
              }
              onClick={() => void openPreview()}
            >
              {storageCleanupButtonLabel(buttonPhase)}
            </Button>
          }
        />
      </SettingsGroup>
      {phase.kind === "confirm" ? (
        <AlertDialog
          open
          onOpenChange={(open) => {
            if (open || ignoreDialogClose.current) return;
            setPhase((current) => (current.kind === "confirm" ? { kind: "idle" } : current));
          }}
        >
          <AlertDialogPopup>
            <AlertDialogHeader>
              <AlertDialogTitle>{phase.dialog.title}</AlertDialogTitle>
              <AlertDialogDescription>
                {phase.dialog.disabledReason ?? "将按当前的清理规则删除下面这些内容。"}
              </AlertDialogDescription>
              {phase.amounts.length > 0 ? (
                <ul className="space-y-2 text-sm">
                  {phase.amounts.map((amount) => (
                    <li key={amount.key} className="flex items-baseline justify-between gap-4">
                      <span>{amount.label}</span>
                      <span className="text-muted-foreground">{amount.detail}</span>
                    </li>
                  ))}
                  <li className="flex items-baseline justify-between gap-4 border-t border-border pt-2">
                    <span>合计</span>
                    <span>{formatBytes(phase.dialog.totalBytes)}</span>
                  </li>
                </ul>
              ) : null}
              {phase.amounts.some((amount) => amount.detail.includes("大小未知")) ? (
                <p className="text-sm text-muted-foreground">合计不含大小未知的项。</p>
              ) : null}
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogClose render={<Button variant="outline" />}>取消</AlertDialogClose>
              <Button
                variant="destructive"
                disabled={phase.dialog.confirmDisabled}
                onClick={() => void confirmDelete()}
              >
                {phase.dialog.confirmLabel}
              </Button>
            </AlertDialogFooter>
          </AlertDialogPopup>
        </AlertDialog>
      ) : null}
      {summaries.some(({ report }) => report !== null) && (
        <FoldedSettingsSection
          id="storage-cleanup-last-run"
          title="上次运行"
          headerPlacement="inside"
          summary={lastRunSummary(
            summaries.filter(({ report }) => report !== null),
            connectedEnvironments.length,
          )}
        >
          {summaries.map(
            ({ environment, label, report }) =>
              report && (
                <CleanupResults
                  key={environment.environmentId}
                  report={report}
                  environmentLabel={label}
                />
              ),
          )}
        </FoldedSettingsSection>
      )}
    </SettingsSection>
  );
}

function supportsStorageCleanup(
  environments: ReadonlyArray<{
    readonly serverConfig: {
      readonly environment: { readonly capabilities: { readonly storageCleanup?: boolean } };
    } | null;
  }>,
) {
  return environments.every(
    (environment) => environment.serverConfig?.environment.capabilities.storageCleanup === true,
  );
}

/** Narrows a mixed selection to the machines that support cleanup. */
function StorageCleanupScopeNotice() {
  const { connectedEnvironments } = useSettingsScope();
  return (
    <SettingsScopeNotice
      inline
      target="environment"
      eligibleEnvironmentIds={connectedEnvironments
        .filter(
          (environment) =>
            environment.serverConfig?.environment.capabilities.storageCleanup === true,
        )
        .map((environment) => environment.environmentId)}
    >
      更新所选环境后即可使用存储清理，或选择支持此功能的机器。
    </SettingsScopeNotice>
  );
}

export function WorktreeCleanupSection() {
  const { scope, environments, connectedEnvironments, targets, target } = useSettingsScope();
  const scopedSettings = useScopedSettings();
  const isProjectScope = scope.kind === "project" || scope.kind === "checkout";
  const settings = {
    ...scopedSettings.storageCleanup,
    ...resolveWorktreeCleanup(scopedSettings, null),
  };
  const projectMode = (entry: ScopedSettingsTarget | null) =>
    entry?.sources.worktreeCleanup === "project"
      ? (entry.settings.worktreeCleanup?.mode ?? "inherit")
      : "inherit";
  const mode = projectMode(target);
  const mixedModes = targets.some((entry) => projectMode(entry) !== mode);
  const updateSettings = useUpdateScopedSettings();
  const clearSettings = useClearScopedSettings();
  const ruleStatus = (key: keyof StorageCleanupSettings) =>
    targets.some(
      (target) =>
        ({ ...target.settings.storageCleanup, ...resolveWorktreeCleanup(target.settings, null) })[
          key
        ] !== settings[key],
    )
      ? "所选机器的设置各不相同"
      : undefined;
  const update = (patch: Partial<StorageCleanupSettings>, options?: SaveOptions) =>
    updateSettings({ storageCleanup: patch }, options);
  const updateWorktree = (patch: Partial<WorktreeCleanupRules>, options?: SaveOptions) =>
    isProjectScope
      ? updateSettings({ worktreeCleanup: { mode: "custom", rules: patch } }, options)
      : update(patch, options);

  if (
    isProjectScope &&
    connectedEnvironments.some(
      (environment) =>
        environment.serverConfig?.environment.capabilities.projectWorktreeCleanup !== true,
    )
  ) {
    return (
      <SettingsSection id="storage-worktrees" title="清理" variant="plain">
        <SettingsScopeNotice inline target="all">
          请先更新所选机器，再配置项目工作树清理。
        </SettingsScopeNotice>
      </SettingsSection>
    );
  }
  if (!supportsStorageCleanup(connectedEnvironments)) {
    return (
      <SettingsSection id="storage-worktrees" title="清理" variant="plain">
        <StorageCleanupScopeNotice />
      </SettingsSection>
    );
  }

  return (
    <SettingsSection id="storage-worktrees" title="清理">
      <>
        {isProjectScope && (
          <SettingsRow
            title="自动清理工作树"
            description={
              mode === "off"
                ? "保留此项目的工作树，直到你手动删除。"
                : mode === "custom"
                  ? "此项目使用以下规则。"
                  : "使用各机器的工作树清理设置。"
            }
            serverScoped
            settingKeys={["worktreeCleanup"]}
            mixed={mixedModes}
            control={
              <Select
                value={mixedModes ? null : mode}
                onValueChange={(next) => {
                  if (next === "inherit") clearSettings(["worktreeCleanup"]);
                  else if (next === "off") updateSettings({ worktreeCleanup: { mode: "off" } });
                  else if (next === "custom")
                    updateSettings({ worktreeCleanup: { mode: "custom", rules: {} } });
                }}
              >
                <SelectTrigger size="sm" aria-label="自动清理工作树">
                  <SelectValue>
                    {mixedModes
                      ? "各不相同"
                      : mode === "inherit"
                        ? "继承"
                        : mode === "off"
                          ? "关闭"
                          : "自定义"}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem value="inherit">继承</SelectItem>
                  <SelectItem value="off">关闭</SelectItem>
                  <SelectItem value="custom">自定义</SelectItem>
                </SelectPopup>
              </Select>
            }
          />
        )}
        {(!isProjectScope || (!mixedModes && mode === "custom")) && (
          <>
            <SettingsRow
              title="删除会话时删除工作树"
              status={ruleStatus("worktreeOnDelete")}
              description="删除活跃或已归档会话时，移除不再使用的工作树。保留有本地改动的工作树。"
              serverScoped={!isProjectScope}
              control={
                <Switch
                  aria-label="删除会话时删除工作树"
                  checked={settings.worktreeOnDelete}
                  onCheckedChange={(worktreeOnDelete) => updateWorktree({ worktreeOnDelete })}
                />
              }
            />
            <SettingsRow
              title="删除已合并的工作树"
              status={ruleStatus("worktreeOnMerge")}
              description="移除 pull request 已合并且提交已包含在默认分支中的工作树。"
              serverScoped={!isProjectScope}
              control={
                <Switch
                  aria-label="删除已合并的工作树"
                  checked={settings.worktreeOnMerge}
                  onCheckedChange={(worktreeOnMerge) => updateWorktree({ worktreeOnMerge })}
                />
              }
            />
            <SettingsRow
              title="删除不活跃的工作树"
              status={ruleStatus("worktreeAfterDays")}
              description="会话闲置达到设定天数后移除其工作树。保留分支和会话历史。"
              serverScoped={!isProjectScope}
              control={
                <RetentionControl
                  label="删除不活跃的工作树"
                  value={settings.worktreeAfterDays}
                  onChange={(worktreeAfterDays, onFailed) =>
                    updateWorktree({ worktreeAfterDays }, { onFailed })
                  }
                />
              }
            />
            <AdvancedSettings
              // The keep-when search result lands on this section, not its row.
              targetIds={["storage-worktrees", searchableSetting("storage-worktree-keep-when").id]}
            >
              {connectedEnvironments.length > 0 &&
                connectedEnvironments.every(
                  (environment) =>
                    environment.serverConfig?.environment.capabilities.settledWorktreeCleanup ===
                    true,
                ) && (
                  <SettingsRow
                    title="删除已收尾的工作树"
                    status={[
                      ruleStatus("worktreeSettledAfterDays"),
                      environments.length > connectedEnvironments.length
                        ? "离线机器不会收到此设置"
                        : undefined,
                    ]
                      .filter(Boolean)
                      .join(". ")}
                    description="会话收尾达到设定天数后移除其工作树。设为 0 天时，在下次清理时移除。保留分支和会话历史。"
                    serverScoped={!isProjectScope}
                    control={
                      <RetentionControl
                        label="删除已收尾的工作树"
                        value={settings.worktreeSettledAfterDays}
                        minimum={0}
                        onChange={(worktreeSettledAfterDays, onFailed) =>
                          updateWorktree({ worktreeSettledAfterDays }, { onFailed })
                        }
                      />
                    }
                  />
                )}
              <SettingsRow
                title="删除无改动的工作树"
                status={ruleStatus("worktreeUnchanged")}
                description="移除相较于默认分支没有新增提交的工作树。"
                serverScoped={!isProjectScope}
                control={
                  <Switch
                    aria-label="删除无改动的工作树"
                    checked={settings.worktreeUnchanged}
                    onCheckedChange={(worktreeUnchanged) => updateWorktree({ worktreeUnchanged })}
                  />
                }
              />
              {connectedEnvironments.every(
                (environment) =>
                  environment.serverConfig?.environment.capabilities.storageCleanupRun === true,
              ) && (
                <SettingsRow
                  {...searchableSetting("storage-worktree-keep-when")}
                  status={ruleStatus("worktreeKeepWhen")}
                  description={
                    settings.worktreeKeepWhen === "any-local-files"
                      ? "包括已忽略的文件，但不含 node_modules。"
                      : settings.worktreeKeepWhen === "tracked-changes"
                        ? "删除未跟踪和已忽略的文件，包括 .env。"
                        : "保留改动和未跟踪的文件。删除已忽略的文件，包括 .env。"
                  }
                  serverScoped={!isProjectScope}
                  control={
                    <Select
                      value={ruleStatus("worktreeKeepWhen") ? null : settings.worktreeKeepWhen}
                      onValueChange={(next) => {
                        if (
                          next === "any-local-files" ||
                          next === "uncommitted-changes" ||
                          next === "tracked-changes"
                        )
                          updateWorktree({ worktreeKeepWhen: next });
                      }}
                    >
                      <SelectTrigger size="sm" aria-label="保留有本地改动的工作树">
                        <SelectValue>
                          {ruleStatus("worktreeKeepWhen")
                            ? "各不相同"
                            : KEEP_WHEN_LABELS[settings.worktreeKeepWhen]}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectPopup align="end" alignItemWithTrigger={false}>
                        <SelectItem value="any-local-files">任何本地文件</SelectItem>
                        <SelectItem value="uncommitted-changes">未提交的改动</SelectItem>
                        <SelectItem value="tracked-changes">已编辑的跟踪文件</SelectItem>
                      </SelectPopup>
                    </Select>
                  }
                />
              )}
            </AdvancedSettings>
          </>
        )}
      </>
    </SettingsSection>
  );
}

/** Retention for logs and captures, and the manual cleanup run, which covers worktrees too. */
export function StorageCleanupSections() {
  const { scope, connectedEnvironments, targets } = useSettingsScope();
  const scopedSettings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const settings = scopedSettings.storageCleanup;
  const targetIdsKey = environmentIdsKey(targets.map((target) => target.environmentId).sort());
  const artifactsMixed =
    targets.length > 1 &&
    targets.some(
      (target) =>
        target.settings.storageCleanup.browserArtifactsAfterDays !==
        settings.browserArtifactsAfterDays,
    );
  const logsMixed =
    targets.length > 1 &&
    targets.some(
      (target) => target.settings.storageCleanup.logsAfterDays !== settings.logsAfterDays,
    );
  const settledArtifactsStatus = useDebouncedValue(`${targetIdsKey}:${artifactsMixed}`, 300);
  const settledLogsStatus = useDebouncedValue(`${targetIdsKey}:${logsMixed}`, 300);
  const artifactsStatus =
    targets.length > 1 && settledArtifactsStatus === `${targetIdsKey}:true`
      ? "所选机器的设置各不相同"
      : undefined;
  const logsStatus =
    targets.length > 1 && settledLogsStatus === `${targetIdsKey}:true`
      ? "所选机器的设置各不相同"
      : undefined;
  if (scope.kind === "project" || scope.kind === "checkout") return null;
  const update = (patch: Partial<StorageCleanupSettings>, options: SaveOptions) =>
    updateSettings({ storageCleanup: patch }, options);
  const databaseStorageNotice = (
    <DatabaseStorageNotice
      environments={connectedEnvironments.filter(
        (environment) =>
          environment.serverConfig?.environment.capabilities.databaseStorage === true,
      )}
    />
  );
  if (!supportsStorageCleanup(connectedEnvironments)) {
    return (
      <>
        {databaseStorageNotice}
        <SettingsSection id="storage-artifacts" title="产物与日志" variant="plain">
          <StorageCleanupScopeNotice />
        </SettingsSection>
      </>
    );
  }

  return (
    <>
      {databaseStorageNotice}
      <SettingsSection id="storage-artifacts" title="产物与日志">
        <AnimatedHeight>
          <SettingsRow
            title="删除旧浏览器产物"
            status={artifactsStatus}
            description="删除保存超过设定天数的浏览器截图和录制。旧的截图和录制链接将无法打开。"
            serverScoped
            control={
              <RetentionControl
                label="删除旧浏览器产物"
                value={settings.browserArtifactsAfterDays}
                onChange={(browserArtifactsAfterDays, onFailed) =>
                  update({ browserArtifactsAfterDays }, { onFailed })
                }
              />
            }
          />
        </AnimatedHeight>
        <AnimatedHeight>
          <SettingsRow
            title="删除旧轮转日志"
            status={logsStatus}
            description="删除超过设定天数且不再写入的轮转日志文件。保留当前日志。"
            serverScoped
            control={
              <RetentionControl
                label="删除旧轮转日志"
                value={settings.logsAfterDays}
                onChange={(logsAfterDays, onFailed) => update({ logsAfterDays }, { onFailed })}
              />
            }
          />
        </AnimatedHeight>
      </SettingsSection>
      <CleanupSection />
    </>
  );
}

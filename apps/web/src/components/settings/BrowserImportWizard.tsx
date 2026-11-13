import { PermissionChecklist, PermissionContinueButton } from "../permissions/PermissionChecklist";
import { usePermissionStatus } from "../permissions/usePermissionStatus";
import type { BrowserImportSource } from "@t3tools/contracts";
import { BROWSER_IMPORT_FAILURE_COPY } from "@t3tools/contracts";
import { ArrowDownIcon, ArrowRightIcon, CheckIcon, HardDriveIcon } from "lucide-react";
import { useRef, useState } from "react";

import { cn, randomUUID } from "~/lib/utils";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogAction,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Spinner } from "../ui/spinner";
import {
  initialWizardStep,
  initialTargetSelection,
  canCloseWizard,
  isRetryableReason,
  formatSkippedDomains,
  fullDiskAccessRecheckStep,
  outcomeToStep,
  refreshedSourceProfileDirectory,
  refreshedSourceStep,
  resolveWizardTarget,
  type ImportOutcome,
  type WizardTarget,
  type WizardTargetProfile,
  type WizardTargetSelection,
  type WizardStep,
} from "./browserImportWizard.logic";

export type { WizardTarget } from "./browserImportWizard.logic";

interface BrowserImportWizardProps {
  readonly source: BrowserImportSource;
  readonly destinationEnvironmentName: string;
  readonly targetProfiles: ReadonlyArray<WizardTargetProfile>;
  readonly canCreateProfile: boolean;
  readonly onImport: (input: {
    readonly sourceProfileDirectory: string;
    readonly target: WizardTarget;
  }) => Promise<ImportOutcome>;
  readonly onRefreshSource: () => Promise<BrowserImportSource | undefined>;
  readonly onOpenFullDiskAccessSettings: () => void | Promise<void>;
  readonly onCheckFullDiskAccess?: (() => Promise<boolean>) | undefined;
  readonly onClose: () => void;
}

export function BrowserImportWizard({
  source: initialSource,
  destinationEnvironmentName,
  targetProfiles,
  canCreateProfile,
  onImport,
  onRefreshSource,
  onOpenFullDiskAccessSettings,
  onCheckFullDiskAccess,
  onClose,
}: BrowserImportWizardProps) {
  const [source, setSource] = useState(initialSource);
  const [step, setStep] = useState<WizardStep>(() => initialWizardStep(initialSource));
  const [sourceProfileDirectory, setSourceProfileDirectory] = useState(
    () => initialSource.profiles[0]?.directory ?? "",
  );
  const [target, setTarget] = useState<WizardTargetSelection>(() =>
    initialTargetSelection(canCreateProfile, targetProfiles),
  );
  const [targetError, setTargetError] = useState<string>();
  const newProfileId = useRef(`profile-${randomUUID()}`);
  // Guard synchronously so a second click's refusal cannot leave the importing step during the first write.
  const importInFlight = useRef(false);

  const runImport = () => {
    if (importInFlight.current) return;
    const chosen = resolveWizardTarget(target, newProfileId.current, targetProfiles);
    if (chosen === undefined) {
      setTargetError("此浏览器配置已不可用，请重新选择 Cookie 的导入位置。");
      setStep({ step: "configure" });
      return;
    }
    setTargetError(undefined);
    importInFlight.current = true;
    setStep({ step: "importing" });
    void onImport({ sourceProfileDirectory, target: chosen })
      .then((outcome) => setStep(outcomeToStep(outcome)))
      .catch(() => setStep({ step: "blocked", reason: "readFailed" }))
      .finally(() => {
        importInFlight.current = false;
      });
  };

  const recheckSource = (
    check: "browser" | "fullDiskAccess",
    nextStep: (refreshed: BrowserImportSource | undefined) => WizardStep,
  ) => {
    setStep({ step: "checking", check });
    void onRefreshSource()
      .then((refreshed) => {
        if (refreshed) {
          setSource(refreshed);
          setSourceProfileDirectory((current) =>
            refreshedSourceProfileDirectory(current, refreshed),
          );
        }
        setStep(nextStep(refreshed));
      })
      .catch(() => setStep({ step: "blocked", reason: "readFailed" }));
  };
  const recheckAfterQuit = () => recheckSource("browser", refreshedSourceStep);
  const recheckFullDiskAccess = () => recheckSource("fullDiskAccess", fullDiskAccessRecheckStep);

  return (
    <Dialog open onOpenChange={(open) => (open || !canCloseWizard(step) ? undefined : onClose())}>
      <DialogPopup className="max-w-lg" showCloseButton={canCloseWizard(step)}>
        {step.step === "quit" ? (
          <QuitStep source={source} onCancel={onClose} onRechecked={recheckAfterQuit} />
        ) : step.step === "fullDiskAccess" ? (
          <FullDiskAccessStep
            source={source}
            onCancel={onClose}
            onOpenSettings={onOpenFullDiskAccessSettings}
            onCheck={
              onCheckFullDiskAccess ??
              (async () => {
                const refreshed = await onRefreshSource();
                return refreshed !== undefined && refreshed.unavailable === undefined;
              })
            }
            onGranted={step.resume === "import" ? runImport : recheckFullDiskAccess}
            stillRequired={step.checked === true}
          />
        ) : step.step === "importing" ? (
          <ImportingStep />
        ) : step.step === "checking" ? (
          <CheckingStep sourceName={source.name} check={step.check} />
        ) : step.step === "done" ? (
          <DoneStep
            {...step}
            destinationEnvironmentName={destinationEnvironmentName}
            onClose={onClose}
          />
        ) : step.step === "blocked" ? (
          <BlockedStep
            source={source}
            reason={step.reason}
            message={step.message}
            onClose={onClose}
            onRetry={
              step.message === undefined && isRetryableReason(step.reason) ? runImport : undefined
            }
          />
        ) : (
          <ConfigureStep
            source={source}
            destinationEnvironmentName={destinationEnvironmentName}
            targetProfiles={targetProfiles}
            canCreateProfile={canCreateProfile}
            sourceProfileDirectory={sourceProfileDirectory}
            onSourceProfileChange={setSourceProfileDirectory}
            target={target}
            onTargetChange={(selection) => {
              setTarget(selection);
              setTargetError(undefined);
            }}
            targetError={targetError}
            onCancel={onClose}
            onImport={runImport}
          />
        )}
      </DialogPopup>
    </Dialog>
  );
}

function QuitStep({
  source,
  onCancel,
  onRechecked,
}: {
  readonly source: BrowserImportSource;
  readonly onCancel: () => void;
  readonly onRechecked: () => void;
}) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>退出 {source.name} 后再导入</DialogTitle>
        <DialogDescription>
          {source.name} 仍在运行，暂时读不到它的 Cookie。请先退出，再继续。
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>
          取消
        </Button>
        <DialogAction onClick={onRechecked}>我已退出</DialogAction>
      </DialogFooter>
    </>
  );
}

function cookieCountLabel(count: number | undefined): string | undefined {
  if (count === undefined) return undefined;
  if (count === 0) return "没有 Cookie";
  return `${count.toLocaleString("zh-CN")} ${count === 1 ? "cookie" : "cookies"}`;
}

function cookieResultCount(count: number): string {
  return `${count.toLocaleString("zh-CN")} ${count === 1 ? "cookie" : "cookies"}`;
}

type ConfigureStepProps = {
  readonly source: BrowserImportSource;
  readonly destinationEnvironmentName: string;
  readonly targetProfiles: ReadonlyArray<WizardTargetProfile>;
  readonly canCreateProfile: boolean;
  readonly sourceProfileDirectory: string;
  readonly onSourceProfileChange: (directory: string) => void;
  readonly target: WizardTargetSelection;
  readonly targetError: string | undefined;
  readonly onTargetChange: (target: WizardTargetSelection) => void;
  readonly onCancel: () => void;
  readonly onImport: () => void;
};

function FullDiskAccessStep({
  source,
  onCancel,
  onOpenSettings,
  onGranted,
  stillRequired,
  onCheck,
}: {
  readonly source: BrowserImportSource;
  readonly onCancel: () => void;
  readonly onOpenSettings: () => void | Promise<void>;
  readonly onCheck: () => Promise<boolean>;
  readonly onGranted: () => void;
  readonly stillRequired: boolean;
}) {
  const [opening, setOpening] = useState(false);
  const [openingError, setOpeningError] = useState<string | null>(null);
  const permission = usePermissionStatus(async () => ({ fullDiskAccess: await onCheck() }), {
    fullDiskAccess: false,
  });
  const allow = () => {
    if (opening) return;
    setOpening(true);
    setOpeningError(null);
    void Promise.resolve()
      .then(onOpenSettings)
      .catch(() => setOpeningError("无法打开系统设置，请再次点击“允许”。"))
      .finally(() => setOpening(false));
  };
  return (
    <>
      <DialogHeader>
        <DialogTitle>允许 T3 Code 读取 {source.name} 的 Cookie</DialogTitle>
        <DialogDescription>
          要从 {source.name} 导入 Cookie，T3 Code
          需要完全磁盘访问权限。请在系统设置中打开，然后回来完成导入。导入结束后可以再关掉。
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <PermissionChecklist
          busy={opening}
          permissions={[
            {
              id: "fullDiskAccess",
              icon: (
                <HardDriveIcon
                  className="size-8 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
              ),
              title: "完全磁盘访问权限",
              description: `读取 ${source.name} 的 Cookie 以完成此次导入。`,
              granted: permission.status.fullDiskAccess,
              onAllow: () => void allow(),
            },
          ]}
        />
        {openingError || permission.error ? (
          <p role="status" className="mt-3 text-xs text-muted-foreground">
            {openingError ?? permission.error}
          </p>
        ) : null}
        {!permission.isReady(["fullDiskAccess"]) ? (
          <p className="mt-3 text-xs text-muted-foreground">
            {stillRequired
              ? "仍需要访问权限。如果你刚刚授权，请退出并重新打开 T3 Code，然后重试导入。"
              : "如果授权后权限状态未更新，请退出并重新打开 T3 Code，然后重试导入。"}
          </p>
        ) : null}
      </DialogPanel>
      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>
          取消
        </Button>
        <PermissionContinueButton
          ready={permission.isReady(["fullDiskAccess"])}
          busy={opening}
          onClick={onGranted}
        >
          继续
        </PermissionContinueButton>
      </DialogFooter>
    </>
  );
}
function ConfigureStep({
  source,
  destinationEnvironmentName,
  targetProfiles,
  canCreateProfile,
  sourceProfileDirectory,
  onSourceProfileChange,
  target,
  targetError,
  onTargetChange,
  onCancel,
  onImport,
}: ConfigureStepProps) {
  const targetMissing =
    target.kind === "existing" &&
    !targetProfiles.some((profile) => profile.id === target.profileId);
  const targetUncreatable = target.kind === "new" && !canCreateProfile;
  const targetFeedback =
    targetError ??
    (targetMissing
      ? "此浏览器配置已不可用，请重新选择 Cookie 的导入位置。"
      : targetUncreatable
        ? "浏览器配置数量已达上限，请选择已有配置作为导入目标。"
        : undefined);
  return (
    <>
      <DialogHeader>
        <DialogTitle>导入来源 {source.name}</DialogTitle>
        <DialogDescription>选择要为 {destinationEnvironmentName} 导入的 Cookie。</DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
          <section className="flex-1 space-y-2">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              来源
            </p>
            {source.profiles.map((profile) => (
              <SelectableTile
                key={profile.directory}
                selected={sourceProfileDirectory === profile.directory}
                title={profile.name}
                subtitle={cookieCountLabel(profile.cookieCount)}
                onSelect={() => onSourceProfileChange(profile.directory)}
              />
            ))}
          </section>
          <div className="flex shrink-0 items-center justify-center text-muted-foreground">
            <ArrowDownIcon className="size-4 sm:hidden" />
            <ArrowRightIcon className="hidden size-4 sm:block" />
          </div>
          <section className="flex-1 space-y-2">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              目标
            </p>
            {canCreateProfile ? (
              <SelectableTile
                selected={target.kind === "new"}
                title="新浏览器配置"
                subtitle="为这些 Cookie 创建"
                onSelect={() => onTargetChange({ kind: "new" })}
              />
            ) : null}
            {targetProfiles.map((profile) => (
              <SelectableTile
                key={profile.id}
                selected={target.kind === "existing" && target.profileId === profile.id}
                title={profile.name}
                subtitle="已有浏览器配置"
                onSelect={() => onTargetChange({ kind: "existing", profileId: profile.id })}
              />
            ))}
          </section>
        </div>
        {targetFeedback ? (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {targetFeedback}
          </p>
        ) : null}
      </DialogPanel>
      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>
          取消
        </Button>
        <Button
          disabled={sourceProfileDirectory === "" || targetMissing || targetUncreatable}
          onClick={onImport}
        >
          导入
        </Button>
      </DialogFooter>
    </>
  );
}

function SelectableTile({
  selected,
  title,
  subtitle,
  onSelect,
}: {
  readonly selected: boolean;
  readonly title: string;
  readonly subtitle?: string | undefined;
  readonly onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        "flex w-full cursor-pointer items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
        selected
          ? "border-primary bg-primary/8"
          : "border-border/60 hover:border-border hover:bg-muted/40",
      )}
    >
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-foreground">{title}</span>
        {subtitle ? (
          <span className="block truncate text-xs tabular-nums text-muted-foreground">
            {subtitle}
          </span>
        ) : null}
      </span>
      <span
        className={cn(
          "grid size-4 shrink-0 place-items-center rounded-full border",
          selected ? "border-primary bg-primary text-primary-foreground" : "border-input",
        )}
      >
        {selected ? <CheckIcon className="size-2.5" /> : null}
      </span>
    </button>
  );
}

function ImportingStep() {
  return (
    <>
      <DialogHeader>
        <DialogTitle>正在导入 Cookie</DialogTitle>
        <DialogDescription>可能需要一点时间。</DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="flex items-center gap-3 py-2">
          <Spinner size="md" tone="muted" />
          <span className="text-sm text-muted-foreground">正在导入…</span>
        </div>
      </DialogPanel>
    </>
  );
}

function CheckingStep({
  sourceName,
  check,
}: {
  readonly sourceName: string;
  readonly check: "browser" | "fullDiskAccess";
}) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>正在检查… {sourceName}</DialogTitle>
        <DialogDescription>
          {check === "fullDiskAccess" ? "正在检查完全磁盘访问权限。" : "正在检查浏览器是否已关闭。"}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="flex items-center gap-3 py-2">
          <Spinner size="md" tone="muted" />
          <span className="text-sm text-muted-foreground">
            {check === "fullDiskAccess" ? "正在检查访问权限…" : "正在检查…"}
          </span>
        </div>
      </DialogPanel>
    </>
  );
}

function DoneStep({
  imported,
  skipped,
  skippedDomains,
  targetName,
  destinationEnvironmentName,
  onClose,
}: {
  readonly imported: number;
  readonly skipped: number;
  readonly skippedDomains: ReadonlyArray<string>;
  readonly targetName: string;
  readonly destinationEnvironmentName: string;
  readonly onClose: () => void;
}) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {imported > 0
            ? `Imported ${cookieResultCount(imported)}`
            : skipped > 0
              ? `Skipped ${cookieResultCount(skipped)}`
              : "未找到 Cookie"}
        </DialogTitle>
        <DialogDescription>
          {imported > 0
            ? `Added to ${targetName} for ${destinationEnvironmentName}.${skipped > 0 ? ` ${cookieResultCount(skipped)} skipped.` : ""}`
            : skipped > 0
              ? `未为 ${destinationEnvironmentName} 导入任何 Cookie。`
              : `没有可为 ${destinationEnvironmentName} 导入的 Cookie。`}
        </DialogDescription>
      </DialogHeader>
      {skippedDomains.length > 0 ? (
        <DialogPanel>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            已跳过
          </p>
          <p className="mt-1 text-sm text-foreground">{formatSkippedDomains(skippedDomains)}</p>
        </DialogPanel>
      ) : null}
      <DialogFooter>
        <DialogClose render={<Button />} onClick={onClose}>
          完成
        </DialogClose>
      </DialogFooter>
    </>
  );
}

function BlockedStep({
  source,
  reason,
  message,
  onClose,
  onRetry,
}: {
  readonly source: BrowserImportSource;
  readonly reason: keyof typeof BROWSER_IMPORT_FAILURE_COPY;
  readonly message: string | undefined;
  readonly onClose: () => void;
  readonly onRetry: (() => void) | undefined;
}) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>无法从 {source.name} 导入</DialogTitle>
        <DialogDescription>{message ?? BROWSER_IMPORT_FAILURE_COPY[reason]}</DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          关闭
        </Button>
        {onRetry ? <DialogAction onClick={onRetry}>重试</DialogAction> : null}
      </DialogFooter>
    </>
  );
}

import {
  cancelEnvironmentSpeechModelDownload,
  downloadEnvironmentSpeechModel,
  getEnvironmentSpeechModels,
  getEnvironmentSpeechStatus,
  linkEnvironmentSpeechModels,
  removeEnvironmentSpeechModel,
  selectEnvironmentSpeechModel,
  updateEnvironmentSpeechAcceleration,
  updateEnvironmentSpeechModelUnloadTimeout,
} from "@t3tools/client-runtime/voice-input";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { openRouterIcon } from "@t3tools/client-runtime/provider-clients";
import {
  AuthFilesystemReadScope,
  AuthSettingsWriteScope,
  CLOUD_SPEECH_LABELS,
  CloudSpeechProvider,
  DEFAULT_SPEECH_POST_PROCESSING_PROMPT,
  type EnvironmentId,
  type EnvironmentSpeechModel,
  type EnvironmentSpeechStatus,
  type ProjectId,
  ProviderDriverKind,
  type SpeechAcceleration,
  type SpeechBenchmarkTier,
  type SpeechCustomWords,
  type SpeechModelUnloadTimeout,
  type VoiceShortcutMode,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { resolveSpeechPostProcessingModelSelection } from "@t3tools/shared/serverSettings";
import { cloudSpeechLanguages } from "@t3tools/shared/speech";
import {
  ArrowDownUpIcon,
  AudioLinesIcon,
  CheckIcon,
  DownloadIcon,
  LanguagesIcon,
  KeyRoundIcon,
  MonitorIcon,
  MicOffIcon,
  MicIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  StarIcon,
  Trash2Icon,
  UnlinkIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";
import { cn } from "~/lib/utils";
import {
  listAudioInputs,
  updateMicrophoneOrder,
  type BrowserMicrophone,
} from "../../speech/browserMicrophones";
import {
  microphoneOrder,
  preferredMicrophoneId,
  rememberMicrophones,
} from "../../speech/microphoneOrder";
import { preferredSpeechLanguages } from "../../speech/preferredSpeechLanguages";
import {
  chooseAudioDestination,
  chooseTranscriptCleanup,
  useCleanupGrant,
} from "../../speech/voiceConsent";
import { updateClientSettings, useClientSettings } from "../../hooks/useSettings";
import { runEnvironmentSpeech } from "../../speech/runEnvironmentSpeech";
import {
  getTextGenerationModelOptionsByInstance,
  resolveAppModelSelectionState,
} from "../../modelSelection";
import { useTextGenerationTargets } from "../../textGenerators";
import { useEnvironmentProviders, useEnvironments } from "../../state/environments";
import { useEnvironmentScope } from "../../state/session";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import {
  useEnvironmentSpeechInput,
  useVoiceTranscriptionDestination,
} from "../../speech/useEnvironmentSpeechInput";
import { ComposerSpeechRecordingPill } from "../chat/ComposerSpeechButton";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { ProviderPackageIcon } from "../chat/ProviderPackageIcon";
import { TraitsPicker } from "../chat/TraitsPicker";
import { VoiceInputSetup } from "../chat/VoiceInputSetup";
import { Badge } from "../ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuSearchInput,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { MicrophoneOrderList } from "./MicrophoneOrderList";
import { MicrophoneTest } from "./MicrophoneTest";
import { CloudVoiceConfiguration } from "./CloudVoiceConfiguration";
import { ModelBenchmarks, orderSpeechLanguages } from "./SpeechModelComparison";
import { languageLabel, SpeechLanguageSelect } from "./SpeechLanguageSelect";
import { filterSpeechModels, type SpeechModelSort } from "./speechModelBrowser";
import { AdvancedSettings } from "./AdvancedSettings";
import {
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingsPageContainer,
  SettingsRow,
  SettingsSearchTarget,
  SettingsSection,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useOptionalSettingsScope, useSettingsScope } from "./SettingsScopeContext";
import { useScopedModelDisabledReason } from "./useScopedModelAvailability";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const OFF = "off";
function CloudSpeechLogo({ provider }: { provider: CloudSpeechProvider }) {
  if (provider === "openrouter")
    return <ProviderPackageIcon icon={openRouterIcon} aria-hidden className="size-4 shrink-0" />;
  return (
    <ProviderInstanceIcon
      driverKind={ProviderDriverKind.make(provider === "openai" ? "codex" : "grok")}
      displayName={CLOUD_SPEECH_LABELS[provider]}
      iconClassName="size-4"
    />
  );
}
const formatSize = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`;
const SHORTCUT_MODES: Record<VoiceShortcutMode, { label: string; hint: string }> = {
  auto: { label: "自动", hint: "点按切换，按住说话。" },
  hold: { label: "长按", hint: "按住期间录音" },
  toggle: { label: "开关", hint: "点按开始，再点按停止" },
};
const UNLOAD_LABELS: Record<SpeechModelUnloadTimeout, string> = {
  never: "从不",
  immediately: "立即",
  min_2: "2 分钟后",
  min_5: "5 分钟后",
  min_10: "10 分钟后",
  min_15: "15 分钟后",
  hour_1: "1 小时后",
};
const normalizeTerm = (value: string) => value.replace(/\s+/g, " ").trim().normalize("NFC");
const spellingsOf = (words: SpeechCustomWords) =>
  new Set(
    words.flatMap(({ term, aliases }) =>
      [term, ...aliases].map((spelling) => spelling.toLocaleLowerCase()),
    ),
  );

type ModelCardProps = {
  readonly model: EnvironmentSpeechModel;
  readonly comparisonLanguages: readonly string[];
  readonly benchmarkTier: SpeechBenchmarkTier;
  readonly busy: boolean;
  readonly canCancel: boolean;
  readonly onDownload: () => void;
  readonly onSelect: () => void;
  readonly onCancel: () => void;
  readonly onDelete: () => void;
  readonly testControls?: ReactNode;
  /** Keeps the controls under the text, so a live test never squeezes the model's details. */
  readonly stacked?: boolean;
  readonly children?: ReactNode;
};

function ModelBadge(props: { icon: ReactNode; label: string; tooltip: string }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<Badge variant="outline" />}>
        {props.icon}
        {props.label}
      </TooltipTrigger>
      <TooltipPopup side="top">{props.tooltip}</TooltipPopup>
    </Tooltip>
  );
}

function ModelCard(props: ModelCardProps) {
  const { model } = props;
  const downloading = model.state === "downloading" || model.state === "verifying";
  const progress = model.downloaded === undefined ? 0 : (model.downloaded / model.size) * 100;
  return (
    <div className="@container/model px-3 py-3">
      <div
        className={cn(
          "flex flex-col gap-2.5",
          !props.stacked &&
            "@min-[28rem]/model:flex-row @min-[28rem]/model:items-start @min-[28rem]/model:gap-4",
        )}
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-medium leading-5">{model.name}</span>
            {model.recommended ? (
              <ModelBadge
                icon={<StarIcon className="mr-1 size-3" />}
                label="推荐"
                tooltip="转写其支持的语言时，推荐优先选用此模型。"
              />
            ) : null}
            {model.supportsStreaming ? (
              <ModelBadge
                icon={<AudioLinesIcon className="mr-1 size-3" />}
                label="实时预览"
                tooltip="说话时就会在草稿中显示文字，无需等到录音结束。"
              />
            ) : null}
            {model.supportsTranslation ? (
              <ModelBadge
                icon={<LanguagesIcon className="mr-1 size-3" />}
                label="翻译"
                tooltip="可将其他语言的语音转为英文。开启“翻译为英文”即可使用。"
              />
            ) : null}
          </div>
          {model.description ? (
            <p className="mt-0.5 text-xs leading-normal text-muted-foreground">
              {model.description}
            </p>
          ) : null}
          {model.linkedFrom ? (
            <p className="mt-0.5 break-all text-2xs text-muted-foreground">
              正在使用你的文件 {model.linkedFrom}
            </p>
          ) : null}
          <ModelBenchmarks
            model={model}
            languages={props.comparisonLanguages}
            tier={props.benchmarkTier}
            facts={[
              ...(model.languages.length > 1
                ? [`${model.languages.length} 种语言`]
                : model.benchmark
                  ? []
                  : [languageLabel(model.languages[0] ?? "")]),
              formatSize(model.size),
            ]}
          />
          {downloading ? (
            <div className="mt-2">
              <div
                role="progressbar"
                aria-label={`${model.name} 下载进度`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(progress)}
                className="h-1 overflow-hidden rounded-full bg-muted"
              >
                <div
                  className="h-full bg-primary transition-[width] duration-200"
                  style={{ width: `${progress}%` }}
                />
              </div>
              <p className="mt-1 text-2xs text-muted-foreground">
                {model.state === "verifying"
                  ? "正在校验下载内容…"
                  : `已下载 ${Math.round(progress)}%`}
              </p>
            </div>
          ) : null}
        </div>
        <div className="flex max-w-full shrink-0 flex-wrap items-center gap-1.5">
          {props.testControls}
          {downloading ? (
            <Button
              size="icon-sm"
              variant="outline"
              aria-label={`取消下载 ${model.name}`}
              disabled={!props.canCancel}
              onClick={props.onCancel}
            >
              <XIcon className="size-3.5" />
            </Button>
          ) : model.state === "downloadable" ? (
            <Button size="sm" variant="outline" disabled={props.busy} onClick={props.onDownload}>
              <DownloadIcon />
              下载
            </Button>
          ) : model.active ? (
            <Button size="sm" variant="secondary" disabled>
              <CheckIcon />
              已选择
            </Button>
          ) : (
            <Button size="sm" variant="outline" disabled={props.busy} onClick={props.onSelect}>
              使用模型
            </Button>
          )}
          {model.state === "installed" ? (
            <Button
              size="icon-sm"
              variant="outline"
              disabled={props.busy}
              aria-label={
                model.linkedFrom
                  ? `停止使用你的 ${model.name} 文件；文件仍保留在磁盘上`
                  : `删除 ${model.name}`
              }
              onClick={props.onDelete}
            >
              {model.linkedFrom ? <UnlinkIcon /> : <Trash2Icon />}
            </Button>
          ) : null}
        </div>
      </div>
      {props.children}
    </div>
  );
}

function DictionaryEditor(props: {
  readonly label: string;
  readonly words: SpeechCustomWords;
  readonly disabled?: boolean;
  readonly onChange: (words: SpeechCustomWords) => void;
}) {
  const { words, label, disabled = false, onChange } = props;
  const [termDraft, setTermDraft] = useState("");
  const [aliasDraft, setAliasDraft] = useState<{ term: string; value: string } | null>(null);
  const spellings = spellingsOf(words);
  const seen = new Set(spellings);
  const newTerms = termDraft
    .split(/[,\n]/)
    .map(normalizeTerm)
    .filter((term) => {
      const key = term.toLocaleLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const canAddTerm =
    !disabled &&
    newTerms.length > 0 &&
    newTerms.every((term) => term.length <= 50) &&
    words.length + newTerms.length <= 100;
  const addTerm = () => {
    if (!canAddTerm) return;
    onChange([...words, ...newTerms.map((term) => ({ term, aliases: [] }))]);
    setTermDraft("");
  };
  const addAlias = () => {
    if (!aliasDraft) return;
    const value = normalizeTerm(aliasDraft.value);
    if (!value || value.length > 50 || spellings.has(value.toLocaleLowerCase())) return;
    onChange(
      words.map((entry) =>
        entry.term === aliasDraft.term && entry.aliases.length < 8
          ? { term: entry.term, aliases: [...entry.aliases, value] }
          : entry,
      ),
    );
    setAliasDraft(null);
  };
  return (
    <>
      <div className="flex items-start gap-2">
        {/* One line while empty, so a wrapped placeholder never makes the field taller than Add. */}
        <div className="min-w-0 flex-1 [&_textarea]:placeholder-shown:whitespace-nowrap">
          <Textarea
            value={termDraft}
            rows={1}
            maxLength={5_100}
            disabled={disabled}
            placeholder="添加词语，用逗号分隔"
            aria-label={`向 ${label} 添加词语或短语`}
            onChange={(event) => setTermDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) return;
              if (event.key !== "Enter" || event.shiftKey) return;
              event.preventDefault();
              addTerm();
            }}
          />
        </div>
        <Button type="button" variant="outline" disabled={!canAddTerm} onClick={addTerm}>
          <PlusIcon />
          添加
        </Button>
      </div>
      {words.length > 0 ? (
        <ul
          aria-label={`${label} 条目`}
          className="mt-2.5 flex flex-col gap-1.5 @min-[32rem]/settings-row:flex-row @min-[32rem]/settings-row:flex-wrap"
        >
          {words.map(({ term, aliases }) => (
            <li
              key={term}
              className="flex items-center gap-1 rounded-md border border-border/60 bg-muted/30 py-0.5 pl-2 pr-0.5 text-xs"
            >
              <span className="font-medium">{term}</span>
              {aliases.length > 0 ? (
                <span className="text-muted-foreground">← {aliases.join(", ")}</span>
              ) : null}
              {aliasDraft?.term === term ? (
                <Input
                  autoFocus
                  value={aliasDraft.value}
                  maxLength={50}
                  aria-label={`${term} 的别名`}
                  placeholder="错误拼写"
                  className="ms-auto w-32"
                  onChange={(event) => setAliasDraft({ term, value: event.target.value })}
                  onBlur={() => setAliasDraft(null)}
                  onKeyDown={(event) => {
                    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                    if (event.key === "Escape") setAliasDraft(null);
                    if (event.key !== "Enter") return;
                    event.preventDefault();
                    addAlias();
                  }}
                />
              ) : (
                <Button
                  type="button"
                  size="xs"
                  variant="ghost-muted"
                  className="ms-auto"
                  disabled={disabled || aliases.length >= 8}
                  aria-label={`为 ${term} 添加别名`}
                  onClick={() => setAliasDraft({ term, value: "" })}
                >
                  别名
                </Button>
              )}
              <Button
                type="button"
                size="icon-xs"
                variant="ghost-muted"
                disabled={disabled}
                aria-label={`移除 ${term}`}
                onClick={() => onChange(words.filter((entry) => entry.term !== term))}
              >
                <XIcon />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

/** Vocabulary stored on the environment with the project, read by everyone who dictates there. */
function ProjectDictionaryRow() {
  const scope = useOptionalSettingsScope();
  const words = useScopedSettings((settings) => settings.speechProjectCustomWords);
  const updateScopedSettings = useUpdateScopedSettings();
  if (scope === null) return null;
  const isProjectScope = scope.scope.kind === "project" || scope.scope.kind === "checkout";
  return (
    <SettingsRow
      serverScoped
      settingKeys={["speechProjectCustomWords"]}
      {...searchableSetting("speech-project-dictionary")}
      title={isProjectScope ? "项目词典" : "共享词典"}
      description={
        isProjectScope
          ? `${scope.scope.label} 里说话的人都会用到这些词。`
          : "在这个环境里说话的人都会用到这些词。"
      }
    >
      <div className="mt-3 pb-2">
        <DictionaryEditor
          label={isProjectScope ? "项目词典" : "共享词典"}
          words={words}
          disabled={scope.connectedEnvironments.length === 0}
          onChange={(next) => updateScopedSettings({ speechProjectCustomWords: next })}
        />
      </div>
    </SettingsRow>
  );
}

/** Cleanup runs on the draft's environment, so its model is an environment setting there. */
function CleanupModelRow() {
  const { environment, connectedEnvironments } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const providersByEnvironment = useEnvironmentProviders();
  const providers =
    (environment?.serverConfig
      ? providersByEnvironment.get(environment.environmentId)
      : undefined) ?? EMPTY_SERVER_PROVIDERS;
  const targets = useTextGenerationTargets({
    environmentId: environment?.environmentId ?? null,
    settings,
    providers: providers.filter((provider) => provider.supportsTextGeneration !== false),
    projectId: null,
    selections: [
      settings.speechPostProcessingModelSelection,
      settings.textGenerationModelSelection,
    ],
  });
  const textGenerationProviders = targets.providers;
  const instanceEntries = targets.entries;
  const hasProvider = instanceEntries.some((entry) => entry.enabled && entry.isAvailable);
  const dedicated = settings.speechPostProcessingModelSelection !== null;
  const selection = resolveAppModelSelectionState(
    {
      ...settings,
      textGenerationModelSelection: resolveSpeechPostProcessingModelSelection(
        settings,
        textGenerationProviders,
      ),
    },
    textGenerationProviders,
  );
  const modelOptionsByInstance = getTextGenerationModelOptionsByInstance(
    settings,
    textGenerationProviders,
    selection.instanceId,
    selection.model,
  );
  const instanceEntry = instanceEntries.find((entry) => entry.instanceId === selection.instanceId);
  const modelDisabledReason = useScopedModelDisabledReason(settings, instanceEntries, true);
  const setModel = (next: ReturnType<typeof createModelSelection>) => {
    const reason = modelDisabledReason(next.instanceId, next.model);
    if (reason) {
      toastManager.add({ type: "error", title: "未保存文本整理模型", description: reason });
      return;
    }
    updateSettings({ speechPostProcessingModelSelection: next });
  };
  return (
    <SettingsRow
      serverScoped
      settingKeys={["speechPostProcessingModelSelection"]}
      {...searchableSetting("speech-post-processing-model")}
      title="文本整理模型"
      description="整理转写文本所用的模型，例如更便宜或更快的模型。关闭时使用此环境配置的文本生成模型。"
      control={
        connectedEnvironments.length === 0 ? (
          <span className="text-sm text-muted-foreground">请先连接一个环境。</span>
        ) : (
          <div className="flex min-w-0 flex-wrap items-center gap-2 @min-[32rem]/settings-row:justify-end">
            {dedicated && (!hasProvider || !instanceEntry) ? (
              <span className="text-sm text-muted-foreground">没有可用的文本生成提供方。</span>
            ) : null}
            {dedicated && hasProvider && instanceEntry ? (
              <>
                <ProviderModelPicker
                  environmentId={environment?.environmentId ?? null}
                  activeInstanceId={selection.instanceId}
                  model={selection.model}
                  lockedProvider={null}
                  instanceEntries={instanceEntries}
                  modelOptionsByInstance={modelOptionsByInstance}
                  triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                  getModelDisabledReason={modelDisabledReason}
                  onInstanceModelChange={(instanceId, model) =>
                    setModel(createModelSelection(instanceId, model))
                  }
                />
                <TraitsPicker
                  provider={instanceEntry.driverKind}
                  models={instanceEntry.models}
                  model={selection.model}
                  modelOptions={selection.options ?? []}
                  allowPromptInjectedEffort={false}
                  triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                  onModelOptionsChange={(options) =>
                    setModel(createModelSelection(selection.instanceId, selection.model, options))
                  }
                />
              </>
            ) : null}
            <Switch
              checked={dedicated}
              disabled={!dedicated && !hasProvider}
              onCheckedChange={(checked) =>
                updateSettings({
                  speechPostProcessingModelSelection: checked
                    ? createModelSelection(
                        settings.textGenerationModelSelection.instanceId,
                        settings.textGenerationModelSelection.model,
                        settings.textGenerationModelSelection.options,
                      )
                    : null,
                })
              }
              aria-label="使用单独的文本整理模型"
            />
          </div>
        )
      }
    />
  );
}

function useVoiceModels(prepared: PreparedConnection | null) {
  const canManage = useEnvironmentScope(prepared?.environmentId ?? null, AuthSettingsWriteScope);
  const [models, setModels] = useState<readonly EnvironmentSpeechModel[]>([]);
  const [status, setStatus] = useState<EnvironmentSpeechStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [requestedDownload, setRequestedDownload] = useState<string | null>(null);
  const [actionConnection, setActionConnection] = useState(prepared);
  if (actionConnection !== prepared) {
    setActionConnection(prepared);
    setBusy(false);
    setRequestedDownload(null);
    setModels([]);
    setStatus(null);
  }
  const epoch = useRef(0);
  const refreshRevision = useRef(0);
  const refresh = useStableCallback(
    async (connection: PreparedConnection, mode: "foreground" | "progress") => {
      const current = epoch.current;
      const revision = ++refreshRevision.current;
      try {
        const [nextStatus, nextModels] = await Promise.all([
          runEnvironmentSpeech(getEnvironmentSpeechStatus(connection)),
          runEnvironmentSpeech(getEnvironmentSpeechModels(connection, mode === "foreground")),
        ]);
        if (current !== epoch.current || revision !== refreshRevision.current) return;
        setStatus(nextStatus);
        setModels((previous) => {
          if (mode === "foreground") return nextModels.models;
          const benchmarks = new Map(previous.map((model) => [model.id, model.benchmark]));
          return nextModels.models.map((model) => {
            const benchmark = benchmarks.get(model.id);
            return benchmark ? { ...model, benchmark } : model;
          });
        });
      } catch (error) {
        if (mode === "progress") return;
        if (current !== epoch.current || revision !== refreshRevision.current) return;
        toastManager.add({
          type: "error",
          title: "无法加载转写模型",
          description: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the environment's model catalog when its connection becomes available
  useEffect(() => {
    epoch.current += 1;
    if (prepared) void refresh(prepared, "foreground");
    return () => {
      epoch.current += 1;
    };
  }, [prepared, refresh]);
  const downloading =
    requestedDownload !== null ||
    models.some((model) => model.state === "downloading" || model.state === "verifying");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polls progress while a local request or the environment reports an active download
  useEffect(() => {
    if (!prepared || !downloading) return;
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      await refresh(prepared, "progress");
      if (!cancelled) timer = window.setTimeout(() => void poll(), 1_000);
    };
    void poll();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [downloading, prepared, refresh]);

  const run = async (label: string, work: () => Promise<unknown>, downloadId?: string) => {
    if (!prepared || !canManage) return;
    const current = epoch.current;
    if (downloadId) setRequestedDownload(downloadId);
    else setBusy(true);
    try {
      await work();
    } catch (error) {
      if (current === epoch.current)
        toastManager.add({
          type: "error",
          title: label,
          description: error instanceof Error ? error.message : String(error),
        });
    }
    if (current === epoch.current) {
      if (downloadId) setRequestedDownload(null);
      else setBusy(false);
      await refresh(prepared, "foreground");
    }
  };
  return {
    models,
    status,
    run,
    controlsDisabled: busy || downloading || !canManage,
    canCancel: canManage && !busy,
    requestedDownload,
  };
}

type VoiceModels = ReturnType<typeof useVoiceModels>;

function AdvancedSpeechSettings({
  prepared,
  catalog,
}: {
  prepared: PreparedConnection;
  catalog: VoiceModels;
}) {
  const { run, controlsDisabled, status } = catalog;
  if (!status?.supported) return null;
  const supported = status;
  return (
    <AdvancedSettings targetIds={[searchableSetting("speech-hardware").id]}>
      <SettingsRow
        {...searchableSetting("speech-hardware")}
        title="硬件"
        description="选择“自动”时，环境有 GPU 就会使用 GPU。"
        control={
          <Select
            value={supported.acceleration}
            disabled={controlsDisabled}
            onValueChange={(value) => {
              if (value)
                void run("无法更改转写硬件", () =>
                  runEnvironmentSpeech(
                    updateEnvironmentSpeechAcceleration(prepared, value as SpeechAcceleration),
                  ),
                );
            }}
          >
            <SelectTrigger size="sm" aria-label="转写硬件" className="max-w-72">
              <SelectValue>
                {supported.acceleration === "auto"
                  ? "自动"
                  : supported.acceleration === "cpu"
                    ? "CPU"
                    : (supported.gpuDevices.find(
                        (device) => `gpu:${device.id}` === supported.acceleration,
                      )?.name ?? "已选择的 GPU")}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem value="auto">自动</SelectItem>
              <SelectItem value="cpu">CPU</SelectItem>
              {supported.gpuDevices.map((device) => (
                <SelectItem key={device.id} value={`gpu:${device.id}`}>
                  {device.name}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        title="从内存卸载模型"
        description="模型闲置达到指定时长后，释放它在环境中占用的内存。"
        control={
          <Select
            value={supported.modelUnloadTimeout}
            disabled={controlsDisabled}
            onValueChange={(value) => {
              if (value)
                void run("无法更改模型从内存卸载的时机", () =>
                  runEnvironmentSpeech(
                    updateEnvironmentSpeechModelUnloadTimeout(
                      prepared,
                      value as SpeechModelUnloadTimeout,
                    ),
                  ),
                );
            }}
          >
            <SelectTrigger size="sm" aria-label="从内存卸载模型" className="max-w-72">
              <SelectValue>{UNLOAD_LABELS[supported.modelUnloadTimeout]}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {(Object.keys(UNLOAD_LABELS) as SpeechModelUnloadTimeout[]).map((timeout) => (
                <SelectItem key={timeout} value={timeout}>
                  {UNLOAD_LABELS[timeout]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
    </AdvancedSettings>
  );
}

function SpeechModelBrowser(props: {
  prepared: PreparedConnection;
  catalog: VoiceModels;
  testEnvironmentId: EnvironmentId;
  projectId: ProjectId | null;
  projectName: string | null;
}) {
  const {
    prepared,
    catalog: { status, models, run, controlsDisabled, canCancel, requestedDownload },
  } = props;
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SpeechModelSort>("recommended");
  const [downloadedOnly, setDownloadedOnly] = useState(false);
  const [existingPath, setExistingPath] = useState("");
  const canReadFiles = useEnvironmentScope(prepared.environmentId, AuthFilesystemReadScope);
  const [languageSearch, setLanguageSearch] = useState("");
  const [selection, setSelection] = useState<string[] | null>(null);
  const [preferred] = useState(preferredSpeechLanguages);
  const supportedLanguages = [...new Set(models.flatMap((model) => model.languages))];
  const defaultLanguage = preferred.find((code) => supportedLanguages.includes(code));
  const selectedLanguages = selection ?? (defaultLanguage ? [defaultLanguage] : []);
  const languages = orderSpeechLanguages(supportedLanguages, preferred);
  const needle = languageSearch.trim().toLocaleLowerCase();
  const visibleLanguages = languages.filter(
    (code) =>
      !needle || code.includes(needle) || languageLabel(code).toLocaleLowerCase().includes(needle),
  );
  const accuracyLanguage = selectedLanguages[0] ?? "en";
  const sortLabels: Record<SpeechModelSort, string> = {
    recommended: "推荐",
    size: "最小",
    accuracy: "最准确",
    speed: "最快",
  };
  const languagesLabel =
    selectedLanguages.length === 0 ? "所有语言" : selectedLanguages.map(languageLabel).join(", ");
  const sortedModels = filterSpeechModels(models, {
    search,
    languages: selectedLanguages,
    downloadedOnly,
    sort,
    accuracyLanguage,
    benchmarkTier: status?.supported ? status.benchmarkTier : "accelerated",
  });
  const activeModel = models.find((model) => model.active);
  const renderedModels =
    activeModel && !sortedModels.includes(activeModel)
      ? [activeModel, ...sortedModels]
      : sortedModels;

  if (!status) return null;
  if (!status.supported)
    return (
      <SettingsRow
        {...searchableSetting("speech-models")}
        title="模型"
        description={`此环境无法转写音频：${status.reason}。`}
      />
    );
  return (
    <SettingsRow
      {...searchableSetting("speech-models")}
      title="模型"
      description={`分数是错误率，速度是每 30 秒音频用掉的秒数，来自 Handy 的${status.benchmarkTier === "cpu" ? "CPU" : "GPU"}基准。`}
      className="@container/voice-models"
    >
      <div className="mt-3 flex min-w-0 gap-2">
        <InputGroup className="min-w-0 flex-1 **:[input]:h-9 sm:**:[input]:h-8">
          <InputGroupAddon>
            <SearchIcon aria-hidden />
          </InputGroupAddon>
          <InputGroupInput
            type="search"
            aria-label="搜索转写模型"
            placeholder="搜索模型"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </InputGroup>
        <Menu>
          <MenuTrigger
            render={<Button variant="outline" className="max-w-56" />}
            aria-label={`按语言筛选：${languagesLabel}`}
          >
            <LanguagesIcon />
            <span className="hidden truncate @min-[34rem]/voice-models:inline">
              {languagesLabel}
            </span>
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuSearchInput
              autoFocus
              aria-label="搜索语言"
              placeholder="搜索语言"
              value={languageSearch}
              onChange={(e) => setLanguageSearch(e.target.value)}
            />
            <div role="group" aria-label="按语言浏览模型" className="max-h-72 overflow-y-auto">
              {needle ? null : (
                <MenuCheckboxItem
                  checked={selectedLanguages.length === 0}
                  onCheckedChange={() => setSelection([])}
                >
                  所有语言
                </MenuCheckboxItem>
              )}
              {visibleLanguages.map((code) => (
                <MenuCheckboxItem
                  key={code}
                  checked={selectedLanguages.includes(code)}
                  onCheckedChange={() =>
                    setSelection(
                      selectedLanguages.includes(code)
                        ? selectedLanguages.filter((language) => language !== code)
                        : [...selectedLanguages, code],
                    )
                  }
                >
                  {languageLabel(code)}
                </MenuCheckboxItem>
              ))}
              {visibleLanguages.length === 0 && (
                <p className="px-2 py-1.5 text-sm text-muted-foreground">没有匹配的语言。</p>
              )}
            </div>
          </MenuPopup>
        </Menu>
        <Menu>
          <MenuTrigger
            render={<Button variant="outline" />}
            aria-label={`排序和筛选模型：${sortLabels[sort]}${downloadedOnly ? "，仅已下载" : ""}`}
          >
            <ArrowDownUpIcon />
            <span className="hidden @min-[34rem]/voice-models:inline">{sortLabels[sort]}</span>
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuGroup>
              <MenuGroupLabel>排序方式</MenuGroupLabel>
              <MenuRadioGroup
                value={sort}
                onValueChange={(value) => setSort(value as SpeechModelSort)}
              >
                {(Object.keys(sortLabels) as SpeechModelSort[]).map((value) => (
                  <MenuRadioItem key={value} value={value} closeOnClick>
                    <span className="flex items-center justify-between gap-3">
                      {value === "accuracy"
                        ? `${languageLabel(accuracyLanguage)}最准确`
                        : sortLabels[value]}
                      <MenuRadioItemIndicator />
                    </span>
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuGroup>
            <MenuSeparator />
            <MenuCheckboxItem checked={downloadedOnly} onCheckedChange={setDownloadedOnly}>
              仅已下载
            </MenuCheckboxItem>
          </MenuPopup>
        </Menu>
      </div>
      <div
        className="mt-2 mb-2 max-h-96 divide-y divide-border/60 overflow-y-auto rounded-lg border border-border/60"
        role="region"
        aria-label="转写模型"
        tabIndex={0}
      >
        {sortedModels.length === 0 && (
          <p className="px-3 py-3 text-sm text-muted-foreground">没有匹配的模型。</p>
        )}
        {renderedModels.map((model) => {
          const card: ModelCardProps = {
            model:
              model.id === requestedDownload && model.state === "downloadable"
                ? { ...model, state: "downloading" }
                : model,
            busy: controlsDisabled,
            canCancel,
            comparisonLanguages: selectedLanguages,
            benchmarkTier: status.benchmarkTier,
            onDownload: () =>
              void run(
                "无法下载模型",
                () => runEnvironmentSpeech(downloadEnvironmentSpeechModel(prepared, model.id)),
                model.id,
              ),
            onSelect: () =>
              void run("无法选择模型", () =>
                runEnvironmentSpeech(selectEnvironmentSpeechModel(prepared, model.id)),
              ),
            onCancel: () =>
              void run("无法取消下载", () =>
                runEnvironmentSpeech(cancelEnvironmentSpeechModelDownload(prepared, model.id)),
              ),
            onDelete: () =>
              void run("无法删除模型", () =>
                runEnvironmentSpeech(removeEnvironmentSpeechModel(prepared, model.id)),
              ),
          };
          return model.active ? (
            <TranscriptionTest
              key={model.id}
              card={card}
              hidden={!sortedModels.includes(model)}
              environmentId={props.testEnvironmentId}
              projectId={props.projectId}
              projectName={props.projectName}
            />
          ) : (
            <ModelCard key={model.id} {...card} />
          );
        })}
      </div>
      {status.supportsModelLinking && canReadFiles ? (
        <form
          className="mb-2 flex flex-col items-start gap-2 @min-[28rem]/voice-models:flex-row @min-[28rem]/voice-models:items-center"
          onSubmit={(event) => {
            event.preventDefault();
            void run("无法使用该路径下的模型", async () => {
              await runEnvironmentSpeech(linkEnvironmentSpeechModels(prepared, existingPath));
              setExistingPath("");
            });
          }}
        >
          <div className="w-full min-w-0 flex-1">
            <Input
              size="compact"
              aria-label="此环境上已有的模型文件或文件夹路径"
              placeholder="已在别处下载过？粘贴模型文件或文件夹路径"
              value={existingPath}
              onChange={(e) => setExistingPath(e.target.value)}
            />
          </div>
          <Button
            type="submit"
            size="sm"
            variant="outline"
            disabled={controlsDisabled || !existingPath.trim()}
          >
            使用已有
          </Button>
        </form>
      ) : null}
    </SettingsRow>
  );
}

function TranscriptionTest(props: {
  readonly card: ModelCardProps;
  readonly hidden: boolean;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
  readonly projectName: string | null;
}) {
  const [transcript, setTranscript] = useState<string | null>(null);
  const draft = transcript ?? "";
  const [showTranscript, setShowTranscript] = useState(false);
  const draftRef = useRef(draft);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes the committed draft to the asynchronous transcription controller
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);
  const speech = useEnvironmentSpeechInput({
    environmentId: props.environmentId,
    projectId: props.projectId,
    projectName: props.projectName,
    ownerKey: JSON.stringify([props.environmentId, props.projectId]),
    cleanup: false,
    readDraft: () => ({
      text: draftRef.current,
      selection: { start: draftRef.current.length, end: draftRef.current.length },
    }),
    commitDraft: (text) => setTranscript(text),
  });
  return (
    <SettingsSearchTarget {...searchableSetting("transcription-test")} hidden={props.hidden}>
      <ModelCard
        {...props.card}
        stacked={showTranscript}
        testControls={
          <div className="order-last flex min-w-0 max-w-full basis-full items-center gap-1 @min-[28rem]/model:order-none @min-[28rem]/model:basis-auto">
            <ComposerSpeechRecordingPill
              state={speech.state}
              progress={null}
              level={speech.level}
              onStart={() => void speech.start()}
              onStop={() => void speech.stop()}
              onCancel={() => speech.cancel()}
              onSkipPostProcessing={() => speech.skipPostProcessing()}
            />
            {speech.available ? (
              speech.state.phase === "idle" ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setShowTranscript(true);
                    void speech.start();
                  }}
                >
                  <MicIcon />
                  测试模型
                </Button>
              ) : null
            ) : (
              <span className="text-xs text-muted-foreground">
                {speech.status?.supported === false ? speech.status.reason : "正在等待环境连接"}
              </span>
            )}
          </div>
        }
      >
        {showTranscript ? (
          <div className="mt-3 flex items-start gap-3 rounded-lg border border-border/60 bg-muted/30 py-1 ps-3 pe-1">
            <div className="min-w-0 flex-1 py-1.5">
              {speech.preview || transcript !== null ? null : (
                <p className="text-xs text-muted-foreground">
                  说一句话。已跳过清理，所以你看到的就是模型听到的内容。
                </p>
              )}
              {speech.preview || transcript !== null ? (
                <p
                  role="status"
                  aria-label="测试转写文本"
                  className="select-text whitespace-pre-wrap break-words text-sm leading-relaxed"
                >
                  {speech.preview ? (
                    <>
                      {speech.preview.committed}
                      <span className="text-muted-foreground">{speech.preview.tentative}</span>
                    </>
                  ) : (
                    transcript || "未识别到语音，请重试。"
                  )}
                </p>
              ) : null}
            </div>
            <Button
              size="icon-sm"
              variant="ghost-muted"
              aria-label="关闭模型测试"
              onClick={() => {
                speech.cancel();
                setShowTranscript(false);
              }}
            >
              <XIcon />
            </Button>
          </div>
        ) : null}
      </ModelCard>
      <VoiceInputSetup
        environmentId={speech.transcriptionEnvironmentId}
        open={speech.setup.open}
        step={speech.setup.step}
        status={speech.status}
        model={speech.setup.model}
        language={speech.setup.language}
        downloading={speech.setup.downloading}
        error={speech.setup.error}
        onOpenChange={speech.setup.setOpen}
        onRetryCatalog={speech.setup.retryCatalog}
        onDownload={() => void speech.setup.download()}
        onCancelDownload={() => void speech.setup.cancelDownload()}
        onStartRecording={() => void speech.setup.startRecording()}
      />
    </SettingsSearchTarget>
  );
}

export function VoiceSettingsPanel() {
  const cleanupEnabled = useCleanupGrant() !== null;
  const settings = useClientSettings();
  const settingsScope = useOptionalSettingsScope();
  const destination = useVoiceTranscriptionDestination();
  const canManageKey = useEnvironmentScope(destination.environmentId, AuthSettingsWriteScope);
  const [pendingCloud, setPendingCloud] = useState<{
    provider: CloudSpeechProvider;
    environmentId: EnvironmentId;
  } | null>(null);
  const { environments } = useEnvironments();
  const [microphones, setMicrophones] = useState<BrowserMicrophone[]>([]);
  const prepared = destination.cloudProvider ? null : destination.prepared;
  const catalog = useVoiceModels(prepared);

  const refreshMicrophones = useStableCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const devices = await listAudioInputs();
      setMicrophones(devices);
      updateMicrophoneOrder((order) => rememberMicrophones(order, devices));
    } catch {
      setMicrophones([]);
    }
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to microphone device changes while settings are open
  useEffect(() => {
    queueMicrotask(() => void refreshMicrophones());
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.addEventListener) return;
    const onChange = () => void refreshMicrophones();
    mediaDevices.addEventListener("devicechange", onChange);
    return () => mediaDevices.removeEventListener("devicechange", onChange);
  }, [refreshMicrophones]);
  const modelStatus = catalog.status;
  const target = settingsScope?.target;
  const members = settingsScope?.scope.members;
  const project =
    members?.find(
      (member) => member.environmentId === target?.environmentId && member.id === target.projectId,
    ) ?? members?.[0];

  const order = microphoneOrder(settings);
  const selectedMicrophone = preferredMicrophoneId(order, microphones);
  const environmentChoices = environments.map((environment) => ({
    environment,
    value: JSON.stringify(["environment", environment.environmentId]),
  }));
  const cloudGroups = environments
    .filter(
      (environment) => environment.serverConfig?.environment.capabilities.cloudVoiceTranscription,
    )
    .map((environment) => ({
      environment,
      choices: CloudSpeechProvider.literals.map((provider) => ({
        environment,
        provider,
        value: JSON.stringify(["cloud", environment.environmentId, provider]),
      })),
    }));
  const cloudChoices = cloudGroups.flatMap((group) => group.choices);
  const destinationValue = destination.cloudProvider
    ? JSON.stringify(["cloud", destination.environmentId, destination.cloudProvider])
    : destination.environmentId
      ? JSON.stringify(["environment", destination.environmentId])
      : OFF;
  const cloudEnvironment = environments.find(
    (env) => env.environmentId === pendingCloud?.environmentId,
  );
  // OpenRouter users without settings access still manage their own model choice.
  const manageLabel = destination.cloudProvider === "openrouter" ? "管理 OpenRouter" : "管理密钥";
  const chosenEnvironment = environments.find(
    (environment) => environment.environmentId === destination.environmentId,
  );
  const chosenUnsupported =
    !destination.cloudProvider &&
    chosenEnvironment?.serverConfig != null &&
    chosenEnvironment.serverConfig.environment.capabilities.voiceTranscription !== true;
  const model = prepared && modelStatus?.supported ? modelStatus : null;

  return (
    <SettingsPageContainer
      searchTargetFallbacks={{
        "speech-language":
          model || destination.cloudProvider ? undefined : "voice-transcription-destination",
        "speech-models": prepared ? undefined : "voice-transcription-destination",
        "speech-hardware": prepared && model ? undefined : "voice-transcription-destination",
        "transcription-test": !prepared
          ? "voice-transcription-destination"
          : !model || model.state === "missing-model"
            ? "speech-models"
            : undefined,
        "speech-post-processing-model":
          cleanupEnabled && settingsScope ? undefined : "speech-post-processing",
        "speech-correction-word": cleanupEnabled ? undefined : "speech-post-processing",
      }}
    >
      <SettingsSection id="voice-input" title="输入">
        <SettingsRow
          {...searchableSetting("voice-microphone")}
          title="麦克风"
          description="语音输入使用此列表中第一个已连接的麦克风。"
          control={
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="outline"
                    size="icon-sm"
                    aria-label="刷新麦克风"
                    onClick={() => void refreshMicrophones()}
                  >
                    <RefreshCwIcon />
                  </Button>
                }
              />
              <TooltipPopup>刷新麦克风</TooltipPopup>
            </Tooltip>
          }
        >
          <div className="mt-3 pb-2">
            <MicrophoneOrderList order={order} devices={microphones} />
          </div>
        </SettingsRow>
        <MicrophoneTest
          key={selectedMicrophone}
          microphoneId={selectedMicrophone}
          onMicrophoneAccess={() => void refreshMicrophones()}
        />
        <SettingsRow
          {...searchableSetting("dictation-shortcut-mode")}
          title="听写快捷键"
          description={`${SHORTCUT_MODES[settings.voiceShortcutMode].hint}.`}
          control={
            <Select
              value={settings.voiceShortcutMode}
              onValueChange={(value) => {
                if (value)
                  void updateClientSettings({ voiceShortcutMode: value as VoiceShortcutMode });
              }}
            >
              <SelectTrigger size="sm" aria-label="听写快捷键模式">
                <SelectValue>{SHORTCUT_MODES[settings.voiceShortcutMode].label}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {(Object.keys(SHORTCUT_MODES) as VoiceShortcutMode[]).map((mode) => (
                  <SelectItem key={mode} value={mode}>
                    <span className="flex flex-col">
                      {SHORTCUT_MODES[mode].label}
                      <span className="text-xs text-muted-foreground">
                        {SHORTCUT_MODES[mode].hint}
                      </span>
                    </span>
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
      </SettingsSection>

      <SettingsSection id="voice-transcription" title="转写">
        <SettingsRow
          {...searchableSetting("voice-transcription-destination")}
          title="转写方式"
          description={
            destination.environmentId && chosenUnsupported
              ? `${chosenEnvironment.label} 不能在本地转写音频。请另选一个目的地。`
              : "你说的话在这里变成文字。"
          }
          control={
            <div className="flex w-full min-w-0 items-center gap-1.5 @min-[32rem]/settings-row:w-auto">
              <Select
                value={destinationValue}
                onValueChange={(value) => {
                  if (!value) return;
                  const cloud = cloudChoices.find((choice) => choice.value === value);
                  if (cloud) {
                    setPendingCloud({
                      environmentId: cloud.environment.environmentId,
                      provider: cloud.provider,
                    });
                    return;
                  }
                  setPendingCloud(null);
                  const chosen = environmentChoices.find((choice) => choice.value === value);
                  if (value === OFF) chooseAudioDestination(null);
                  else if (chosen)
                    chooseAudioDestination({
                      kind: "environment",
                      environmentId: chosen.environment.environmentId,
                    });
                }}
              >
                <SelectTrigger
                  size="sm"
                  aria-label="转写方式"
                  className="min-w-0 @min-[32rem]/settings-row:w-auto @min-[32rem]/settings-row:max-w-72"
                >
                  <SelectValue>
                    <span className="flex min-w-0 items-center gap-2">
                      {destination.cloudProvider ? (
                        <CloudSpeechLogo provider={destination.cloudProvider} />
                      ) : destination.environmentId ? (
                        <MonitorIcon aria-hidden className="size-4" />
                      ) : (
                        <MicOffIcon aria-hidden className="size-4" />
                      )}
                      <span className="truncate">
                        {destination.cloudProvider
                          ? CLOUD_SPEECH_LABELS[destination.cloudProvider]
                          : destination.environmentId
                            ? (chosenEnvironment?.label ?? "已选择的环境（不可用）")
                            : "关闭"}
                        {destination.cloudProvider && (
                          <span className="text-muted-foreground">
                            {" via "}
                            {chosenEnvironment?.label ?? "环境不可用"}
                          </span>
                        )}
                      </span>
                    </span>
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem value={OFF}>
                    <span className="flex items-center gap-2">
                      <MicOffIcon aria-hidden className="size-4" />
                      关闭
                    </span>
                  </SelectItem>
                  {environmentChoices.length > 0 && (
                    <SelectGroup>
                      <SelectGroupLabel>在环境中</SelectGroupLabel>
                      {environmentChoices.map(({ environment, value }) => (
                        <SelectItem key={value} value={value}>
                          <span className="flex items-center gap-2">
                            <MonitorIcon aria-hidden className="size-4" />
                            {environment.label}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  )}
                  {cloudGroups.map(({ environment, choices }) => (
                    <SelectGroup key={environment.environmentId}>
                      <SelectGroupLabel>经 {environment.label} 的云端</SelectGroupLabel>
                      {choices.map(({ value, provider }) => (
                        <SelectItem
                          key={value}
                          value={value}
                          aria-label={`${CLOUD_SPEECH_LABELS[provider]}（经由 ${environment.label}）`}
                        >
                          <span className="flex items-center gap-2">
                            <CloudSpeechLogo provider={provider} />
                            {CLOUD_SPEECH_LABELS[provider]}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  ))}
                  {destination.environmentId &&
                  (!chosenEnvironment ||
                    (destination.cloudProvider &&
                      !cloudChoices.some((option) => option.value === destinationValue))) ? (
                    <SelectItem value={destinationValue}>已选择的环境（不可用）</SelectItem>
                  ) : null}
                </SelectPopup>
              </Select>
              {destination.cloudProvider &&
                chosenEnvironment &&
                (canManageKey || destination.cloudProvider === "openrouter") && (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          size="icon-sm"
                          type="button"
                          variant="ghost"
                          aria-label={manageLabel}
                          onClick={() => {
                            if (destination.cloudProvider)
                              setPendingCloud({
                                provider: destination.cloudProvider,
                                environmentId: chosenEnvironment.environmentId,
                              });
                          }}
                        >
                          <KeyRoundIcon aria-hidden className="size-4" />
                        </Button>
                      }
                    />
                    <TooltipPopup>{manageLabel}</TooltipPopup>
                  </Tooltip>
                )}
            </div>
          }
        />
        {pendingCloud && cloudEnvironment && (
          <CloudVoiceConfiguration
            key={JSON.stringify(pendingCloud)}
            provider={pendingCloud.provider}
            environment={cloudEnvironment}
            active={
              destination.environmentId === pendingCloud.environmentId &&
              destination.cloudProvider === pendingCloud.provider
            }
            close={() => setPendingCloud(null)}
          />
        )}
        {(model || destination.cloudProvider) && (
          <SettingsRow
            {...searchableSetting("speech-language")}
            title="语言"
            description={
              destination.cloudProvider
                ? "提供方会自动识别你的语言。"
                : model?.supportsLanguageDetection
                  ? `${model.model} 会自动检测语言。`
                  : `${model?.model ?? "这个模型"} 使用固定语言。`
            }
            control={
              <SpeechLanguageSelect
                model={destination.cloudProvider ? cloudSpeechLanguages : model}
              />
            }
          />
        )}
        {model?.supportsTranslation ? (
          <SettingsRow
            title="翻译为英文"
            description="用任意语言说话，生成英文文本。"
            control={
              <Switch
                aria-label="翻译为英文"
                checked={settings.speechTranslateToEnglish}
                onCheckedChange={(checked) =>
                  void updateClientSettings({ speechTranslateToEnglish: checked })
                }
              />
            }
          />
        ) : null}
        <SettingsRow
          {...searchableSetting("speech-silence-filtering")}
          title="静音过滤"
          description={
            destination.cloudProvider === "openai"
              ? "OpenAI 自己处理静音。"
              : "转写前跳过静音和背景噪声。"
          }
          control={
            <Switch
              aria-label="静音过滤"
              disabled={destination.cloudProvider === "openai"}
              checked={settings.speechSilenceFiltering}
              onCheckedChange={(checked) =>
                void updateClientSettings({ speechSilenceFiltering: checked })
              }
            />
          }
        />
        <SettingsRow
          {...searchableSetting("remove-filler-words")}
          title="移除语气词"
          description="从转写中去掉“嗯”、“啊”这类填充词。"
          control={
            <Switch
              aria-label="移除语气词"
              checked={settings.speechRemoveFillerWords}
              onCheckedChange={(checked) =>
                void updateClientSettings({ speechRemoveFillerWords: checked })
              }
            />
          }
        />
        {prepared ? (
          <SpeechModelBrowser
            key={prepared.environmentId}
            prepared={prepared}
            catalog={catalog}
            testEnvironmentId={
              project?.environmentId ?? target?.environmentId ?? prepared.environmentId
            }
            projectId={project?.id ?? null}
            projectName={project?.title ?? null}
          />
        ) : null}
        {prepared && <AdvancedSpeechSettings prepared={prepared} catalog={catalog} />}
      </SettingsSection>

      <SettingsSection id="voice-dictionary" title="词典">
        <SettingsRow
          {...searchableSetting("speech-dictionary")}
          title="你的词表"
          description="按你的写法记录的名称和术语，保存在这台设备上。"
        >
          <div className="mt-3 pb-2">
            <DictionaryEditor
              label="词典"
              words={settings.speechCustomWords}
              onChange={(words) => void updateClientSettings({ speechCustomWords: words })}
            />
          </div>
        </SettingsRow>
        <ProjectDictionaryRow />
      </SettingsSection>

      <SettingsSection id={searchableSetting("speech-post-processing").id} title="清理">
        <SettingsRow
          title="整理转写文本"
          description="默认关闭。只把转写文本和附近的草稿发给整理模型，不发送音频。"
          control={
            <Switch
              aria-label="整理转写文本"
              checked={cleanupEnabled}
              onCheckedChange={chooseTranscriptCleanup}
            />
          }
        />
        {cleanupEnabled ? (
          <SettingsRow
            title="整理说明"
            description={
              settings.speechPostProcessingPrompt.mode === "custom"
                ? "你自己写的整理要求。"
                : "修正标点、数字、列表，以及说错后改口的地方。"
            }
            control={
              <Select
                value={settings.speechPostProcessingPrompt.mode}
                onValueChange={(value) => {
                  if (value === "default" || value === "custom")
                    void updateClientSettings({
                      speechPostProcessingPrompt: {
                        mode: value,
                        customInstructions:
                          value === "custom" &&
                          !settings.speechPostProcessingPrompt.customInstructions.trim()
                            ? DEFAULT_SPEECH_POST_PROCESSING_PROMPT
                            : settings.speechPostProcessingPrompt.customInstructions,
                      },
                    });
                }}
              >
                <SelectTrigger size="sm" aria-label="文本整理指令">
                  <SelectValue>
                    {settings.speechPostProcessingPrompt.mode === "custom" ? "自定义" : "内置"}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem value="default">内置</SelectItem>
                  <SelectItem value="custom">自定义</SelectItem>
                </SelectPopup>
              </Select>
            }
          >
            {settings.speechPostProcessingPrompt.mode === "custom" ? (
              <div className="mt-3 pb-2">
                <Textarea
                  aria-label="自定义文本整理指令"
                  maxLength={10_000}
                  value={settings.speechPostProcessingPrompt.customInstructions}
                  onChange={(event) =>
                    void updateClientSettings({
                      speechPostProcessingPrompt: {
                        mode: "custom",
                        customInstructions: event.target.value,
                      },
                    })
                  }
                />
              </div>
            ) : null}
          </SettingsRow>
        ) : null}
        {cleanupEnabled && settingsScope !== null ? <CleanupModelRow /> : null}
        {cleanupEnabled ? (
          <SettingsRow
            {...searchableSetting("speech-correction-word")}
            title="纠正提示词"
            description="用来改正口误的那句话，例如“划掉刚才那句”。"
            control={
              <Input
                key={settings.speechCorrectionWord}
                defaultValue={settings.speechCorrectionWord}
                maxLength={50}
                placeholder="不对"
                aria-label="纠正提示词"
                className="@min-[32rem]/settings-row:w-40"
                onBlur={(event) => {
                  const next = event.target.value.trim();
                  if (next !== settings.speechCorrectionWord)
                    void updateClientSettings({ speechCorrectionWord: next });
                }}
              />
            }
          />
        ) : null}
      </SettingsSection>
    </SettingsPageContainer>
  );
}

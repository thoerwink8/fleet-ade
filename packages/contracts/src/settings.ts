import {
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  AuthProvidersManageScope,
  type AuthEnvironmentScope,
} from "./auth.ts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Duration from "effect/Duration";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import * as SchemaGetter from "effect/SchemaGetter";
import {
  ForwardCompatibleNullable,
  ForwardCompatibleOptional,
  OmittedWhenNull,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TrimmedString,
} from "./baseSchemas.ts";
import { DEFAULT_NETWORK_SETTINGS, NetworkSettings } from "./network.ts";
import { UsageLimitSourceId } from "./usageLimitSourceId.ts";
import { UsageModelFilter } from "./usage.ts";
import { SecretProviderId, SecretProviderSlug } from "./secretReference.ts";
import { SettingsSecretValue } from "./settingsSecretValue.ts";
import { EnvironmentMachineKind, ThreadEnvMode, WorktreeSubmodules } from "./environment.ts";
import {
  CustomModelSetting,
  DEFAULT_TEXT_GENERATION_MODEL,
  DEFAULT_TEXT_GENERATION_REASONING_EFFORT,
  ProviderOptionSelections,
} from "./model.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ProjectScript, type ProjectMutation } from "./project.ts";
import { DEFAULT_RUNTIME_MODE, RuntimeMode } from "./providerPolicy.ts";
import {
  ProviderInstanceConfig,
  ProviderInstanceId,
  ProviderDriverKind,
} from "./providerInstance.ts";
import { PullRequestMergeMethod } from "./pullRequest.ts";

export const TimestampFormat = Schema.Literals(["locale", "12-hour", "24-hour"]);
export type TimestampFormat = typeof TimestampFormat.Type;
const DEFAULT_TIMESTAMP_FORMAT: TimestampFormat = "locale";

export const DiffLayout = Schema.Literals(["stacked", "split"]);
export type DiffLayout = typeof DiffLayout.Type;
const DEFAULT_DIFF_LAYOUT: DiffLayout = "stacked";

export const SidebarProjectSortOrder = Schema.Literals(["updated_at", "created_at", "manual"]);
export type SidebarProjectSortOrder = typeof SidebarProjectSortOrder.Type;
const DEFAULT_SIDEBAR_PROJECT_SORT_ORDER: SidebarProjectSortOrder = "updated_at";

export const SidebarThreadSortOrder = Schema.Literals(["updated_at", "created_at"]);
export type SidebarThreadSortOrder = typeof SidebarThreadSortOrder.Type;
const DEFAULT_SIDEBAR_THREAD_SORT_ORDER: SidebarThreadSortOrder = "updated_at";

export const SidebarProjectGroupingMode = Schema.Literals([
  "repository",
  "repository_path",
  "separate",
]);
export type SidebarProjectGroupingMode = typeof SidebarProjectGroupingMode.Type;
const DEFAULT_SIDEBAR_PROJECT_GROUPING_MODE: SidebarProjectGroupingMode = "repository";
export const MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS = 1;
export const MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS = 90;
export const SidebarAutoSettleAfterDays = Schema.Number.check(
  Schema.isBetween({
    minimum: MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
    maximum: MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
  }),
);
export type SidebarAutoSettleAfterDays = typeof SidebarAutoSettleAfterDays.Type;
const DEFAULT_SIDEBAR_AUTO_SETTLE_AFTER_DAYS: SidebarAutoSettleAfterDays = 7;

export const MAX_SNOOZE_PRESET_MINUTES = 30 * 24 * 60;
export const MAX_SNOOZE_PRESETS = 8;
export const SnoozePresetDay = Schema.Literals([
  "today",
  "tomorrow",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
]);
export type SnoozePresetDay = typeof SnoozePresetDay.Type;
/** `after` wakes a fixed time from now. `at` wakes at a local time; a weekday is its next occurrence after today. */
export const SnoozePresetSetting = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("after"),
    minutes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_SNOOZE_PRESET_MINUTES })),
  }),
  Schema.Struct({
    kind: Schema.Literal("at"),
    day: SnoozePresetDay,
    time: Schema.String.check(Schema.isPattern(/^([01]\d|2[0-3]):[0-5]\d$/)),
  }),
]);
export type SnoozePresetSetting = typeof SnoozePresetSetting.Type;
export const SnoozePresetSettings = Schema.Array(SnoozePresetSetting).check(
  Schema.isMaxLength(MAX_SNOOZE_PRESETS),
);
export const DEFAULT_SNOOZE_PRESETS: ReadonlyArray<SnoozePresetSetting> = [
  { kind: "after", minutes: 60 },
  { kind: "after", minutes: 180 },
  { kind: "at", day: "today", time: "18:00" },
  { kind: "at", day: "tomorrow", time: "09:00" },
  { kind: "at", day: "monday", time: "09:00" },
];

/** One size step for the interface, prompt, code and terminal together. */
export const FontScale = Schema.Literals(["standard", "comfortable", "large"]);
export type FontScale = typeof FontScale.Type;

// "artwork" follows the running channel and shows nothing on Latest. The fixed artwork
// modes let any channel opt into a specific channel's art.
export const EnvironmentIdentificationMode = Schema.Literals([
  "artwork",
  "nightly-artwork",
  "dev-artwork",
  "pill",
  "none",
]);
export type EnvironmentIdentificationMode = typeof EnvironmentIdentificationMode.Type;
export const DEFAULT_ENVIRONMENT_IDENTIFICATION_MODE: EnvironmentIdentificationMode = "artwork";

export const NotificationMode = Schema.Literals([
  "off",
  "notifications",
  "sound",
  "notifications-and-sound",
]);
export type NotificationMode = typeof NotificationMode.Type;

export const QuitConfirmationMode = Schema.Literals(["direct", "hold", "double-click"]);
export type QuitConfirmationMode = typeof QuitConfirmationMode.Type;
const DEFAULT_QUIT_CONFIRMATION_MODE: QuitConfirmationMode = "hold";

const LegacyConfirmQuit = Schema.Boolean.pipe(
  Schema.decodeTo(
    QuitConfirmationMode,
    SchemaTransformation.transform({
      decode: (confirmQuit): QuitConfirmationMode => (confirmQuit ? "hold" : "direct"),
      encode: (mode) => mode === "hold",
    }),
  ),
);

const QuitConfirmationModeSetting = Schema.Union([QuitConfirmationMode, LegacyConfirmQuit]);

export const LoadBalancingWeights = Schema.Record(
  TrimmedNonEmptyString,
  Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
);

export const DiffColorScheme = Schema.Literals(["red-green", "blue-orange"]);

export const ChatWidth = Schema.Literals(["comfortable", "wide", "full"]);
export type ChatWidth = typeof ChatWidth.Type;

export const ToolCallVisibility = Schema.Literals(["showAll", "hideSuccessful", "hideAll", "zen"]);
export type ToolCallVisibility = typeof ToolCallVisibility.Type;

/** What the open thread reads to a screen reader: turn status, the agent's in-between messages too, or every step. */
export const ScreenReaderAnnouncements = Schema.Literals(["status", "messages", "everything"]);
export type ScreenReaderAnnouncements = typeof ScreenReaderAnnouncements.Type;

export const ModelFavorite = Schema.Struct({
  provider: ProviderInstanceId,
  model: TrimmedNonEmptyString,
});
export const ModelFavorites = Schema.Array(ModelFavorite);
export const ProviderModelPreferences = Schema.Record(
  ProviderInstanceId,
  Schema.Struct({
    hiddenModels: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
    modelOrder: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  }),
);
export type ModelPreferences = {
  readonly favorites: typeof ModelFavorites.Type;
  readonly providerModelPreferences: typeof ProviderModelPreferences.Type;
};

export const ClientSettingsSchema = Schema.Struct({
  notificationMode: NotificationMode.pipe(
    Schema.withDecodingDefault(Effect.succeed("off" as const)),
  ),
  inAppNotificationsEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  diffColorScheme: DiffColorScheme.pipe(
    Schema.withDecodingDefault(Effect.succeed("red-green" as const)),
  ),
  chatWidth: ChatWidth.pipe(Schema.withDecodingDefault(Effect.succeed("comfortable" as const))),
  loadBalancingEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  loadBalancingWeights: LoadBalancingWeights.pipe(Schema.withDecodingDefault(Effect.succeed({}))),

  confirmQuit: QuitConfirmationModeSetting.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_QUIT_CONFIRMATION_MODE)),
  ),
  confirmThreadArchive: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  confirmThreadDelete: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  confirmThreadUnpin: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  diffFilesCollapsed: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  diffIgnoreWhitespace: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  diffLayout: DiffLayout.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_DIFF_LAYOUT))),
  environmentIdentificationMode: EnvironmentIdentificationMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_ENVIRONMENT_IDENTIFICATION_MODE)),
  ),
  fontScale: FontScale.pipe(Schema.withDecodingDefault(Effect.succeed("standard" as const))),
  // Older installs also decode to null; onboarding must additionally require an empty workspace.
  onboardingCompletedAt: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  persistComposerContextStrip: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),

  favorites: ModelFavorites.pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  providerModelPreferences: ProviderModelPreferences.pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  pullRequestMergeMethodOverrides: Schema.Record(
    TrimmedNonEmptyString,
    PullRequestMergeMethod,
  ).pipe(Schema.withDecodingDefault(Effect.succeed({}))),

  pullRequestLinksOpenInApp: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),

  composerRichTextEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  sendShortcut: Schema.Literals(["enter", "mod-enter-multiline", "mod-enter"]).pipe(
    Schema.withDecodingDefault(Effect.succeed("enter")),
  ),
  followUpBehavior: Schema.Literals(["queue", "steer"]).pipe(
    Schema.withDecodingDefault(Effect.succeed("steer")),
  ),
  proactivePanelsEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  showSkillsInSlashMenu: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  toolCallVisibility: ToolCallVisibility.pipe(
    Schema.withDecodingDefault(Effect.succeed("showAll" as const)),
  ),
  screenReaderAnnouncements: ScreenReaderAnnouncements.pipe(
    Schema.withDecodingDefault(Effect.succeed("status" as const)),
  ),
  screenReaderWindowTitle: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  // Retired Labs toggle. Still read as the default for the Usage item in threadDetailsItems.
  threadDetailsUsageEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  // Sparse show/hide overrides for thread details card items. Missing ids use the client's
  // default, so new items appear for everyone and unknown ids survive a downgrade.
  threadDetailsItems: Schema.Record(Schema.String, Schema.Boolean).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  sidebarWorkingShelfEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  sidebarProjectGroupingMode: SidebarProjectGroupingMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_PROJECT_GROUPING_MODE)),
  ),
  sidebarProjectGroupingOverrides: Schema.Record(
    TrimmedNonEmptyString,
    SidebarProjectGroupingMode,
  ).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  sidebarProjectSortOrder: SidebarProjectSortOrder.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_PROJECT_SORT_ORDER)),
  ),
  sidebarThreadSortOrder: SidebarThreadSortOrder.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_THREAD_SORT_ORDER)),
  ),
  timestampFormat: TimestampFormat.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_TIMESTAMP_FORMAT)),
  ),
  // A locale code or "system". Open string so new locales and downgrades need no migration.
  language: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed("en"))),
  wordWrap: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  // Opt-in TeX typesetting in rendered Markdown. Off keeps math parsing and
  // KaTeX out of the render path entirely.
  mathRenderingEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
});
export type ClientSettings = typeof ClientSettingsSchema.Type;

export const DEFAULT_CLIENT_SETTINGS: ClientSettings = Schema.decodeSync(ClientSettingsSchema)({});

const UsageModelTokenPrice = Schema.Number.check(
  Schema.isFinite(),
  Schema.isGreaterThanOrEqualTo(0),
);

/** Omitted cache rates use the input rate. */
export const UsageModelPriceOverride = Schema.Struct({
  inputCostPerMillionTokens: UsageModelTokenPrice,
  outputCostPerMillionTokens: UsageModelTokenPrice,
  cacheReadCostPerMillionTokens: Schema.optionalKey(UsageModelTokenPrice),
  cacheWriteCostPerMillionTokens: Schema.optionalKey(UsageModelTokenPrice),
});
export type UsageModelPriceOverride = typeof UsageModelPriceOverride.Type;

export const makeBinaryPathSetting = (fallback: string) =>
  TrimmedString.pipe(
    Schema.decodeTo(
      Schema.String,
      SchemaTransformation.transformEffect({
        decode: (value) => Effect.succeed(value || fallback),
        encode: (value) => Effect.succeed(value),
      }),
    ),
    Schema.withDecodingDefault(Effect.succeed(fallback)),
  );

export type ProviderSettingsFormControl = "text" | "password" | "textarea" | "switch" | "select";

export interface ProviderSettingsFormOption {
  readonly value: string;
  readonly label: string;
}

export interface ProviderSettingsFormAnnotation {
  readonly control?: ProviderSettingsFormControl | undefined;
  readonly placeholder?: string | undefined;
  readonly hidden?: boolean | undefined;
  readonly clearWhenEmpty?: "omit" | "persist" | undefined;

  readonly options?: ReadonlyArray<ProviderSettingsFormOption> | undefined;
}

export function secretSettingsFields(schema: {
  readonly fields: Readonly<Record<string, Schema.Top>>;
}): ReadonlyArray<string> {
  return Object.entries(schema.fields).flatMap(([field, fieldSchema]) => {
    return isSecretSetting(fieldSchema) ? [field] : [];
  });
}

export interface ProviderSettingsFormSchemaAnnotation {
  readonly order?: readonly string[] | undefined;
}

declare module "effect/Schema" {
  namespace Annotations {
    interface Annotations {
      /** Store this credential separately and expose only whether it is configured to clients. */
      readonly settingsSecret?: boolean | undefined;
      /** Set by `SettingsSecretValue`: the credential may name a secret provider reference. */
      readonly settingsSecretReference?: boolean | undefined;
      readonly providerSettingsForm?: ProviderSettingsFormAnnotation | undefined;
      readonly providerSettingsFormSchema?: ProviderSettingsFormSchemaAnnotation | undefined;
    }
  }
}

export function secretSetting<S extends Schema.Top>(schema: S): S["Rebuild"] {
  return schema.annotateKey({ settingsSecret: true });
}

/** A masked form field is a credential too, so none is saved or sent to clients as plain text. */
export function isSecretSetting(schema: Schema.Top): boolean {
  const annotations = Schema.resolveAnnotationsKey(schema) ?? Schema.resolveAnnotations(schema);
  return (
    annotations?.settingsSecret === true ||
    annotations?.providerSettingsForm?.control === "password"
  );
}

export type ProviderSettingsOrder<Fields extends Schema.Struct.Fields> = readonly Extract<
  keyof Fields,
  string
>[];

export function makeProviderSettingsSchema<const Fields extends Schema.Struct.Fields>(
  fields: Fields,
  options?: {
    readonly order?: ProviderSettingsOrder<Fields> | undefined;
  },
): Schema.Struct<Fields> {
  return Schema.Struct(fields).pipe(
    Schema.annotate({
      providerSettingsFormSchema:
        options?.order === undefined ? undefined : { order: options.order },
    }),
  );
}

const CONTEXT_THRESHOLD_PERCENT = /^(?:|[1-9]\d?|100)$/;

/** Empty means half the model window. Each provider form shows the same control. */
function contextThresholdPercentSetting() {
  return TrimmedString.check(Schema.isPattern(CONTEXT_THRESHOLD_PERCENT)).pipe(
    Schema.withDecodingDefault(Effect.succeed("")),
    Schema.annotateKey({
      title: "上下文阈值",
      description: "用到模型窗口的这个百分比就压缩或提醒。留空按 50%。",
      providerSettingsForm: { placeholder: "50", clearWhenEmpty: "omit" },
    }),
  );
}

export const CodexSettings = makeProviderSettingsSchema(
  {
    setupMode: Schema.optionalKey(Schema.Literals(["managed", "existing"])).pipe(
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("codex").pipe(
      Schema.annotateKey({
        title: "可执行文件路径",
        description: "此实例使用的 Codex 可执行文件路径。",
        providerSettingsForm: { placeholder: "codex", clearWhenEmpty: "omit" },
      }),
    ),
    homePath: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "CODEX_HOME 路径",
        description: "自定义 Codex 主目录和配置目录。",
        providerSettingsForm: {
          placeholder: "~/.codex",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    shadowHomePath: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "影子主目录路径",
        description:
          "按账号划分的 Codex 主目录。auth.json 单独存放，同时共享 CODEX_HOME 中的状态。",
        providerSettingsForm: {
          placeholder: "~/.codex-t3/personal",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    launchArgs: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "启动参数",
        description: "会话启动时传给 codex app-server 的额外命令行参数。",
      }),
    ),
    contextThresholdPercent: contextThresholdPercentSetting(),
    customModels: Schema.Array(CustomModelSetting).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: ["contextThresholdPercent", "binaryPath", "homePath", "shadowHomePath", "launchArgs"],
  },
);
export type CodexSettings = typeof CodexSettings.Type;

const CLAUDE_AUTO_COMPACT_WINDOW_PATTERN = /^(?:|[1-9]\d{5}|1000000)$/;

export const IDLE_COMPACTION_MODES = [
  { value: "onReturn", label: "你回来时" },
  { value: "beforeCacheExpires", label: "提示缓存过期前（beta）" },
  { value: "off", label: "从不" },
] as const;
export const IdleCompactionMode = Schema.Literals(IDLE_COMPACTION_MODES.map((mode) => mode.value));
export type IdleCompactionMode = typeof IdleCompactionMode.Type;

// Shipped clients reject the whole server config unless `compactIdleThreads` is boolean.
// Keep the mode in `idleCompaction`, but accept strings from older servers.
const LegacyCompactIdleThreads = Schema.Union([Schema.Boolean, IdleCompactionMode]);

const INSTANCE_IDLE_COMPACTION_MODES = [
  { value: "default", label: "使用默认" },
  ...IDLE_COMPACTION_MODES,
] as const;
const InstanceIdleCompaction = Schema.Literals(
  INSTANCE_IDLE_COMPACTION_MODES.map((mode) => mode.value),
);

export const ClaudeSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("claude").pipe(
      Schema.annotateKey({
        title: "启动程序",
        description:
          "留空时自动使用本机的 reclaude。找不到 reclaude 时不启用 Claude，也不会改用 claude。",
        providerSettingsForm: { placeholder: "reclaude 的完整路径", clearWhenEmpty: "omit" },
      }),
    ),
    homePath: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "CLAUDE_CONFIG_DIR 路径",
        description: "自定义 Claude 主目录和配置目录，.claude.json 与 .claude 分开保存。",
        providerSettingsForm: { placeholder: "~/.claude", clearWhenEmpty: "omit" },
      }),
    ),
    customModels: Schema.Array(CustomModelSetting).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    launchArgs: Schema.String.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "启动参数",
        description: "会话启动时传入的额外命令行参数。",
        providerSettingsForm: {
          placeholder: "例如 --chrome",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    contextThresholdPercent: contextThresholdPercentSetting(),
    autoCompactWindow: TrimmedString.check(
      Schema.isPattern(CLAUDE_AUTO_COMPACT_WINDOW_PATTERN),
    ).pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "自动压缩阈值",
        description: "超过 100,000 到 1,000,000 词元后压缩。留空使用 Claude 的默认值。",
        providerSettingsForm: {
          placeholder: "例如 300000",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    idleCompaction: InstanceIdleCompaction.pipe(
      Schema.withDecodingDefault(Effect.succeed("default" as const)),
      Schema.annotateKey({
        title: "压缩空闲会话",
        description:
          "空闲会话超过 200,000 词元后何时压缩：你回来后、提示缓存即将过期前，或从不压缩。覆盖“提供方 > 高级”中的默认值。",
        providerSettingsForm: {
          control: "select",
          options: INSTANCE_IDLE_COMPACTION_MODES,
          clearWhenEmpty: "omit",
        },
      }),
    ),
  },
  {
    order: [
      "contextThresholdPercent",
      "binaryPath",
      "homePath",
      "autoCompactWindow",
      "idleCompaction",
      "launchArgs",
    ],
  },
);
export type ClaudeSettings = typeof ClaudeSettings.Type;

export const ANTIGRAVITY_AUTH_METHODS = [
  { value: "oauth-personal", label: "Google 账号" },
  { value: "oauth-business", label: "Gemini Enterprise" },
  { value: "gemini-api-key", label: "Gemini API key" },
  { value: "agent-platform", label: "Agent Platform（Vertex AI）" },
] as const satisfies ReadonlyArray<ProviderSettingsFormOption>;
export const AntigravityAuthMethod = Schema.Literals(
  ANTIGRAVITY_AUTH_METHODS.map((method) => method.value),
);
export type AntigravityAuthMethod = typeof AntigravityAuthMethod.Type;

export const AntigravitySettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    authMethod: AntigravityAuthMethod.pipe(
      Schema.withDecodingDefault(Effect.succeed("oauth-personal" as const)),
      Schema.annotateKey({
        title: "登录方式",
        description: "Google 账号使用你的订阅；API key 和 Agent Platform 按用量计费。",
        providerSettingsForm: {
          control: "select",
          options: ANTIGRAVITY_AUTH_METHODS,
          clearWhenEmpty: "omit",
        },
      }),
    ),
    apiKey: SettingsSecretValue.pipe(
      secretSetting,
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "API key",
        description: "Gemini 或 Vertex AI express key，单独存放在主机上。",
        providerSettingsForm: {
          control: "password",
          placeholder: "可选",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    gcpProject: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "GCP 项目",
        description: "Gemini Enterprise 必填。未设置 API key 时 Agent Platform 也会使用。",
        providerSettingsForm: { placeholder: "my-project-id", clearWhenEmpty: "omit" },
      }),
    ),
    gcpLocation: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "GCP 位置",
        description: "Gemini Enterprise 或 Agent Platform 使用的区域。",
        providerSettingsForm: { placeholder: "us-central1", clearWhenEmpty: "omit" },
      }),
    ),
    binaryPath: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "可执行文件路径",
        description: "自定义 ACP 可执行文件。留空则自动选择。",
        providerSettingsForm: { placeholder: "自动选择", clearWhenEmpty: "persist" },
      }),
    ),
    contextThresholdPercent: contextThresholdPercentSetting(),
    customModels: Schema.Array(CustomModelSetting).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: [
      "contextThresholdPercent",
      "authMethod",
      "apiKey",
      "gcpProject",
      "gcpLocation",
      "binaryPath",
    ],
  },
);
export type AntigravitySettings = typeof AntigravitySettings.Type;

export const UsageLimitSourceConfig = Schema.Struct({
  kind: Schema.Literal("cliproxy"),
  label: Schema.optional(TrimmedNonEmptyString),
  url: TrimmedNonEmptyString,
  managementKey: SettingsSecretValue.pipe(
    Schema.withDecodingDefault(Effect.succeed("")),
    secretSetting,
  ),
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
});
export type UsageLimitSourceConfig = typeof UsageLimitSourceConfig.Type;

export const TextGeneratorKind = Schema.Literals(["openaiCompatible", "anthropic"]);
export type TextGeneratorKind = typeof TextGeneratorKind.Type;

const TextGeneratorBaseUrl = TrimmedNonEmptyString.check(
  Schema.isMaxLength(2048),
  Schema.makeFilter((value) => {
    try {
      const url = new URL(value);
      return (
        (url.protocol === "http:" || url.protocol === "https:") &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      );
    } catch {
      return false;
    }
  }),
);

/** A model API that only generates text. Its key shares the id namespace with provider instances. */
export const TextGeneratorConfig = Schema.Struct({
  kind: TextGeneratorKind,
  label: Schema.optional(TrimmedNonEmptyString),
  baseUrl: TextGeneratorBaseUrl,
  apiKey: SettingsSecretValue.pipe(Schema.withDecodingDefault(Effect.succeed("")), secretSetting),
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
});
export type TextGeneratorConfig = typeof TextGeneratorConfig.Type;

export const TextGeneratorModel = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
});
export type TextGeneratorModel = typeof TextGeneratorModel.Type;

export const ListTextGeneratorModelsInput = Schema.Struct({
  id: ProviderInstanceId,
  /**
   * Unsaved settings to check before saving, such as from the add dialog. A redacted key keeps
   * the one saved under `id`.
   */
  config: Schema.optional(TextGeneratorConfig),
  /** Skip the server's cached list and ask the API again. */
  refresh: Schema.optional(Schema.Boolean),
  /** Also have a model answer a tiny prompt, which proves the key, endpoint, and model. */
  test: Schema.optional(Schema.Boolean),
  /** With `test`, the model to try; a cheap listed one when omitted. */
  model: Schema.optional(TrimmedNonEmptyString),
});
export type ListTextGeneratorModelsInput = typeof ListTextGeneratorModelsInput.Type;

export const ListTextGeneratorModelsResult = Schema.Struct({
  models: Schema.Array(TextGeneratorModel),
  /** The model that answered, when `test` was set. */
  testedModel: Schema.optional(TrimmedNonEmptyString),
});
export type ListTextGeneratorModelsResult = typeof ListTextGeneratorModelsResult.Type;

export class TextGeneratorError extends Schema.TaggedError<TextGeneratorError>()(
  "TextGeneratorError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

export const SecretProviderKind = SecretProviderSlug.pipe(Schema.brand("SecretProviderKind"));
export type SecretProviderKind = typeof SecretProviderKind.Type;

export const SecretProviderLabel = TrimmedNonEmptyString.check(Schema.isMaxLength(64));

/** Kinds decode their own config; unknown-kind envelopes round-trip verbatim across versions. */
export const SecretProviderConfig = Schema.Struct({
  kind: SecretProviderKind,
  label: TrimmedNonEmptyString,
  config: Schema.optionalKey(Schema.Unknown),
});
export type SecretProviderConfig = typeof SecretProviderConfig.Type;

// Limits that may change later are enforced on writes only, never on the stored envelope. The
// server also checks the kind and its config against the secret providers it has loaded.
const SecretProviderConfigWrite = Schema.Struct({
  ...SecretProviderConfig.fields,
  label: SecretProviderLabel,
});

export const SourceControlHostSettings = Schema.Record(Schema.String, Schema.Unknown);
export type SourceControlHostSettings = typeof SourceControlHostSettings.Type;

export const ObservabilitySettings = Schema.Struct({
  otlpTracesUrl: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  otlpMetricsUrl: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  otlpLogsUrl: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
});
export type ObservabilitySettings = typeof ObservabilitySettings.Type;

export const SourceControlWritingStyleMode = Schema.Literals([
  "repo_conventions",
  "conventional_commits",
  "custom",
]);
export type SourceControlWritingStyleMode = typeof SourceControlWritingStyleMode.Type;

export const SourceControlWritingStyleSettings = Schema.Struct({
  mode: SourceControlWritingStyleMode.pipe(
    Schema.withDecodingDefault(Effect.succeed("repo_conventions" as const)),
  ),
  customInstructions: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  followChangeRequestTemplates: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(true)),
  ),
});
export type SourceControlWritingStyleSettings = typeof SourceControlWritingStyleSettings.Type;

const LegacySourceControlWritingStyle = TrimmedString.pipe(
  Schema.decodeTo(
    Schema.toType(SourceControlWritingStyleSettings),
    SchemaTransformation.transform({
      decode: (value): SourceControlWritingStyleSettings => ({
        mode: value.length > 0 ? "custom" : "repo_conventions",
        customInstructions: value,
        followChangeRequestTemplates: true,
      }),
      encode: (value) => value.customInstructions,
    }),
  ),
);

// The struct member comes first so encoding uses its defaulted fields: the server strips
// default sub-fields before writing settings.json, and a toType target would reject them.
const SourceControlWritingStyleSetting = Schema.Union([
  SourceControlWritingStyleSettings,
  LegacySourceControlWritingStyle,
]);

export const BranchNamingMode = Schema.Literals(["static", "semantic", "custom"]);
export type BranchNamingMode = typeof BranchNamingMode.Type;

export interface BranchNamingOptions {
  mode: BranchNamingMode;
  prefix: string;
  instructions: string;
}

export const DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL = Duration.seconds(30);
export const DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL = Duration.minutes(5);

export const BackgroundActivityProfile = Schema.Literals([
  "balanced",
  "performance",
  "battery-saver",
]);
export type BackgroundActivityProfile = typeof BackgroundActivityProfile.Type;
export const DEFAULT_BACKGROUND_ACTIVITY_PROFILE: BackgroundActivityProfile = "balanced";

export const BackgroundActivityProfileSelection = Schema.Literals([
  "balanced",
  "performance",
  "battery-saver",
  "custom",
]);
export type BackgroundActivityProfileSelection = typeof BackgroundActivityProfileSelection.Type;

export const BackgroundActivityOverrides = Schema.Struct({
  automaticGitFetchInterval: Schema.optionalKey(Schema.DurationFromMillis),
  providerHealthRefreshInterval: Schema.optionalKey(Schema.DurationFromMillis),
  hostPowerMonitorActiveInterval: Schema.optionalKey(Schema.DurationFromMillis),
  hostPowerMonitorIdleInterval: Schema.optionalKey(Schema.DurationFromMillis),
  pauseWhenHostLocked: Schema.optionalKey(Schema.Boolean),
  pauseWhenHostLowPower: Schema.optionalKey(Schema.Boolean),
  pauseWhenClientLowPower: Schema.optionalKey(Schema.Boolean),
  pauseWhenOnBattery: Schema.optionalKey(Schema.Boolean),
});
export type BackgroundActivityOverrides = typeof BackgroundActivityOverrides.Type;

export const BackgroundActivitySettings = Schema.Struct({
  schemaVersion: Schema.Literal(1).pipe(Schema.withDecodingDefault(Effect.succeed(1 as const))),
  profile: BackgroundActivityProfileSelection.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_BACKGROUND_ACTIVITY_PROFILE)),
  ),
  baseProfile: Schema.optionalKey(BackgroundActivityProfile),
  overrides: BackgroundActivityOverrides.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
}).pipe(Schema.withDecodingDefault(Effect.succeed({})));
export type BackgroundActivitySettings = typeof BackgroundActivitySettings.Type;

export const ResponseStreamingMode = Schema.Literals(["turn", "paragraph"]);
export type ResponseStreamingMode = typeof ResponseStreamingMode.Type;

const StorageRetentionDays = Schema.NullOr(
  Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3650 })),
);
const SettledWorktreeRetentionDays = Schema.NullOr(
  Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3650 })),
);

export const WorktreeKeepWhen = Schema.Literals([
  "any-local-files",
  "uncommitted-changes",
  "tracked-changes",
]);
export type WorktreeKeepWhen = typeof WorktreeKeepWhen.Type;

export const WorktreeCleanupRules = Schema.Struct({
  worktreeKeepWhen: WorktreeKeepWhen.pipe(
    Schema.withDecodingDefault(Effect.succeed("uncommitted-changes")),
  ),
  worktreeAfterDays: StorageRetentionDays,
  worktreeSettledAfterDays: SettledWorktreeRetentionDays.pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  worktreeOnMerge: Schema.Boolean,
  worktreeOnDelete: Schema.Boolean,
  worktreeUnchanged: Schema.Boolean,
});
export type WorktreeCleanupRules = typeof WorktreeCleanupRules.Type;

export const WorktreeCleanup = Schema.NullOr(
  Schema.Union([
    Schema.Struct({ mode: Schema.Literal("off") }),
    Schema.Struct({ mode: Schema.Literal("custom"), rules: WorktreeCleanupRules }),
  ]),
);
export type WorktreeCleanup = typeof WorktreeCleanup.Type;

/** Role on `delegate_task`. An empty cell uses the project's default model. */
export const DispatchRole = Schema.Literals(["code", "review", "readonly", "plan"]);
export type DispatchRole = typeof DispatchRole.Type;

/** Used when neither the project nor the environment wrote commander instructions. */
export const BUILTIN_COMMANDER_INSTRUCTIONS = [
  "同一件活已经有子会话还在做，就发回那一条，不新开。",
  "一件活一棵工作树、一条分支。分支名用这个仓已有的命名设置。已经领了单的，用那张单定下的那条分支。",
  "交代写全：做成什么样、怎么算做完、别碰什么、要跑哪些测试。没写的不替它扩大范围。",
  "子会话不合并。",
  "回报里要有做到哪、PR 号、头提交、核对命令的真实结果、没做的和原因。指挥会话核对这几项，不照抄回报里的句子。",
  "过了沉默时限先看它卡在哪，不要因为没说话就再派一个。",
  "时限到了只标超时，除非这次交代写明到点就停。",
  "子会话不再往下派。若还是派了，动态栏不单列孙会话，只在那条直接子会话的行上写「它还派了 K 个」。点开完整会话才看下层。",
  "已领的单只从本任期指挥会话派。不领单的随手活可以在本机做。",
].join("\n");

export const PROJECT_SCOPED_SERVER_SETTING_KEYS = [
  "worktreeCleanup",
  "defaultModelSelection",
  "defaultRuntimeMode",
  "defaultThreadEnvMode",
  "newWorktreesStartFromOrigin",
  "worktreeSubmodules",
  "defaultAutoPull",
  "defaultProjectScripts",
  "enableAgentDeviceAccess",
  "textGenerationModelSelection",
  "threadTitleInstructions",
  "sourceControlWriterModelSelection",
  "sourceControlWritingStyle",
  "removeAgentCreditsOnMerge",
  "branchNamingMode",
  "branchNamePrefix",
  "branchNameInstructions",
  "pullRequestMergeMethod",
  "sidebarAutoSettleOnMerge",
  "sidebarAutoSettleAfterDays",
  "sidebarAutoSettleKeepPullRequests",
  "continueThreadsAfterServerUpdate",
  "responseStreamingMode",
  "dispatchCodeModelSelection",
  "dispatchReviewModelSelection",
  "dispatchReadonlyModelSelection",
  "dispatchPlanModelSelection",
  "dispatchConcurrencyLimit",
  "dispatchTimeoutMs",
  "dispatchStopOnTimeout",
  "commanderInstructions",
  "dispatchCommanderModelSelection",
] as const;
export type ProjectScopedServerSettingKey = (typeof PROJECT_SCOPED_SERVER_SETTING_KEYS)[number];

export const ProjectProviderInstanceOverride = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
});
export type ProjectProviderInstanceOverride = typeof ProjectProviderInstanceOverride.Type;

/** Absent keys inherit; null is a value for nullable settings.
 * providerInstances overrides fields per instance; other keys replace the whole setting. */
export const ProjectSettingsOverrides = Schema.Struct({
  worktreeCleanup: Schema.optionalKey(WorktreeCleanup),
  defaultModelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
  defaultRuntimeMode: Schema.optionalKey(RuntimeMode),
  defaultThreadEnvMode: Schema.optionalKey(ThreadEnvMode),
  newWorktreesStartFromOrigin: Schema.optionalKey(Schema.Boolean),
  worktreeSubmodules: ForwardCompatibleOptional(WorktreeSubmodules),
  defaultAutoPull: Schema.optionalKey(Schema.Boolean),
  defaultProjectScripts: Schema.optionalKey(Schema.Array(ProjectScript)),
  enableAgentDeviceAccess: Schema.optionalKey(Schema.Boolean),
  textGenerationModelSelection: Schema.optionalKey(ModelSelection),
  threadTitleInstructions: Schema.optionalKey(TrimmedString),
  sourceControlWriterModelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
  sourceControlWritingStyle: Schema.optionalKey(SourceControlWritingStyleSetting),
  removeAgentCreditsOnMerge: Schema.optionalKey(Schema.Boolean),
  branchNamingMode: Schema.optionalKey(BranchNamingMode),
  branchNamePrefix: Schema.optionalKey(TrimmedString),
  branchNameInstructions: Schema.optionalKey(TrimmedString),
  pullRequestMergeMethod: Schema.optionalKey(Schema.NullOr(PullRequestMergeMethod)),
  sidebarAutoSettleOnMerge: Schema.optionalKey(Schema.Boolean),
  sidebarAutoSettleAfterDays: Schema.optionalKey(Schema.NullOr(SidebarAutoSettleAfterDays)),
  sidebarAutoSettleKeepPullRequests: Schema.optionalKey(Schema.Boolean),
  continueThreadsAfterServerUpdate: Schema.optionalKey(Schema.Boolean),
  responseStreamingMode: Schema.optionalKey(ResponseStreamingMode),
  dispatchCodeModelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
  dispatchReviewModelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
  dispatchReadonlyModelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
  dispatchPlanModelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
  dispatchConcurrencyLimit: Schema.optionalKey(Schema.NullOr(PositiveInt)),
  dispatchTimeoutMs: Schema.optionalKey(Schema.NullOr(PositiveInt)),
  dispatchStopOnTimeout: Schema.optionalKey(Schema.Boolean),
  commanderInstructions: Schema.optionalKey(TrimmedString),
  dispatchCommanderModelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
  providerInstances: Schema.optionalKey(
    Schema.Record(ProviderInstanceId, ProjectProviderInstanceOverride),
  ),
} satisfies Record<ProjectScopedServerSettingKey | "providerInstances", unknown>);
export type ProjectSettingsOverrides = typeof ProjectSettingsOverrides.Type;

// Whole-entry writers must round-trip unknown keys; keep the type closed to catch misspellings.
export const keepUnknownOverrideKeys = <Entry extends Schema.Struct<Schema.Struct.Fields>>(
  entry: Entry,
): Schema.Codec<
  Entry["Type"],
  Entry["Encoded"],
  Entry["DecodingServices"],
  Entry["EncodingServices"]
> => Schema.StructWithRest(entry, [Schema.Record(Schema.String, Schema.Unknown)]);

/** True if null stores an override; otherwise null removes it. */
export function isNullableProjectSettingsOverride(key: ProjectScopedServerSettingKey): boolean {
  return NULLABLE_PROJECT_SETTINGS_OVERRIDES.has(key);
}
const NULLABLE_PROJECT_SETTINGS_OVERRIDES: ReadonlySet<ProjectScopedServerSettingKey> = new Set<
  {
    [K in ProjectScopedServerSettingKey]: null extends ProjectSettingsOverrides[K] ? K : never;
  }[ProjectScopedServerSettingKey]
>([
  "defaultModelSelection",
  "sourceControlWriterModelSelection",
  "pullRequestMergeMethod",
  "sidebarAutoSettleAfterDays",
  "dispatchCodeModelSelection",
  "dispatchReviewModelSelection",
  "dispatchReadonlyModelSelection",
  "dispatchPlanModelSelection",
  "dispatchConcurrencyLimit",
  "dispatchTimeoutMs",
  "dispatchCommanderModelSelection",
]);

/** Reclaimable bytes from which the offline `t3 doctor` repair is worth suggesting. */
export const DATABASE_COMPACTION_RECOMMENDED_BYTES = 1024 ** 3;

export const DatabaseStorageStatus = Schema.Struct({
  databaseBytes: Schema.Number,
  /** Free pages inside the file that an offline VACUUM (or incremental auto_vacuum) returns to disk. */
  reclaimableBytes: Schema.Number,
  /** False on databases created before incremental auto_vacuum; `t3 doctor` converts them. */
  incrementalVacuumEnabled: Schema.Boolean,
  /** Run on the host while offline. */
  compactCommand: Schema.String,
  /** The server can run the repair itself: the desktop app or background service restarts it. */
  canReclaim: Schema.optionalKey(Schema.Boolean),
  /** Why the last repair started from Settings failed. */
  reclaimFailure: Schema.optionalKey(Schema.String),
});
export type DatabaseStorageStatus = typeof DatabaseStorageStatus.Type;

export class DatabaseReclaimError extends Schema.TaggedError<DatabaseReclaimError>()(
  "DatabaseReclaimError",
  { reason: Schema.String },
) {
  override get message() {
    return this.reason;
  }
}

export function shouldRecommendDatabaseCompaction(status: DatabaseStorageStatus): boolean {
  return (
    !status.incrementalVacuumEnabled &&
    status.reclaimableBytes >= DATABASE_COMPACTION_RECOMMENDED_BYTES
  );
}

/** Offline minutes the repair takes, at 30 s per GiB of live data (a BB-1 NVMe disk took 21 s). */
export function databaseReclaimMinutes(status: DatabaseStorageStatus): number {
  const liveGiB = (status.databaseBytes - status.reclaimableBytes) / 1024 ** 3;
  return Math.max(1, Math.ceil(liveGiB / 2));
}

export const StorageCleanupReportEntry = Schema.Struct({
  kind: Schema.Literals(["worktree", "browser-artifacts", "logs"]),
  outcome: Schema.Literals(["removed", "kept", "failed"]),
  reason: Schema.String,
  path: Schema.NullOr(Schema.String),
  projectPath: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  threadId: Schema.NullOr(ThreadId),
  threadTitle: Schema.NullOr(Schema.String),
  bytes: Schema.NullOr(Schema.Number).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  files: Schema.NullOr(Schema.Number).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
});
export type StorageCleanupReportEntry = typeof StorageCleanupReportEntry.Type;
export const StorageCleanupReport = Schema.Struct({
  trigger: Schema.Literals(["automatic", "manual"]),
  startedAt: Schema.String,
  finishedAt: Schema.String,
  entries: Schema.Array(StorageCleanupReportEntry),
  counts: Schema.Struct({ removed: Schema.Number, kept: Schema.Number, failed: Schema.Number }),
  omittedCount: Schema.Number,
  bytesFreed: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
});
export type StorageCleanupReport = typeof StorageCleanupReport.Type;

export const StorageCleanupSettings = Schema.Struct({
  worktreeKeepWhen: WorktreeKeepWhen.pipe(
    Schema.withDecodingDefault(Effect.succeed("uncommitted-changes")),
  ),
  worktreeAfterDays: StorageRetentionDays.pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  worktreeSettledAfterDays: SettledWorktreeRetentionDays.pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  worktreeOnMerge: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  worktreeOnDelete: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  worktreeUnchanged: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  browserArtifactsAfterDays: StorageRetentionDays.pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  logsAfterDays: StorageRetentionDays.pipe(Schema.withDecodingDefault(Effect.succeed(null))),
});
export type StorageCleanupSettings = typeof StorageCleanupSettings.Type;

export const MaxConcurrentSessions = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
export type MaxConcurrentSessions = typeof MaxConcurrentSessions.Type;

/**
 * Ordered candidates for one pipeline stage. Stored settings decode a legacy single
 * model (or null) into one entry so an existing install keeps its configured model.
 */
const ModelSelectionList = Schema.Array(ModelSelection);
const OrderedModelCandidates = Schema.Unknown.pipe(
  Schema.decodeTo(ModelSelectionList, {
    decode: SchemaGetter.transform((raw: unknown): typeof ModelSelectionList.Encoded =>
      raw === null || raw === undefined
        ? []
        : Array.isArray(raw)
          ? (raw as typeof ModelSelectionList.Encoded)
          : [raw as typeof ModelSelection.Encoded],
    ),
    encode: SchemaGetter.transform((models: typeof ModelSelectionList.Encoded) => models),
  }),
);
export const DEFAULT_PIPELINE_REPOS = ["thoerwink8/fleet-ade"] as const;

const PIPELINE_REPO_PART = /^[A-Za-z0-9_.-]+$/;

/** One `owner/name`. Rejects extra slashes and `.` / `..` parts. */
export function parsePipelineRepo(
  value: string,
): { readonly owner: string; readonly name: string; readonly slug: string } | undefined {
  const trimmed = value.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash !== trimmed.lastIndexOf("/")) return undefined;
  const owner = trimmed.slice(0, slash);
  const name = trimmed.slice(slash + 1);
  if (
    owner === "." ||
    owner === ".." ||
    name === "." ||
    name === ".." ||
    !PIPELINE_REPO_PART.test(owner) ||
    !PIPELINE_REPO_PART.test(name)
  ) {
    return undefined;
  }
  return { owner, name, slug: `${owner}/${name}` };
}

/** Keeps order, drops invalid entries and later duplicates. An empty list stays empty. */
function decodePipelineRepos(values: ReadonlyArray<unknown>): Array<string> {
  const seen = new Set<string>();
  const repos: Array<string> = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const parsed = parsePipelineRepo(value);
    if (parsed === undefined || seen.has(parsed.slug)) continue;
    seen.add(parsed.slug);
    repos.push(parsed.slug);
  }
  return repos;
}

const PipelineRepos = Schema.Array(Schema.Unknown).pipe(
  Schema.decodeTo(
    Schema.Array(Schema.String),
    SchemaTransformation.transform<ReadonlyArray<string>, ReadonlyArray<unknown>>({
      decode: decodePipelineRepos,
      encode: (values) => values,
    }),
  ),
);

export const ServerSettings = Schema.Struct({
  // Null means unmigrated; empty is authoritative and must not resurrect cleared preferences.
  favorites: Schema.NullOr(ModelFavorites).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  providerModelPreferences: Schema.NullOr(ProviderModelPreferences).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  worktreeCleanup: WorktreeCleanup.pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  storageCleanup: StorageCleanupSettings.pipe(
    Schema.withDecodingDefault(Effect.succeed(Schema.decodeSync(StorageCleanupSettings)({}))),
  ),

  worktreesDirectory: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  /** Server-maintained history keeps old worktrees eligible for cleanup and review diffs. */
  previousWorktreesDirectories: Schema.Array(TrimmedString).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  responseStreamingMode: ResponseStreamingMode.pipe(
    Schema.withDecodingDefault(Effect.succeed("paragraph" as const)),
  ),
  enableProviderUpdateChecks: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  continueThreadsAfterServerUpdate: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(true)),
  ),
  /** Holds an OS sleep inhibitor while any run is active; closing a laptop lid still sleeps it. */
  keepAwakeWhileAgentsWork: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),

  defaultAutoPull: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  defaultProjectScripts: Schema.Array(ProjectScript).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  projectScriptOverrides: Schema.Record(ProjectId, Schema.NullOr(Schema.Array(ProjectScript))).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  projectAutoPullOverrides: Schema.Record(ProjectId, Schema.Boolean).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  defaultModelSelection: Schema.NullOr(ModelSelection).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  fallbackModelSelection: Schema.NullOr(ModelSelection).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  defaultRuntimeMode: RuntimeMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_RUNTIME_MODE)),
  ),

  projectSettingsOverrides: Schema.Record(
    ProjectId,
    keepUnknownOverrideKeys(ProjectSettingsOverrides),
  ).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  /** Fold once so restarts cannot undo later UI resets. */
  projectSettingsFolded: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),

  // Retired device-panel settings remain decode-compatible but are never read.
  enableAgentDeviceAccess: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  enableDeviceSupport: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  deviceOnboardingCompleted: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  deviceHosts: Schema.Unknown.pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  easDeviceHosts: Schema.Unknown.pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  simlockDeviceHosts: Schema.Unknown.pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  sidebarAutoSettleAfterDays: Schema.NullOr(SidebarAutoSettleAfterDays).pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_AUTO_SETTLE_AFTER_DAYS)),
  ),
  compactIdleThreads: LegacyCompactIdleThreads.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
  idleCompaction: Schema.optionalKey(IdleCompactionMode),
  snoozeLimitedThreads: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  autoResumeLimitedThreads: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  snoozePresets: SnoozePresetSettings.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SNOOZE_PRESETS)),
  ),
  /** Clients hide threads with these tags while `hideTaggedThreads` is on. Bad entries drop alone, so a hand edit cannot reset settings. */
  hiddenThreadTags: Schema.Array(Schema.Unknown).pipe(
    Schema.decodeTo(
      Schema.Array(Schema.String),
      SchemaTransformation.transform<ReadonlyArray<string>, ReadonlyArray<unknown>>({
        decode: (values) => values.filter((value) => typeof value === "string"),
        encode: (values) => values,
      }),
    ),
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  hideTaggedThreads: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /** Retired with guest links; kept so stored settings decode. Ignored. */
  guestSharingEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /** Retired link toggle; retained so stored settings decode, but ignored. */
  linkedEnvironmentsEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /** Retired Labs switches; kept so stored settings decode, but ignored. */
  fastWorktreeCheckout: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  // Retired device host toggle remains only for old settings decoding.
  simlockDeviceHostsEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /** Legacy client sidebar settings; retained here only so stored settings decode. */
  boringSidebarEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  boringSidebarMultilineRows: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
  /** Off: a pipeline tick does not read issues or write runs. */
  pipelineEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /** ISO time the switch last turned on. Null while off; left alone while it stays on. */
  pipelineEnabledAt: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  /** Each stage keeps an ordered candidate list; the picker moves to the next when one is unreadable or exhausted. Empty sticks as 没配模型. */
  pipelineAuthorModel: OrderedModelCandidates.pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  /** Ordered verifier candidates; the first usable one that differs from the author model runs, else the verify run sticks as 没配模型. */
  pipelineVerifierModel: OrderedModelCandidates.pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  /** Minutes after a session starts with no terminal event before the run sticks as 超时. */
  pipelineSessionTimeoutMinutes: PositiveInt.pipe(Schema.withDecodingDefault(Effect.succeed(90))),
  /** Off: a run that passes the merge gate stays mergeable and is not merged. */
  pipelineAutoMerge: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /** Recorded input tokens for one run. Over this the run sticks as 超预算. */
  pipelineTokenInputEquivalent: PositiveInt.pipe(
    Schema.withDecodingDefault(Effect.succeed(7_000_000)),
  ),
  /** Added lines on the pull request. Over this the run sticks as 超预算. */
  pipelinePullRequestAddedLines: PositiveInt.pipe(
    Schema.withDecodingDefault(Effect.succeed(3_000)),
  ),
  /**
   * Ordered repositories a pipeline tick lists. Empty lists nothing.
   * A missing key is only the default repository, never every repository.
   */
  pipelineRepos: PipelineRepos.pipe(
    Schema.withDecodingDefault(Effect.succeed([...DEFAULT_PIPELINE_REPOS])),
  ),
  /** Maximum active agent sessions running concurrently on this server; null leaves concurrency uncapped. */
  maxConcurrentSessions: Schema.NullOr(MaxConcurrentSessions).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  /** Pinned on. Decoded for stored settings; the stored value is ignored. */
  promptSuggestionsEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  sidebarAutoSettleKeepPullRequests: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
  sidebarAutoSettleOnMerge: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  backgroundActivity: BackgroundActivitySettings,

  automaticGitFetchInterval: Schema.DurationFromMillis.pipe(
    Schema.withDecodingDefault(
      Effect.succeed(Duration.toMillis(DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL)),
    ),
  ),
  providerHealthRefreshInterval: Schema.DurationFromMillis.pipe(
    Schema.withDecodingDefault(
      Effect.succeed(Duration.toMillis(DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL)),
    ),
  ),
  backgroundActivityProfile: BackgroundActivityProfile.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_BACKGROUND_ACTIVITY_PROFILE)),
  ),
  environmentIcon: ForwardCompatibleNullable(EnvironmentMachineKind).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  /** Null inherits t3.json, then local; omit it on the wire for older clients requiring a literal. */
  defaultThreadEnvMode: OmittedWhenNull(ThreadEnvMode),
  newWorktreesStartFromOrigin: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(true)),
  ),
  /** Null inherits t3.json, then recursive; unknown values decode to null for older clients. */
  worktreeSubmodules: ForwardCompatibleNullable(WorktreeSubmodules).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  addProjectBaseDirectory: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  /** Clones default to `<addProjectBaseDirectory>/<host>/<owner>/<repo>`, like ghq. */
  ghqCloneLayout: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  textGenerationModelSelection: ModelSelection.pipe(
    Schema.withDecodingDefault(
      Effect.succeed({
        instanceId: ProviderInstanceId.make("codex"),
        model: DEFAULT_TEXT_GENERATION_MODEL,
        options: [
          {
            id: "reasoningEffort",
            value: DEFAULT_TEXT_GENERATION_REASONING_EFFORT,
          },
        ],
      }),
    ),
  ),
  // Null cell uses defaultModelSelection. Null concurrency does not cap a commander.
  dispatchCodeModelSelection: Schema.NullOr(ModelSelection).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  dispatchReviewModelSelection: Schema.NullOr(ModelSelection).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  dispatchReadonlyModelSelection: Schema.NullOr(ModelSelection).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  dispatchPlanModelSelection: Schema.NullOr(ModelSelection).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  dispatchConcurrencyLimit: Schema.NullOr(PositiveInt).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  /** Null does not limit one delegation. The clock starts when its run starts, not while queued. */
  dispatchTimeoutMs: Schema.NullOr(PositiveInt).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  /** Off: a timed-out delegation stays running. On: stop it through the existing cancel path. */
  dispatchStopOnTimeout: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /** Empty uses the built-in commander instructions. */
  commanderInstructions: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  /** Null keeps the commander thread's current model. Role cells do not read this. */
  dispatchCommanderModelSelection: Schema.NullOr(ModelSelection).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  threadTitleInstructions: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  branchNamingMode: BranchNamingMode.pipe(
    Schema.withDecodingDefault(Effect.succeed("static" as const)),
  ),
  branchNamePrefix: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed("t3"))),
  branchNameInstructions: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  removeAgentCreditsOnMerge: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  sourceControlWritingStyle: SourceControlWritingStyleSetting.pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  sourceControlWriterModelSelection: Schema.NullOr(ModelSelection).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),

  pullRequestMergeMethod: Schema.NullOr(PullRequestMergeMethod).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),

  // Schema.Unknown preserves unknown-driver configs across versions; see providerInstance.ts.
  providerInstances: Schema.Record(ProviderInstanceId, ProviderInstanceConfig).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  observability: ObservabilitySettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  sourceControlHosts: Schema.Record(Schema.String, SourceControlHostSettings).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  /** Hosts the add and publish project pickers offer, by kind. An unset host is off, except the default one. */
  offeredSourceControlProviders: Schema.Record(Schema.String, Schema.Boolean).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  // User-chosen ids preserve rows across edits; undecodable entries round-trip untouched.
  usageLimitSources: Schema.Record(UsageLimitSourceId, UsageLimitSourceConfig).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  textGenerators: Schema.Record(ProviderInstanceId, TextGeneratorConfig).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  secretProviders: Schema.Record(SecretProviderId, SecretProviderConfig).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),

  usagePriceOverrides: Schema.Record(TrimmedNonEmptyString, UsageModelPriceOverride).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),

  usageModelAliases: Schema.Record(TrimmedNonEmptyString, TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),

  /** Sent by the Usage tab with each summary request to this environment; edit in settings.json. Invalid values are ignored. */
  usageModelFilter: ForwardCompatibleOptional(UsageModelFilter),

  /** Outbound line for this environment and the agents it starts. */
  network: NetworkSettings.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_NETWORK_SETTINGS)),
  ),
});
export type ServerSettings = typeof ServerSettings.Type;

export const DEFAULT_SERVER_SETTINGS: ServerSettings = Schema.decodeSync(ServerSettings)({});

export const providerInstanceConfigEnabledFlag = (config: unknown): boolean | undefined => {
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    return undefined;
  }
  const enabled = (config as { readonly enabled?: unknown }).enabled;
  return typeof enabled === "boolean" ? enabled : undefined;
};

// Drivers this build can run. A stored row for anything else stays off, even when it says enabled.
const REGISTERED_PROVIDER_DRIVERS: ReadonlySet<ProviderDriverKind> = new Set(
  ["codex", "claudeAgent", "grok", "antigravity", "acpRegistry"].map((driver) =>
    ProviderDriverKind.make(driver),
  ),
);

// Must match each registered driver's enabled decoding default.
const DEFAULT_DISABLED_PROVIDER_DRIVERS: ReadonlySet<ProviderDriverKind> = new Set(
  ["grok", "antigravity"].map((driver) => ProviderDriverKind.make(driver)),
);

const DEFAULT_ENABLED_DEFAULT_INSTANCES: ReadonlySet<ProviderInstanceId> = new Set(
  ["codex", "claudeAgent"].map((instanceId) => ProviderInstanceId.make(instanceId)),
);

export const isUnconfiguredDefaultInstanceEnabled = (instanceId: ProviderInstanceId): boolean =>
  DEFAULT_ENABLED_DEFAULT_INSTANCES.has(instanceId);

export const resolveProviderInstanceEnabled = (
  instance: Pick<ProviderInstanceConfig, "driver" | "enabled" | "config">,
): boolean => {
  if (!REGISTERED_PROVIDER_DRIVERS.has(instance.driver)) {
    return false;
  }
  const configEnabled = providerInstanceConfigEnabledFlag(instance.config);
  if (instance.enabled === false || configEnabled === false) {
    return false;
  }
  return (
    instance.enabled ?? configEnabled ?? !DEFAULT_DISABLED_PROVIDER_DRIVERS.has(instance.driver)
  );
};

export const resolveProjectProviderInstanceEnabled = (
  settings: Pick<ServerSettings, "providerInstances" | "projectSettingsOverrides">,
  projectId: ProjectId | null,
  instanceId: ProviderInstanceId,
): boolean => {
  const override =
    projectId === null
      ? undefined
      : settings.projectSettingsOverrides[projectId]?.providerInstances?.[instanceId]?.enabled;
  if (override !== undefined) return override;
  const instanceConfig = Object.hasOwn(settings.providerInstances, instanceId)
    ? settings.providerInstances[instanceId]
    : undefined;
  return instanceConfig !== undefined
    ? resolveProviderInstanceEnabled(instanceConfig)
    : isUnconfiguredDefaultInstanceEnabled(instanceId);
};

/** The text generator a selection names, if any; it takes precedence over a provider instance. */
export const textGeneratorForSelection = (
  settings: Pick<ServerSettings, "textGenerators">,
  instanceId: ProviderInstanceId,
): TextGeneratorConfig | undefined =>
  Object.hasOwn(settings.textGenerators, instanceId)
    ? settings.textGenerators[instanceId]
    : undefined;

/** Whether a text generation selection can run: an enabled text generator or provider instance. */
export const resolveTextGenerationSelectionEnabled = (
  settings: Pick<
    ServerSettings,
    "providerInstances" | "projectSettingsOverrides" | "textGenerators"
  >,
  projectId: ProjectId | null,
  instanceId: ProviderInstanceId,
): boolean =>
  textGeneratorForSelection(settings, instanceId)?.enabled ??
  resolveProjectProviderInstanceEnabled(settings, projectId, instanceId);

const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);

type IdleCompactionSettings = Pick<ServerSettings, "compactIdleThreads" | "idleCompaction">;

/** The environment-wide idle compaction mode, from whichever field the settings carry. */
export const globalIdleCompaction = (settings: IdleCompactionSettings): IdleCompactionMode =>
  settings.idleCompaction ??
  (typeof settings.compactIdleThreads === "string"
    ? settings.compactIdleThreads
    : settings.compactIdleThreads
      ? "beforeCacheExpires"
      : "onReturn");

/** Sets the mode, and the legacy switch shipped clients still read alongside it. */
export const withIdleCompaction = <S extends IdleCompactionSettings>(
  settings: S,
  mode: IdleCompactionMode,
): S => ({ ...settings, idleCompaction: mode, compactIdleThreads: mode === "beforeCacheExpires" });

/** Whether a server reads modes, rather than only the boolean switch from before them. */
export const readsIdleCompactionModes = (settings: IdleCompactionSettings) =>
  settings.idleCompaction !== undefined || typeof settings.compactIdleThreads === "string";

/**
 * The patch that sets `mode` in the form the server's settings show it reads:
 * the mode for a server that has `idleCompaction` or kept the mode in the legacy
 * field, the boolean switch for a server from before modes.
 */
export const idleCompactionPatch = (settings: IdleCompactionSettings, mode: IdleCompactionMode) =>
  settings.idleCompaction !== undefined
    ? { idleCompaction: mode }
    : readsIdleCompactionModes(settings)
      ? { compactIdleThreads: mode }
      : { compactIdleThreads: mode === "beforeCacheExpires" };

export const resolveIdleCompaction = (
  settings: Pick<ServerSettings, "providerInstances" | "compactIdleThreads" | "idleCompaction">,
  instanceId: ProviderInstanceId,
): IdleCompactionMode => {
  const instance = Object.hasOwn(settings.providerInstances, instanceId)
    ? settings.providerInstances[instanceId]
    : undefined;
  const override = decodeClaudeSettings(instance?.config ?? {}).pipe(
    Option.map((config) => config.idleCompaction),
    Option.getOrElse(() => "default" as const),
  );
  return override === "default" ? globalIdleCompaction(settings) : override;
};

export const ServerSettingsOperation = Schema.Literals([
  "normalize",
  "check-exists",
  "create-provider-instance",
  "read-file",
  "read-provider-history",
  "read-project-settings",
  "read-secret",
  "remove-secret",
  "remove-stale-secret",
  "write-secret",
  "write-secret-provider",
  "write-file",
  "prepare-directory",
]);
export type ServerSettingsOperation = typeof ServerSettingsOperation.Type;

export class ServerSettingsError extends Schema.TaggedError<ServerSettingsError>()(
  "ServerSettingsError",
  {
    settingsPath: Schema.String,
    operation: ServerSettingsOperation,
    providerInstanceId: Schema.optional(Schema.String),
    environmentVariable: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const provider =
      this.providerInstanceId === undefined ? "" : ` for provider ${this.providerInstanceId}`;
    const variable =
      this.environmentVariable === undefined
        ? ""
        : ` and environment variable ${this.environmentVariable}`;
    return `Server settings ${this.operation} failed${provider}${variable} at ${this.settingsPath}.`;
  }
}

export type UnifiedSettings = Omit<ServerSettings, keyof ModelPreferences> & ClientSettings;
export const DEFAULT_UNIFIED_SETTINGS: UnifiedSettings = {
  ...DEFAULT_SERVER_SETTINGS,
  ...DEFAULT_CLIENT_SETTINGS,
};

const ModelSelectionPatch = Schema.Struct({
  instanceId: Schema.optionalKey(ProviderInstanceId),
  model: Schema.optionalKey(TrimmedNonEmptyString),
  options: Schema.optionalKey(ProviderOptionSelections),
});

export const ServerSettingsPatch = Schema.Struct({
  network: Schema.optionalKey(NetworkSettings),
  setModelFavorites: Schema.optionalKey(
    Schema.Array(Schema.Struct({ ...ModelFavorite.fields, favorite: Schema.Boolean })),
  ),
  setModelsHidden: Schema.optionalKey(
    Schema.Array(Schema.Struct({ ...ModelFavorite.fields, hidden: Schema.Boolean })),
  ),
  setProviderModelOrder: Schema.optionalKey(
    Schema.Struct({ provider: ProviderInstanceId, modelOrder: Schema.Array(TrimmedString) }),
  ),
  favorites: Schema.optionalKey(ModelFavorites),
  providerModelPreferences: Schema.optionalKey(ProviderModelPreferences),
  // Applied under the settings service's write lock, only while still unset.
  migrateModelPreferences: Schema.optionalKey(
    Schema.Struct({
      favorites: Schema.optionalKey(ModelFavorites),
      providerModelPreferences: Schema.optionalKey(ProviderModelPreferences),
    }),
  ),
  worktreeCleanup: Schema.optionalKey(
    Schema.NullOr(
      Schema.Union([
        Schema.Struct({ mode: Schema.Literal("off") }),
        Schema.Struct({
          mode: Schema.Literal("custom"),
          rules: Schema.Struct({
            worktreeKeepWhen: Schema.optionalKey(WorktreeKeepWhen),
            worktreeAfterDays: Schema.optionalKey(StorageRetentionDays),
            worktreeSettledAfterDays: Schema.optionalKey(SettledWorktreeRetentionDays),
            worktreeOnMerge: Schema.optionalKey(Schema.Boolean),
            worktreeOnDelete: Schema.optionalKey(Schema.Boolean),
            worktreeUnchanged: Schema.optionalKey(Schema.Boolean),
          }),
        }),
      ]),
    ),
  ),
  storageCleanup: Schema.optionalKey(
    Schema.Struct({
      worktreeKeepWhen: Schema.optionalKey(WorktreeKeepWhen),
      worktreeAfterDays: Schema.optionalKey(StorageRetentionDays),
      worktreeSettledAfterDays: Schema.optionalKey(SettledWorktreeRetentionDays),
      worktreeOnMerge: Schema.optionalKey(Schema.Boolean),
      worktreeOnDelete: Schema.optionalKey(Schema.Boolean),
      worktreeUnchanged: Schema.optionalKey(Schema.Boolean),
      browserArtifactsAfterDays: Schema.optionalKey(StorageRetentionDays),
      logsAfterDays: Schema.optionalKey(StorageRetentionDays),
    }),
  ),
  worktreesDirectory: Schema.optionalKey(TrimmedString),
  responseStreamingMode: Schema.optionalKey(ResponseStreamingMode),
  enableProviderUpdateChecks: Schema.optionalKey(Schema.Boolean),
  continueThreadsAfterServerUpdate: Schema.optionalKey(Schema.Boolean),
  keepAwakeWhileAgentsWork: Schema.optionalKey(Schema.Boolean),
  defaultAutoPull: Schema.optionalKey(Schema.Boolean),
  defaultProjectScripts: Schema.optionalKey(Schema.Array(ProjectScript)),
  projectScriptOverrides: Schema.optionalKey(
    Schema.Record(ProjectId, Schema.NullOr(Schema.Array(ProjectScript))),
  ),
  projectAutoPullOverrides: Schema.optionalKey(
    Schema.Record(ProjectId, Schema.NullOr(Schema.Boolean)),
  ),
  defaultModelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
  defaultRuntimeMode: Schema.optionalKey(RuntimeMode),
  fallbackModelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
  /** Replaces each project's override set; null removes it. Omitted providerInstances retains its stored value. */
  projectSettingsOverrides: Schema.optionalKey(
    Schema.Record(
      ProjectId,
      Schema.NullOr(
        keepUnknownOverrideKeys(
          Schema.Struct({
            ...ProjectSettingsOverrides.fields,
            sourceControlWritingStyle: Schema.optionalKey(SourceControlWritingStyleSettings),
          }),
        ),
      ),
    ),
  ),
  // Retired device-panel policy fields are decoded and ignored.
  enableAgentDeviceAccess: Schema.optionalKey(Schema.Boolean),
  enableDeviceSupport: Schema.optionalKey(Schema.Boolean),
  deviceOnboardingCompleted: Schema.optionalKey(Schema.Boolean),
  deviceHosts: Schema.optionalKey(Schema.Unknown),
  easDeviceHosts: Schema.optionalKey(Schema.Unknown),
  simlockDeviceHosts: Schema.optionalKey(Schema.Unknown),
  sidebarAutoSettleAfterDays: Schema.optionalKey(Schema.NullOr(SidebarAutoSettleAfterDays)),
  compactIdleThreads: Schema.optionalKey(LegacyCompactIdleThreads),
  idleCompaction: Schema.optionalKey(IdleCompactionMode),
  sidebarAutoSettleKeepPullRequests: Schema.optionalKey(Schema.Boolean),
  sidebarAutoSettleOnMerge: Schema.optionalKey(Schema.Boolean),
  autoResumeLimitedThreads: Schema.optionalKey(Schema.Boolean),
  snoozeLimitedThreads: Schema.optionalKey(Schema.Boolean),
  snoozePresets: Schema.optionalKey(SnoozePresetSettings),
  hiddenThreadTags: Schema.optionalKey(Schema.Array(Schema.String)),
  hideTaggedThreads: Schema.optionalKey(Schema.Boolean),
  /** Retired with guest links; kept so stored settings decode. Ignored. */
  guestSharingEnabled: Schema.optionalKey(Schema.Boolean),
  linkedEnvironmentsEnabled: Schema.optionalKey(Schema.Boolean),
  pipelineEnabled: Schema.optionalKey(Schema.Boolean),
  pipelineEnabledAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
  pipelineAuthorModel: Schema.optionalKey(OrderedModelCandidates),
  pipelineVerifierModel: Schema.optionalKey(OrderedModelCandidates),
  pipelineSessionTimeoutMinutes: Schema.optionalKey(PositiveInt),
  pipelineAutoMerge: Schema.optionalKey(Schema.Boolean),
  pipelineTokenInputEquivalent: Schema.optionalKey(PositiveInt),
  pipelinePullRequestAddedLines: Schema.optionalKey(PositiveInt),
  pipelineRepos: Schema.optionalKey(PipelineRepos),
  maxConcurrentSessions: Schema.optionalKey(Schema.NullOr(MaxConcurrentSessions)),
  promptSuggestionsEnabled: Schema.optionalKey(Schema.Boolean),
  backgroundActivity: Schema.optionalKey(
    Schema.Struct({
      schemaVersion: Schema.optionalKey(Schema.Literal(1)),
      profile: Schema.optionalKey(BackgroundActivityProfileSelection),
      baseProfile: Schema.optionalKey(BackgroundActivityProfile),
      overrides: Schema.optionalKey(BackgroundActivityOverrides),
    }),
  ),
  automaticGitFetchInterval: Schema.optionalKey(Schema.DurationFromMillis),
  providerHealthRefreshInterval: Schema.optionalKey(Schema.DurationFromMillis),
  backgroundActivityProfile: Schema.optionalKey(BackgroundActivityProfile),
  environmentIcon: Schema.optionalKey(Schema.NullOr(EnvironmentMachineKind)),
  defaultThreadEnvMode: Schema.optionalKey(Schema.NullOr(ThreadEnvMode)),
  newWorktreesStartFromOrigin: Schema.optionalKey(Schema.Boolean),
  worktreeSubmodules: Schema.optionalKey(Schema.NullOr(WorktreeSubmodules)),
  addProjectBaseDirectory: Schema.optionalKey(TrimmedString),
  ghqCloneLayout: Schema.optionalKey(Schema.Boolean),
  textGenerationModelSelection: Schema.optionalKey(ModelSelectionPatch),
  dispatchCodeModelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
  dispatchReviewModelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
  dispatchReadonlyModelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
  dispatchPlanModelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
  dispatchConcurrencyLimit: Schema.optionalKey(Schema.NullOr(PositiveInt)),
  dispatchTimeoutMs: Schema.optionalKey(Schema.NullOr(PositiveInt)),
  dispatchStopOnTimeout: Schema.optionalKey(Schema.Boolean),
  commanderInstructions: Schema.optionalKey(TrimmedString),
  dispatchCommanderModelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
  threadTitleInstructions: Schema.optionalKey(TrimmedString),
  branchNamingMode: Schema.optionalKey(BranchNamingMode),
  branchNamePrefix: Schema.optionalKey(TrimmedString),
  branchNameInstructions: Schema.optionalKey(TrimmedString),
  removeAgentCreditsOnMerge: Schema.optionalKey(Schema.Boolean),
  sourceControlWritingStyle: Schema.optionalKey(
    Schema.Struct({
      mode: Schema.optionalKey(SourceControlWritingStyleMode),
      customInstructions: Schema.optionalKey(TrimmedString),
      followChangeRequestTemplates: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  sourceControlWriterModelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
  pullRequestMergeMethod: Schema.optionalKey(Schema.NullOr(PullRequestMergeMethod)),
  observability: Schema.optionalKey(
    Schema.Struct({
      otlpTracesUrl: Schema.optionalKey(TrimmedString),
      otlpMetricsUrl: Schema.optionalKey(TrimmedString),
      otlpLogsUrl: Schema.optionalKey(TrimmedString),
    }),
  ),
  /** Merges per host, replacing patched fields whole; redaction markers retain secrets, empty secrets remove them. A non-empty token map keeps the saved tokens of hosts it omits; an empty map clears them all. */
  sourceControlHosts: Schema.optionalKey(Schema.Record(Schema.String, SourceControlHostSettings)),
  offeredSourceControlProviders: Schema.optionalKey(Schema.Record(Schema.String, Schema.Boolean)),
  // Replace whole maps to avoid half-merged driver configs.
  providerInstances: Schema.optionalKey(Schema.Record(ProviderInstanceId, ProviderInstanceConfig)),
  // Merge per source to avoid racing other edits; null removes an entry.
  usageLimitSources: Schema.optionalKey(
    Schema.Record(UsageLimitSourceId, Schema.NullOr(UsageLimitSourceConfig)),
  ),
  // Merge per entry like usageLimitSources; null removes an entry.
  textGenerators: Schema.optionalKey(
    Schema.Record(ProviderInstanceId, Schema.NullOr(TextGeneratorConfig)),
  ),
  secretProviders: Schema.optionalKey(
    Schema.Record(SecretProviderId, Schema.NullOr(SecretProviderConfigWrite)),
  ),

  usagePriceOverrides: Schema.optionalKey(
    Schema.Record(TrimmedNonEmptyString, Schema.NullOr(UsageModelPriceOverride)),
  ),

  usageModelAliases: Schema.optionalKey(
    Schema.Record(TrimmedNonEmptyString, Schema.NullOr(TrimmedNonEmptyString)),
  ),
});
export type ServerSettingsPatch = typeof ServerSettingsPatch.Type;

export function requiredScopesForServerSettingsPatch(
  patch: ServerSettingsPatch,
): ReadonlyArray<AuthEnvironmentScope> {
  let changesProviders = false;
  let changesSettings = false;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (
      key === "providers" ||
      key === "providerInstances" ||
      key === "usageLimitSources" ||
      key === "textGenerators" ||
      key === "secretProviders"
    ) {
      changesProviders = true;
    } else {
      changesSettings = true;
    }
  }
  // Removing a secret provider also clears the settings fields that read from it.
  if (Object.values(patch.secretProviders ?? {}).some((entry) => entry === null)) {
    changesSettings = true;
  }
  return [
    ...(changesSettings || !changesProviders ? [AuthSettingsWriteScope] : []),
    ...(changesProviders ? [AuthProvidersManageScope] : []),
  ];
}

/** Host-executed project scripts require settings-write authority in addition to orchestration:operate. */
export function requiredScopesForProjectMutation(
  mutation: ProjectMutation,
): ReadonlyArray<AuthEnvironmentScope> {
  if (mutation.type === "project.delete" || mutation.scripts === undefined) {
    return [AuthOrchestrationOperateScope];
  }
  return [
    AuthOrchestrationOperateScope,
    ...requiredScopesForServerSettingsPatch({ defaultProjectScripts: mutation.scripts }),
  ];
}

export const ClientSettingsPatch = Schema.Struct({
  notificationMode: Schema.optionalKey(NotificationMode),
  inAppNotificationsEnabled: Schema.optionalKey(Schema.Boolean),
  diffColorScheme: Schema.optionalKey(DiffColorScheme),
  chatWidth: Schema.optionalKey(ChatWidth),
  loadBalancingEnabled: Schema.optionalKey(Schema.Boolean),
  loadBalancingWeights: Schema.optionalKey(LoadBalancingWeights),
  confirmQuit: Schema.optionalKey(QuitConfirmationMode),
  confirmThreadArchive: Schema.optionalKey(Schema.Boolean),
  confirmThreadDelete: Schema.optionalKey(Schema.Boolean),
  confirmThreadUnpin: Schema.optionalKey(Schema.Boolean),
  diffFilesCollapsed: Schema.optionalKey(Schema.Boolean),
  diffIgnoreWhitespace: Schema.optionalKey(Schema.Boolean),
  diffLayout: Schema.optionalKey(DiffLayout),
  environmentIdentificationMode: Schema.optionalKey(EnvironmentIdentificationMode),
  onboardingCompletedAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
  fontScale: Schema.optionalKey(FontScale),
  persistComposerContextStrip: Schema.optionalKey(Schema.Boolean),
  favorites: Schema.optionalKey(ModelFavorites),
  providerModelPreferences: Schema.optionalKey(ProviderModelPreferences),
  pullRequestMergeMethodOverrides: Schema.optionalKey(
    Schema.Record(TrimmedNonEmptyString, PullRequestMergeMethod),
  ),
  pullRequestLinksOpenInApp: Schema.optionalKey(Schema.Boolean),
  composerRichTextEnabled: Schema.optionalKey(Schema.Boolean),
  sendShortcut: Schema.optionalKey(Schema.Literals(["enter", "mod-enter-multiline", "mod-enter"])),
  followUpBehavior: Schema.optionalKey(Schema.Literals(["queue", "steer"])),
  proactivePanelsEnabled: Schema.optionalKey(Schema.Boolean),
  showSkillsInSlashMenu: Schema.optionalKey(Schema.Boolean),
  toolCallVisibility: Schema.optionalKey(ToolCallVisibility),
  screenReaderAnnouncements: Schema.optionalKey(ScreenReaderAnnouncements),
  screenReaderWindowTitle: Schema.optionalKey(Schema.Boolean),
  threadDetailsUsageEnabled: Schema.optionalKey(Schema.Boolean),
  threadDetailsItems: Schema.optionalKey(Schema.Record(Schema.String, Schema.Boolean)),
  sidebarWorkingShelfEnabled: Schema.optionalKey(Schema.Boolean),
  sidebarProjectGroupingMode: Schema.optionalKey(SidebarProjectGroupingMode),
  sidebarProjectGroupingOverrides: Schema.optionalKey(
    Schema.Record(TrimmedNonEmptyString, SidebarProjectGroupingMode),
  ),
  sidebarProjectSortOrder: Schema.optionalKey(SidebarProjectSortOrder),
  sidebarThreadSortOrder: Schema.optionalKey(SidebarThreadSortOrder),
  timestampFormat: Schema.optionalKey(TimestampFormat),
  language: Schema.optionalKey(Schema.String),
  wordWrap: Schema.optionalKey(Schema.Boolean),
  mathRenderingEnabled: Schema.optionalKey(Schema.Boolean),
});
export type ClientSettingsPatch = typeof ClientSettingsPatch.Type;

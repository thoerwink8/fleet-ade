import { isElectron, isSecretsFeatureEnabled } from "~/env";
import { isWindowsPlatform, normalizeSearchText } from "~/lib/utils";
import { STATIC_KEYBINDING_COMMANDS, type KeybindingCommand } from "@t3tools/contracts";
import type { EnvironmentId } from "@t3tools/contracts";
import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import {
  sourceControlClients,
  type SourceControlDefinition,
} from "@t3tools/client-runtime/source-control-clients";
import { DEFAULT_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { commandLabel } from "./KeybindingsSettings.logic";
import type { ResolvedSettingsScope } from "./settingsScope";

export type SettingsPath =
  | "/settings/projects"
  | "/settings/general"
  | "/settings/network"
  | "/settings/diagnostics"
  | "/settings/appearance"
  | "/settings/chat"
  | "/settings/diffs"
  | "/settings/keybindings"
  | "/settings/providers"
  | "/settings/threads"
  | "/settings/scheduled-tasks"
  | "/settings/source-control"
  | "/settings/worktrees"
  | "/settings/connections"
  | "/settings/access"
  | "/settings/secrets"
  | "/settings/maintenance"
  | "/settings/about"
  | "/settings/archived";

export type SettingsSearchScope =
  | "environment"
  | "environment-defaults"
  | "project-defaults"
  | "project"
  | "checkout"
  | "connections";

export interface SettingsSearchItem {
  readonly id: string;
  readonly title: string;
  readonly to: SettingsPath;
  readonly targetId?: string;
  readonly searchTerms?: ReadonlyArray<string>;
  readonly scope?: SettingsSearchScope;
  readonly desktopOnly?: boolean;
  readonly windowsOnly?: boolean;
  readonly releaseChannelOnly?: boolean;
  readonly secretsFeatureOnly?: boolean;
  readonly cloudOnly?: boolean;
  readonly environmentOnly?: boolean;
  readonly providerSettingsOnly?: boolean;
  readonly localBackendManagementOnly?: boolean;
  readonly localEnvironmentOnly?: boolean;
  readonly primaryEnvironmentOnly?: boolean;
  readonly wslAvailableOnly?: boolean;
  readonly managedTunnelOnly?: boolean;
  readonly peerLinksOnly?: boolean;
  readonly secondary?: boolean;
  readonly requiresThreadAutoSettlement?: boolean;
}

export interface SettingsSearchAvailability {
  readonly localEnvironmentDisabled?: boolean;
  readonly hasCloudPublicConfig: boolean;
  readonly hasEnvironment: boolean;
  readonly hasProviderSettingsEnvironment: boolean;
  readonly canManageLocalBackend: boolean;
  readonly isWslSettingsRowVisible: boolean;
  readonly hasThreadAutoSettlement: boolean;
  readonly managedTunnelActive?: boolean;
  readonly hasPeerLinkHost?: boolean;
  readonly hasPrimaryEnvironment?: boolean;
}

export const SETTINGS_SECTION_LABELS: Readonly<Record<SettingsPath, string>> = {
  "/settings/diagnostics": "维护",
  "/settings/projects": "代码",
  "/settings/general": "通用",
  "/settings/network": "通用",
  "/settings/appearance": "外观",
  "/settings/chat": "会话",
  "/settings/diffs": "外观",
  "/settings/keybindings": "通用",
  "/settings/providers": "智能体",
  "/settings/threads": "会话",
  "/settings/scheduled-tasks": "定时",
  "/settings/source-control": "代码",
  "/settings/worktrees": "代码",
  "/settings/connections": "连接",
  "/settings/access": "连接",
  "/settings/secrets": "连接",
  "/settings/maintenance": "维护",
  "/settings/about": "维护",
  "/settings/archived": "会话",
};

/** Sidebar order. Eight sections, each a single entry; the pages that used to be
 *  their own entries now live inside them and their old paths redirect here. */
export const SETTINGS_NAV_GROUPS: ReadonlyArray<{
  readonly heading: string;
  readonly headingHidden?: true;
  readonly paths: ReadonlyArray<SettingsPath>;
}> = [
  { heading: "通用", headingHidden: true, paths: ["/settings/general"] },
  { heading: "外观", headingHidden: true, paths: ["/settings/appearance"] },
  { heading: "智能体", headingHidden: true, paths: ["/settings/providers"] },
  { heading: "会话", headingHidden: true, paths: ["/settings/threads"] },
  { heading: "定时", headingHidden: true, paths: ["/settings/scheduled-tasks"] },
  { heading: "代码", headingHidden: true, paths: ["/settings/projects"] },
  { heading: "连接", headingHidden: true, paths: ["/settings/connections"] },
  { heading: "维护", headingHidden: true, paths: ["/settings/maintenance"] },
];

export function keybindingSearchAnchorId<Command extends KeybindingCommand>(command: Command) {
  return `keybinding-${command}` as const;
}

const KEYBINDING_SEARCH_ITEMS = STATIC_KEYBINDING_COMMANDS.toSorted((left, right) =>
  commandLabel(left).localeCompare(commandLabel(right)),
).map((command) => {
  const defaultKeys = DEFAULT_KEYBINDINGS.filter((binding) => binding.command === command).map(
    (binding) => binding.key,
  );
  return {
    id: keybindingSearchAnchorId(command),
    title: commandLabel(command),
    to: "/settings/general" as const,
    searchTerms: [command, ...defaultKeys],
    secondary: true,
    ...(defaultKeys.length === 0 ? { targetId: "keybindings" } : {}),
  };
});

export function sourceControlHostSettingsSearchId(kind: string) {
  return `source-control-host-${kind}` as const;
}

/** Each host's own settings: its accounts and token, or the fields of its settings form. */
export function sourceControlHostSearchItems(
  definitions: ReadonlyArray<SourceControlDefinition>,
): ReadonlyArray<
  SettingsSearchItem & { readonly id: ReturnType<typeof sourceControlHostSettingsSearchId> }
> {
  return definitions.flatMap((definition) => {
    if (!definition.settings) return [];
    const names = [definition.label, ...(definition.searchKeywords ?? [])].join(" ");
    const { credentials } = definition;
    return [
      {
        id: sourceControlHostSettingsSearchId(definition.kind),
        title: credentials
          ? `${definition.label} accounts and token`
          : `${definition.label} credentials`,
        to: "/settings/projects" as const,
        searchTerms: [
          credentials
            ? `${names} ${credentials.cliName} account login user host switch multiple accounts disable sign in token personal access token pat api key credential`
            : `${names} ${Object.keys(definition.settings.fields).join(" ")} token credentials sign in`,
        ],
        environmentOnly: true,
        scope: "environment-defaults" as const,
      },
    ];
  });
}

/** For settings that apply to every host. */
const SOURCE_CONTROL_HOST_LABELS = sourceControlClients.definitions
  .map((definition) => definition.label)
  .join(" ");
const SOURCE_CONTROL_HOST_TERMS = sourceControlClients.definitions
  .flatMap((definition) => [definition.label, ...(definition.searchKeywords ?? [])])
  .join(" ");

export const SETTINGS_SEARCH_ITEMS = [
  {
    id: "storage-worktree-keep-when",
    targetId: "storage-worktrees",
    title: "保留有本地改动的工作树",
    to: "/settings/projects",
    scope: "project-defaults",
    searchTerms: [
      "any local files uncommitted changes edited tracked files ignored env build output cleanup",
    ],
  },
  {
    id: "storage-delete-now",
    title: "立即删除",
    to: "/settings/maintenance",
    scope: "environment-defaults",
    searchTerms: ["storage cleanup run now results report removed kept failed"],
  },
  {
    id: "storage-worktrees",
    title: "工作树清理",
    to: "/settings/projects",
    scope: "project-defaults",
    searchTerms: [
      "disk storage automatic delete deleted archived threads old inactive merged settled unchanged worktrees retention days project inherit off custom",
    ],
  },
  {
    id: "storage-worktrees-location",
    title: "工作树位置",
    to: "/settings/projects",
    scope: "environment-defaults",
    searchTerms: ["worktree location folder directory path drive external disk"],
  },
  {
    id: "storage-artifacts",
    title: "产物与日志",
    to: "/settings/maintenance",
    scope: "environment-defaults",
    searchTerms: [
      "disk storage delete old browser artifacts screenshots captures rotated logs cleanup retention",
    ],
  },
  {
    id: "project-defaults",
    title: "项目默认设置与覆盖",
    to: "/settings/threads",
    scope: "project-defaults",
    searchTerms: ["model workspace environments projects inheritance checkout"],
  },
  {
    id: "project-overview",
    title: "项目概览",
    to: "/settings/projects",
    searchTerms: ["name icon emoji image checkout remove delete"],
  },
  {
    id: "default-model",
    title: "默认模型",
    to: "/settings/threads",
    scope: "project-defaults",
    searchTerms: ["new thread project provider reasoning effort"],
  },
  {
    id: "fallback-model",
    title: "备用模型",
    to: "/settings/threads",
    scope: "environment-defaults",
    searchTerms: ["fallback agent provider out of usage new threads"],
    environmentOnly: true,
  },
  {
    id: "default-permissions",
    title: "权限",
    to: "/settings/threads",
    scope: "project-defaults",
    searchTerms: [
      "new thread default runtime mode supervised approvals auto accept edits full access",
    ],
  },
  {
    id: "color-scheme",
    title: "配色模式",
    to: "/settings/appearance",
    searchTerms: ["appearance light dark system mode"],
    targetId: "appearance",
  },
  {
    id: "theme",
    title: "主题",
    to: "/settings/appearance",
    searchTerms: ["appearance colors palette"],
    targetId: "appearance",
  },
  {
    id: "diff-color-scheme",
    title: "差异颜色",
    to: "/settings/appearance",
    searchTerms: ["red green blue orange additions deletions changes counts palette colorblind"],
  },
  {
    id: "chat-width",
    title: "聊天宽度",
    to: "/settings/appearance",
    searchTerms: ["wide full width column layout messages composer monitor"],
  },
  {
    id: "thread-details-items",
    title: "会话详情",
    to: "/settings/appearance",
    searchTerms: [
      "customize show hide panel card environment editor scripts branch pull request git changes servers automations lineage usage limits 5 hour weekly quota tokens context window",
    ],
  },
  {
    id: "math-rendering",
    title: "渲染数学公式",
    to: "/settings/appearance",
    searchTerms: ["latex tex katex equations formulas markdown"],
  },
  {
    id: "environment-identification",
    title: "环境标识",
    to: "/settings/appearance",
    searchTerms: ["dev nightly latest channel artwork pill label hide none"],
    targetId: "appearance-interface",
  },
  {
    id: "font-size",
    title: "字号",
    to: "/settings/appearance",
    searchTerms: ["typography font size text larger smaller code terminal composer reading"],
  },
  {
    id: "word-wrap",
    title: "自动换行",
    to: "/settings/appearance",
    searchTerms: ["long lines code blocks diffs file previews"],
  },
  {
    id: "composer-context",
    title: "输入框上下文",
    to: "/settings/appearance",
  },
  {
    id: "project-grouping",
    title: "项目分组",
    to: "/settings/general",
    searchTerms: ["combine matching repositories environments sidebar"],
  },
  {
    id: "project-order",
    title: "项目排序",
    to: "/settings/general",
    searchTerms: ["sort projects sidebar manual created recent"],
  },
  {
    id: "network",
    title: "网络",
    to: "/settings/general",
    searchTerms: ["proxy", "代理", "http_proxy", "证书", "直连"],
    environmentOnly: true,
    scope: "environment",
  },
  {
    id: "snooze-options",
    title: "暂缓选项",
    to: "/settings/threads",
    searchTerms: ["snooze presets times later tonight tomorrow next week remind"],
    environmentOnly: true,
    scope: "environment-defaults",
  },
  {
    id: "max-concurrent-sessions",
    title: "同时运行的会话上限",
    to: "/settings/threads",
    searchTerms: ["concurrent session limit memory queue"],
    environmentOnly: true,
    scope: "environment-defaults",
  },
  {
    id: "snooze-limited-threads",
    title: "暂缓到用量限制重置",
    to: "/settings/threads",
    searchTerms: ["usage quota rate limit reset wake recover continue"],
  },
  {
    id: "auto-resume-limited-threads",
    title: "用量限制解除后继续",
    to: "/settings/threads",
    searchTerms: ["usage quota rate limit reset recover continue"],
  },
  {
    id: "working-shelf",
    title: "运行中分组",
    to: "/settings/general",
    searchTerms: ["hide fold running monitoring threads inbox sidebar shelf"],
  },
  {
    id: "tool-call-visibility",
    title: "聊天中的工具调用",
    to: "/settings/threads",
    searchTerms: [
      "hide tool calls commands edits searches work log activity quiet chat zen final answers only",
    ],
  },
  {
    id: "screen-reader-announcements",
    title: "屏幕阅读器播报",
    to: "/settings/threads",
    searchTerms: [
      "accessibility a11y screen reader nvda jaws voiceover orca narrator speech announce read aloud messages activity steps",
    ],
  },
  {
    id: "screen-reader-window-title",
    title: "屏幕阅读器窗口标题",
    to: "/settings/threads",
    searchTerms: [
      "accessibility a11y screen reader nvda jaws voiceover orca narrator window title tab title alt tab taskbar thread status order working approval",
    ],
  },
  {
    id: "auto-settle-inactive-threads",
    title: "自动收尾不活跃会话",
    to: "/settings/threads",
    searchTerms: ["sidebar inactivity days no activity automatically"],
    requiresThreadAutoSettlement: true,
    scope: "project-defaults",
  },
  {
    id: "compact-idle-threads",
    title: "压缩空闲会话",
    to: "/settings/providers",
    scope: "environment-defaults",
    searchTerms: ["claude context compaction idle cache tokens usage summary resume"],
  },
  {
    id: "pipeline-author-model",
    title: "流水线写单模型",
    to: "/settings/providers",
    scope: "environment-defaults",
    searchTerms: ["pipeline author model candidates ordered dispatch 写单 流水线"],
    environmentOnly: true,
  },
  {
    id: "pipeline-verifier-model",
    title: "流水线验单模型",
    to: "/settings/providers",
    scope: "environment-defaults",
    searchTerms: ["pipeline verifier model candidates ordered cold verify 验单 流水线"],
    environmentOnly: true,
  },
  {
    id: "auto-settle-merged-threads",
    title: "合并后自动收尾会话",
    to: "/settings/threads",
    searchTerms: ["pull request merge closed automatically sidebar"],
    requiresThreadAutoSettlement: true,
    scope: "project-defaults",
  },
  {
    id: "keep-threads-with-pull-requests",
    title: "保留有关联 PR 的会话",
    to: "/settings/threads",
    targetId: "auto-settle-inactive-threads",
    searchTerms: ["pull request inactivity auto-settle merge close sidebar"],
    requiresThreadAutoSettlement: true,
    scope: "project-defaults",
  },
  {
    id: "days-before-auto-settle",
    title: "自动收尾前的闲置天数",
    to: "/settings/threads",
    targetId: "auto-settle-inactive-threads",
    searchTerms: ["thread timeout activity sidebar"],
    requiresThreadAutoSettlement: true,
    scope: "project-defaults",
  },
  {
    id: "thread-notifications",
    title: "会话通知",
    to: "/settings/general",
    searchTerms: ["notification sound alert completion input approval desktop"],
  },
  {
    id: "in-app-notifications",
    title: "应用内通知",
    to: "/settings/general",
    searchTerms: ["notification toast popup completion input approval failure"],
  },
  {
    id: "time-format",
    title: "时间格式",
    to: "/settings/general",
    searchTerms: ["timestamp clock locale system browser os 12 hour 24 hour"],
  },
  {
    id: "response-streaming",
    title: "流式响应",
    to: "/settings/threads",
    scope: "project-defaults",
    searchTerms: ["output token paragraph buffered wait turn legacy"],
  },
  {
    id: "hide-whitespace-changes",
    title: "隐藏空白字符改动",
    to: "/settings/appearance",
    searchTerms: ["diff ignore spaces edits default"],
  },
  {
    id: "default-diff-file-state",
    title: "差异文件默认状态",
    to: "/settings/appearance",
    searchTerms: ["collapsed expanded collapse expand files pull request pr code tab"],
  },
  {
    id: "diff-layout",
    title: "差异布局",
    to: "/settings/appearance",
    searchTerms: ["stacked split side by side unified inline view"],
  },
  {
    id: "proactive-panels",
    title: "自动打开 PR 与改动面板",
    to: "/settings/appearance",
    searchTerms: ["proactive automatically open diff pull request pr right panel agent completion"],
  },
  {
    id: "skills-in-slash-menu",
    title: "在斜杠菜单中显示技能",
    to: "/settings/threads",
    searchTerms: ["command menu dollar $ slash /"],
  },
  {
    id: "composer-rich-text",
    title: "富文本输入框",
    to: "/settings/threads",
    searchTerms: ["composer rich text tiptap bold italic markdown styled wysiwyg"],
  },
  {
    id: "send-shortcut",
    title: "发送快捷键",
    to: "/settings/threads",
    searchTerms: ["enter return command ctrl multiline prompt new line composer"],
  },
  {
    id: "follow-up-behavior",
    title: "追加消息行为",
    to: "/settings/threads",
    searchTerms: ["queue steer running turn send default behavior composer"],
  },
  {
    id: "provider-update-checks",
    title: "提供方更新检查",
    to: "/settings/maintenance",
    searchTerms: ["installed cli versions newer available codex claude grok antigravity"],
    scope: "environment-defaults",
  },
  {
    id: "continue-threads-after-server-update",
    title: "重启后继续会话",
    to: "/settings/maintenance",
    scope: "project-defaults",
    searchTerms: [
      "resume running active interrupted work restart reboot machine crash desktop update automatically",
    ],
  },
  {
    id: "keep-awake-while-agents-work",
    title: "智能体工作时保持唤醒",
    to: "/settings/maintenance",
    scope: "environment-defaults",
    searchTerms: ["caffeinate sleep prevent stay awake power laptop lid inhibit"],
  },
  {
    id: "background-activity",
    title: "后台活动",
    to: "/settings/maintenance",
    scope: "environment-defaults",
    searchTerms: [
      "balanced performance battery saver advanced git fetch provider health refresh host power monitor idle policy",
    ],
  },
  {
    id: "new-threads",
    title: "新会话",
    to: "/settings/threads",
    scope: "project-defaults",
    searchTerms: ["default workspace mode draft local worktree"],
  },
  {
    id: "worktree-submodules",
    title: "子模块",
    to: "/settings/projects",
    scope: "project-defaults",
    searchTerms: ["git submodule init recursive top-level none worktree t3.json"],
  },
  {
    id: "start-from-origin",
    title: "从远程分支开始",
    to: "/settings/projects",
    scope: "project-defaults",
    searchTerms: ["new worktrees start remote origin latest fetched branch local"],
  },
  {
    id: "add-project-starts-in",
    title: "添加项目的起始目录",
    to: "/settings/threads",
    scope: "environment-defaults",
    searchTerms: ["base directory folder browser path home"],
  },
  {
    id: "ghq-clone-layout",
    title: "克隆到主机文件夹",
    to: "/settings/threads",
    scope: "environment-defaults",
    searchTerms: ["ghq clone destination host owner repository root layout"],
  },
  {
    id: "unpin-confirmation",
    title: "取消置顶确认",
    to: "/settings/general",
    searchTerms: ["ask before thread pinned section"],
  },
  {
    id: "archive-confirmation",
    title: "归档确认",
    to: "/settings/general",
    searchTerms: ["ask before thread second click inline action"],
  },
  {
    id: "delete-confirmation",
    title: "删除确认",
    to: "/settings/general",
    searchTerms: ["ask before thread chat history"],
  },
  {
    id: "quit-confirmation",
    title: "退出快捷键",
    to: "/settings/general",
    searchTerms: ["confirmation desktop app exit direct hold double click press twice"],
    desktopOnly: true,
  },
  {
    id: "text-generation-model",
    title: "文本生成模型",
    to: "/settings/threads",
    scope: "project-defaults",
    searchTerms: ["generated thread titles source control content default provider"],
  },
  {
    id: "thread-title-instructions",
    title: "会话标题生成说明",
    to: "/settings/threads",
    scope: "project-defaults",
    searchTerms: ["generated thread titles prompt custom style naming rename regenerate"],
  },
  {
    id: "app-version",
    title: "版本",
    to: "/settings/maintenance",
    searchTerms: ["about check for updates download install upgrade release"],
  },
  {
    id: "update-track",
    title: "更新通道",
    to: "/settings/maintenance",
    searchTerms: ["release channel stable latest nightly prerelease"],
    releaseChannelOnly: true,
  },
  {
    id: "cli-command",
    title: "t3 命令",
    to: "/settings/maintenance",
    searchTerms: ["cli terminal shell path install command line"],
    desktopOnly: true,
  },

  {
    id: "telemetry-export",
    title: "OpenTelemetry 导出",
    to: "/settings/diagnostics",
    targetId: "telemetry-export",
    scope: "environment",
    searchTerms: ["OTel OTLP telemetry export endpoints logs traces metrics Grafana"],
  },
  {
    id: "diagnostics",
    title: "诊断",
    to: "/settings/maintenance",
    searchTerms: ["logs traces processes resource history failures spans cpu memory"],
  },
  {
    id: "open-source-licenses",
    title: "开源许可",
    to: "/settings/maintenance",
  },
  {
    id: "keybindings",
    title: "快捷键",
    to: "/settings/general",
    searchTerms: ["keyboard shortcuts hotkeys commands bindings json"],
  },
  ...KEYBINDING_SEARCH_ITEMS,
  {
    id: "providers",
    title: "智能体提供方",
    to: "/settings/providers",
    searchTerms: [
      "agents cli codex claude grok antigravity google sign in sign out install subscription instances authentication api key models configuration binary path config directory codex_home shadow home endpoint arguments environment variables display name accent color custom favorite hidden auto compact native sessions import resume",
    ],
  },
  {
    id: "usage-providers",
    title: "用量数据提供方",
    to: "/settings/providers",
    searchTerms: [
      "usage sources CLIProxyAPI CLI proxy hub quota subscription limits management key add remove",
    ],
    providerSettingsOnly: true,
  },
  {
    id: "text-generators",
    title: "文本生成器",
    to: "/settings/providers",
    searchTerms: [
      "model api api key openai openrouter anthropic ollama lm studio custom endpoint base url thread titles commit messages",
    ],
    providerSettingsOnly: true,
  },
  {
    id: "provider-health-check-interval",
    title: "健康检查间隔",
    to: "/settings/providers",
    searchTerms: ["refresh availability versions auth state models background probes seconds off"],
    providerSettingsOnly: true,
  },
  {
    id: "scheduled-tasks",
    title: "定时任务",
    to: "/settings/scheduled-tasks",
  },
  {
    id: "pull-request-links-open-in-app",
    title: "在 Fleet ADE 中打开 PR",
    to: "/settings/appearance",
    searchTerms: [
      `pr commit links ${SOURCE_CONTROL_HOST_LABELS} browser external click default pull request view panel`,
    ],
  },
  {
    id: "automatic-pull",
    title: "自动拉取",
    to: "/settings/projects",
    scope: "project-defaults",
    searchTerms: ["auto pull default branch current checkout fast forward upstream"],
  },
  {
    id: "remove-agent-credits-on-merge",
    title: "合并时移除智能体署名",
    to: "/settings/projects",
    scope: "project-defaults",
    searchTerms: [
      `pull request ${SOURCE_CONTROL_HOST_LABELS} squash co-authored-by attribution claude codex generated`,
    ],
  },
  {
    id: "pull-request-merge-method",
    title: "默认合并方式",
    to: "/settings/projects",
    scope: "project-defaults",
    searchTerms: ["pull request merge squash rebase last selected"],
  },
  {
    id: "source-control",
    title: "版本控制",
    to: "/settings/projects",
    scope: "environment-defaults",
    searchTerms: [
      `version control git ${SOURCE_CONTROL_HOST_TERMS} hosting integrations credentials scan server environment`,
    ],
  },
  {
    id: "git-fetch-interval",
    title: "Git 获取间隔",
    to: "/settings/maintenance",
    targetId: "background-activity",
    searchTerms: [
      "automatic remote branch refresh background credentials security keys seconds off",
    ],
    environmentOnly: true,
    scope: "environment-defaults",
  },
  {
    id: "worktree-branch-naming",
    title: "工作树分支命名",
    to: "/settings/projects",
    searchTerms: ["static semantic prefix custom prompt instructions feat fix refactor chore"],
    environmentOnly: true,
    scope: "project-defaults",
  },
  ...sourceControlHostSearchItems(sourceControlClients.definitions),
  {
    id: "source-control-writing-style",
    title: "提交与 PR 文案",
    to: "/settings/projects",
    searchTerms: [
      "repository conventions conventional commits custom instructions commit messages change pr pull request merge request titles descriptions body style prompt write my own",
    ],
    environmentOnly: true,
  },
  {
    id: "follow-change-request-templates",
    title: "遵循 PR 模板",
    to: "/settings/projects",
    searchTerms: ["repository pr pull request merge request change request description structure"],
    environmentOnly: true,
  },
  {
    id: "source-control-writer-model",
    title: "版本控制文案模型",
    to: "/settings/projects",
    searchTerms: [
      "override generated commit change request pr titles descriptions branch bookmark",
    ],
    environmentOnly: true,
    scope: "project-defaults",
  },
  {
    id: "project-actions",
    title: "操作",
    to: "/settings/projects",
    searchTerms: ["commands scripts setup run dev server checkout worktree t3.json import"],
  },
  {
    id: "environment-icon",
    title: "环境图标",
    to: "/settings/connections",
    targetId: "connections-environment",
    searchTerms: ["machine glyph sidebar mac mini studio laptop desktop server cloud vm"],
  },
  {
    id: "local-environment",
    title: "本地环境",
    to: "/settings/connections",
    searchTerms: ["turn off on disable enable local server agents remote only restart"],
    desktopOnly: true,
  },
  {
    id: "network-access",
    title: "网络访问",
    to: "/settings/connections",
    targetId: "connections-environment",
    searchTerms: ["expose backend remote pairing local machine interfaces host restart"],
    localBackendManagementOnly: true,
  },
  {
    id: "tailscale-https",
    title: "Tailscale HTTPS",
    to: "/settings/connections",
    targetId: "connections-environment",
    searchTerms: ["serve magicdns endpoint remote secure network"],
    desktopOnly: true,
    localBackendManagementOnly: true,
  },
  {
    id: "wsl-backend",
    title: "WSL 后端",
    to: "/settings/connections",
    searchTerms: [
      "windows subsystem linux distro second server projects stop windows backend restart wsl only",
    ],
    desktopOnly: true,
    windowsOnly: true,
    localBackendManagementOnly: true,
    wslAvailableOnly: true,
  },
  {
    id: "t3-connect",
    localEnvironmentOnly: true,
    title: "T3 Connect",
    to: "/settings/connections",
    targetId: "connections-environment",
    searchTerms: ["managed tunnel cloud other devices remote tunnels limit t3 chat"],
    desktopOnly: true,
    cloudOnly: true,
  },
  {
    id: "hold-webhooks-while-offline",
    localEnvironmentOnly: true,
    title: "离线时保留 Webhook",
    to: "/settings/connections",
    targetId: "connections-environment",
    searchTerms: ["webhook automations offline queue mailbox t3 connect"],
    cloudOnly: true,
    managedTunnelOnly: true,
  },
  {
    id: "publish-agent-activity",
    localEnvironmentOnly: true,
    title: "发布智能体活动",
    to: "/settings/connections",
    targetId: "connections-environment",
    searchTerms: ["mobile push notifications live activities cloud tunnel"],
    cloudOnly: true,
  },
  {
    id: "connections-environment",
    title: "本机",
    to: "/settings/connections",
    searchTerms: [
      "connections server backend local remote access administrative permissions scope pairing links qr code authorized clients sessions revoke endpoint",
    ],
  },
  {
    id: "linked-environments",
    peerLinksOnly: true,
    title: "关联环境",
    to: "/settings/connections",
    targetId: "linked-environments",
    searchTerms: ["link peer another machine vps agents work there handoff pairing code"],
  },
  {
    id: "remote-environments",
    title: "环境",
    to: "/settings/connections",
    searchTerms: ["add pair backend host code ssh config agent tunnel saved t3 connect"],
  },
  {
    id: "load-balancing",
    title: "负载均衡",
    to: "/settings/connections",
    searchTerms: [
      "automatic machine environment resources cpu memory capacity preference weight shared projects",
    ],
  },
  {
    id: "pull-request-routing",
    title: "PR 共享",
    to: "/settings/connections",
    searchTerms: [
      `pull request routing trusted environments shared credentials permissions read actions source control ${SOURCE_CONTROL_HOST_LABELS}`,
    ],
  },
  {
    id: "secret-providers",
    title: "凭据提供方",
    to: "/settings/connections",
    searchTerms: ["vault credentials api key"],
    secretsFeatureOnly: true,
  },
  {
    id: "archive",
    title: "已归档会话",
    to: "/settings/threads",
    searchTerms: ["restore reopen deleted history projects"],
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;

export type SettingsSearchItemId = (typeof SETTINGS_SEARCH_ITEMS)[number]["id"];

const SEARCH_ITEMS_BY_ID = new Map(SETTINGS_SEARCH_ITEMS.map((item) => [item.id, item] as const));

const SETTINGS_CATEGORY_SCOPES: Readonly<Record<SettingsPath, SettingsSearchScope | null>> = {
  "/settings/diagnostics": "environment",
  "/settings/projects": "project",
  "/settings/general": null,
  "/settings/network": "environment",
  "/settings/appearance": null,
  "/settings/chat": null,
  "/settings/diffs": null,
  "/settings/keybindings": null,
  "/settings/providers": null,
  "/settings/threads": null,
  "/settings/source-control": "environment-defaults",
  "/settings/worktrees": "project-defaults",
  "/settings/connections": "connections",
  "/settings/access": "connections",
  "/settings/secrets": null,
  "/settings/scheduled-tasks": null,
  "/settings/maintenance": null,
  "/settings/about": null,
  "/settings/archived": "project-defaults",
};

/** Pages folded into one of the eight sections. Their rows keep working through the anchor. */
interface RenamedSettingsTarget {
  readonly to: SettingsPath;
  readonly defaultHash?: string;
}

const RENAMED_SETTINGS_PATHS: Readonly<Record<string, RenamedSettingsTarget>> = {
  "/settings/integrations": { to: "/settings/providers" },
  "/settings/storage": { to: "/settings/maintenance", defaultHash: "storage-artifacts" },
  "/settings/beta": { to: "/settings/maintenance" },
  "/settings/labs": { to: "/settings/maintenance" },
  "/settings/network": { to: "/settings/general", defaultHash: "network" },
  "/settings/keybindings": { to: "/settings/general", defaultHash: "keybindings" },
  "/settings/chat": { to: "/settings/threads", defaultHash: "composer" },
  "/settings/archived": { to: "/settings/threads", defaultHash: "archive" },
  "/settings/diffs": { to: "/settings/appearance", defaultHash: "diffs" },
  "/settings/source-control": { to: "/settings/projects", defaultHash: "source-control" },
  "/settings/worktrees": { to: "/settings/projects", defaultHash: "worktree-creation" },
  "/settings/access": { to: "/settings/connections", defaultHash: "connections-environment" },
  "/settings/secrets": { to: "/settings/connections", defaultHash: "secret-providers" },
  "/settings/about": { to: "/settings/maintenance", defaultHash: "about" },
};
const SPLIT_SETTINGS_PATHS: ReadonlySet<string> = new Set([
  "/settings/general",
  "/settings/appearance",
  "/settings/source-control",
  "/settings/connections",
  ...Object.keys(RENAMED_SETTINGS_PATHS),
]);
// Section anchors that moved but are not search results themselves.
const MOVED_SECTION_ANCHORS: Readonly<Record<string, SettingsPath>> = {
  "authorized-clients": "/settings/connections",
  "text-generation": "/settings/threads",
  about: "/settings/maintenance",
};

/** Where an old settings link now lives. Its anchor finds the page its row moved to. */
export function movedSettingsRedirect(
  pathname: string,
  hash: string,
): { readonly to: SettingsPath; readonly hash?: string } | null {
  if (!SPLIT_SETTINGS_PATHS.has(pathname)) return null;
  const items: readonly SettingsSearchItem[] = SETTINGS_SEARCH_ITEMS;
  const anchored = hash
    ? (items.find((item) => item.id === hash) ?? items.find((item) => item.targetId === hash))
    : undefined;
  const renamed = RENAMED_SETTINGS_PATHS[pathname];
  const to = anchored?.to ?? MOVED_SECTION_ANCHORS[hash] ?? renamed?.to ?? null;
  if (to === null || to === pathname) return null;
  if (hash) return { to, hash };
  return renamed?.defaultHash ? { to, hash: renamed.defaultHash } : { to };
}

export function movedSettingsPath(pathname: string, hash: string): SettingsPath | null {
  return movedSettingsRedirect(pathname, hash)?.to ?? null;
}

export function getSettingsSearchTargetScope(targetId: string) {
  const items: readonly SettingsSearchItem[] = SETTINGS_SEARCH_ITEMS;
  const item =
    items.find((candidate) => candidate.id === targetId) ??
    items.find((candidate) => candidate.targetId === targetId);
  return item
    ? {
        title: item.title,
        scope: item.scope ?? SETTINGS_CATEGORY_SCOPES[item.to],
        ...(item.requiresThreadAutoSettlement ? { requiresThreadAutoSettlement: true } : {}),
      }
    : null;
}

interface AutoSettlementSearchEnvironment {
  readonly environmentId: EnvironmentId;
  readonly connection: { readonly phase: EnvironmentConnectionPhase };
  readonly serverConfig: object | null;
}

export function getThreadAutoSettlementSearchAvailability(
  environments: readonly AutoSettlementSearchEnvironment[],
  scope?: Pick<ResolvedSettingsScope, "kind" | "environmentIds">,
) {
  const connected = environments.filter(
    (environment) =>
      environment.connection.phase === "connected" && environment.serverConfig !== null,
  );
  const eligibleEnvironmentIds = connected.map((environment) => environment.environmentId);
  const selected = connected.filter((environment) =>
    scope?.environmentIds.includes(environment.environmentId),
  );
  return {
    eligibleEnvironmentIds,
    isTargetAvailable:
      scope !== undefined &&
      scope.kind !== "unavailable" &&
      selected.length > 0 &&
      selected.every((environment) => eligibleEnvironmentIds.includes(environment.environmentId)),
  };
}

export function isSettingsSearchScopeAvailable(
  requiredScope: SettingsSearchScope | null,
  scopeKind: ResolvedSettingsScope["kind"],
): boolean {
  switch (requiredScope) {
    case null:
    case "connections":
      return true;
    case "environment":
    case "checkout":
      return requiredScope === scopeKind;
    case "project":
      return scopeKind === "project" || scopeKind === "checkout";
    case "environment-defaults":
      return scopeKind === "environment" || scopeKind === "all";
    case "project-defaults":
      return (
        scopeKind === "environment" ||
        scopeKind === "all" ||
        scopeKind === "project" ||
        scopeKind === "checkout"
      );
  }
}

export function searchableSetting(id: SettingsSearchItemId): {
  readonly id: string;
  readonly title: string;
} {
  const { id: anchorId, title } = SEARCH_ITEMS_BY_ID.get(id)!;
  return { id: anchorId, title };
}

export function filterAvailableSettingsSearchItems(
  availability: SettingsSearchAvailability,
): ReadonlyArray<SettingsSearchItem> {
  const items: ReadonlyArray<SettingsSearchItem> = SETTINGS_SEARCH_ITEMS;
  return items.filter(
    (item) =>
      (!item.cloudOnly || availability.hasCloudPublicConfig) &&
      (!item.environmentOnly || availability.hasEnvironment) &&
      (!item.providerSettingsOnly || availability.hasProviderSettingsEnvironment) &&
      (!item.localBackendManagementOnly || availability.canManageLocalBackend) &&
      (!item.localEnvironmentOnly || !availability.localEnvironmentDisabled) &&
      (!item.primaryEnvironmentOnly || availability.hasPrimaryEnvironment === true) &&
      (!item.wslAvailableOnly || availability.isWslSettingsRowVisible) &&
      (!item.requiresThreadAutoSettlement || availability.hasThreadAutoSettlement) &&
      (!item.managedTunnelOnly || availability.managedTunnelActive === true) &&
      (!item.peerLinksOnly || availability.hasPeerLinkHost === true),
  );
}

/** The settings that exist on this platform and app channel. */
export function settingsForThisPlatform(
  items: ReadonlyArray<SettingsSearchItem>,
): ReadonlyArray<SettingsSearchItem> {
  const platform = typeof navigator === "undefined" ? "" : navigator.platform;
  return items.filter(
    (item) =>
      (isElectron || item.desktopOnly !== true) &&
      (!item.releaseChannelOnly || isElectron) &&
      (!item.secretsFeatureOnly || isSecretsFeatureEnabled) &&
      (!item.windowsOnly || isWindowsPlatform(platform)),
  );
}

export function searchSettings(
  query: string,
  items: ReadonlyArray<SettingsSearchItem> = SETTINGS_SEARCH_ITEMS,
  translate: (message: string) => string = (message) => message,
): ReadonlyArray<SettingsSearchItem> {
  const normalizedQuery = normalizeSearchText(query);
  if (normalizedQuery.length === 0) return [];
  const queryTokens = normalizedQuery.split(" ");

  return settingsForThisPlatform(items)
    .flatMap((item, index) => {
      const title = normalizeSearchText(item.title);
      const fields = [
        title,
        normalizeSearchText(SETTINGS_SECTION_LABELS[item.to]),
        // The labels as displayed, so search also works in the active language.
        normalizeSearchText(translate(item.title)),
        normalizeSearchText(translate(SETTINGS_SECTION_LABELS[item.to])),
        ...(item.searchTerms ?? []).map(normalizeSearchText),
      ];
      if (!queryTokens.every((token) => fields.some((field) => field.includes(token)))) return [];

      const exactPhraseField = fields.findIndex((field) => field.includes(normalizedQuery));
      const rank =
        title === normalizedQuery
          ? 5
          : title.startsWith(normalizedQuery)
            ? 4
            : title.includes(normalizedQuery)
              ? 3
              : queryTokens.every((token) => title.includes(token))
                ? 2
                : exactPhraseField >= 0
                  ? 1
                  : 0;
      return [{ item, index, rank }];
    })
    .toSorted(
      (left, right) =>
        Number(left.item.secondary ?? false) - Number(right.item.secondary ?? false) ||
        right.rank - left.rank ||
        left.index - right.index,
    )
    .map(({ item }) => item);
}

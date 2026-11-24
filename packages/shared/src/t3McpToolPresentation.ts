export type T3McpToolLogo = "t3-code";

export interface T3McpToolPresentation {
  readonly displayName: string;
  readonly logo: T3McpToolLogo;
}

export type T3McpToolSummaryAction =
  | "capabilities"
  | "delegate"
  | "task-status"
  | "task-cancel"
  | "schedule-run"
  | "schedule-create"
  | "schedule-list"
  | "schedule-update"
  | "schedule-delete"
  | "thread-create"
  | "thread-list"
  | "thread-read"
  | "thread-send"
  | "thread-wait"
  | "thread-interrupt"
  | "workflow-stop"
  | "background-wait"
  | "thread-configuration"
  | "thread-configure"
  | "thread-fork"
  | "thread-merge"
  | "thread-search"
  | "thread-transfers"
  | "thread-organize"
  | "thread-update"
  | "queue-list"
  | "queue-read"
  | "queue-edit"
  | "queue-cancel"
  | "queue-reorder"
  | "queue-steer"
  | "question-list"
  | "question-read"
  | "question-respond"
  | "secret-request"
  | "worktree-handoff"
  | "worktree-list"
  | "worktree-status"
  | "project-list"
  | "project-read"
  | "project-create"
  | "project-update"
  | "project-delete"
  | "project-clone"
  | "environment-read"
  | "environment-links"
  | "environment-link"
  | "environment-unlink"
  | "environment-update"
  | "attachment-prepare"
  | "attachment-discard"
  | "attachment-send"
  | "link-pr"
  | "unlink-pr"
  | "list-prs"
  | "watch-pr"
  | "unwatch-pr"
  | "write-pr-guides"
  | "read-pr-guide"
  | "html-preview"
  | "html-render";

export interface T3McpToolDefinition {
  readonly displayName: string;
  readonly labels: readonly [action: string, running: string, completed: string, detail: string];
  readonly icon: "t3-code" | "pull-request";
  readonly summaryAction: T3McpToolSummaryAction;
}

function joinToolPhrase(left: string, right: string): string {
  if (!left) return right;
  if (!right) return left;
  return /[A-Za-z0-9]$/.test(left) || /^[A-Za-z0-9#]/.test(right)
    ? `${left} ${right}`
    : `${left}${right}`;
}

function tool(
  labels: T3McpToolDefinition["labels"],
  summaryAction: T3McpToolSummaryAction,
  icon: T3McpToolDefinition["icon"] = "t3-code",
  displayName = joinToolPhrase(labels[0], labels[3]),
): T3McpToolDefinition {
  return { displayName, labels, icon, summaryAction };
}

// Codex registers "t3-code-direct" for T3 tools kept out of Code Mode.
const T3_MCP_SERVER_ALIASES = new Set([
  "t3-code",
  "t3_code",
  "t3code",
  "t3-code-direct",
  "t3_code_direct",
]);

const T3_MCP_TOOLS: Readonly<Record<string, T3McpToolDefinition>> = {
  link_pull_request: tool(["关联", "正在关联", "已关联", "PR"], "link-pr", "pull-request"),
  link_pull_requests: tool(["关联", "正在关联", "已关联", "多个 PR"], "link-pr", "pull-request"),
  unlink_pull_request: tool(
    ["取消关联", "正在取消关联", "已取消关联", "PR"],
    "unlink-pr",
    "pull-request",
  ),
  unlink_pull_requests: tool(
    ["取消关联", "正在取消关联", "已取消关联", "按状态筛选的 PR"],
    "unlink-pr",
    "pull-request",
  ),
  list_thread_pull_requests: tool(
    ["查看", "正在查看", "已查看", "关联的 PR"],
    "list-prs",
    "pull-request",
  ),
  watch_pull_request: tool(["关注", "正在关注", "正在关注", "PR"], "watch-pr", "pull-request"),
  unwatch_pull_request: tool(
    ["停止关注", "正在停止关注", "已停止关注", "PR"],
    "unwatch-pr",
    "pull-request",
  ),
  write_pull_request_guides: tool(
    ["编写", "正在编写", "已开始编写", "评审指南"],
    "write-pr-guides",
    "pull-request",
  ),
  read_pull_request_guide: tool(
    ["读取", "正在读取", "已读取", "评审指南"],
    "read-pr-guide",
    "pull-request",
  ),
  orchestrator_capabilities: tool(["查询", "正在查询", "已查询", "编排能力"], "capabilities"),
  delegate_task: tool(["委派", "正在委派", "已委派", "子任务"], "delegate"),
  task_status: tool(["查询", "正在查询", "已查询", "子任务状态"], "task-status"),
  task_cancel: tool(["取消", "正在取消", "已请求取消", "子任务"], "task-cancel"),
  schedule_task: tool(["创建", "正在创建", "已创建", "定时任务"], "schedule-create"),
  list_scheduled_tasks: tool(["列出", "正在列出", "已列出", "定时任务"], "schedule-list"),
  update_scheduled_task: tool(["更新", "正在更新", "已更新", "定时任务"], "schedule-update"),
  delete_scheduled_task: tool(["删除", "正在删除", "已请求删除", "定时任务"], "schedule-delete"),
  request_secret: tool(["请求", "正在请求", "已请求", "密钥"], "secret-request"),
  create_threads: tool(["创建", "正在创建", "已创建", "会话"], "thread-create"),
  t3_thread_start: tool(["启动", "正在启动", "已启动", "会话"], "thread-create"),
  t3_thread_list: tool(["列出", "正在列出", "已列出", "会话"], "thread-list"),
  t3_thread_read: tool(["读取", "正在读取", "已读取", "会话"], "thread-read"),
  t3_thread_send: tool(["发送消息至", "正在发送消息至", "已发送消息至", "会话"], "thread-send"),
  t3_thread_wait: tool(["等待", "正在等待", "已等待", "会话"], "thread-wait"),
  t3_workflow_stop: tool(["停止", "正在停止", "已请求停止", "工作流"], "workflow-stop"),
  t3_background_wait: tool(["更新", "正在更新", "已更新", "后台等待配置"], "background-wait"),
  t3_thread_interrupt: tool(["中断", "正在中断", "已请求中断", "会话"], "thread-interrupt"),
  t3_worktree_handoff: tool(["交接至", "正在交接至", "已交接至", "Git 工作树"], "worktree-handoff"),
  t3_worktree_status: tool(["查询", "正在查询", "已查询", "工作树状态"], "worktree-status"),
  run_scheduled_task_now: tool(["运行", "正在运行", "已请求运行", "定时任务"], "schedule-run"),
  t3_queue: tool(["管理", "正在管理", "已管理", "排队消息"], "queue-edit"),
  t3_pending_request: tool(["处理", "正在处理", "已处理", "待处理问题"], "question-respond"),
  t3_queue_list: tool(["列出", "正在列出", "已列出", "排队消息"], "queue-list"),
  t3_queue_read: tool(["读取", "正在读取", "已读取", "排队消息"], "queue-read"),
  t3_queue_edit: tool(["编辑", "正在编辑", "已编辑", "排队消息"], "queue-edit"),
  t3_queue_cancel: tool(["取消", "正在取消", "已请求取消", "排队执行"], "queue-cancel"),
  t3_queue_reorder: tool(["调整顺序", "正在调整顺序", "已调整顺序", "排队执行"], "queue-reorder"),
  t3_queue_promote_to_steer: tool(
    ["立即发送", "正在立即发送", "已请求立即发送", "排队消息"],
    "queue-steer",
  ),
  t3_pending_request_list: tool(["列出", "正在列出", "已列出", "待处理问题"], "question-list"),
  t3_pending_request_read: tool(["读取", "正在读取", "已读取", "待处理问题"], "question-read"),
  t3_pending_request_respond: tool(
    ["回复", "正在回复", "已回复", "待处理问题"],
    "question-respond",
  ),
  t3_thread_configuration: tool(["读取", "正在读取", "已读取", "会话配置"], "thread-configuration"),
  t3_thread_configure: tool(["修改", "正在修改", "已修改", "会话模型设置"], "thread-configure"),
  t3_thread_transfer: tool(["使用", "正在使用", "已使用", "会话流转"], "thread-fork"),
  t3_thread_fork: tool(["分叉", "正在分叉", "已请求分叉", "当前会话"], "thread-fork"),
  t3_thread_merge_back: tool(["合并", "正在合并", "已请求合并", "会话上下文"], "thread-merge"),
  t3_thread_search: tool(["搜索", "正在搜索", "已搜索", "会话内容"], "thread-search"),
  t3_thread_transfers: tool(["读取", "正在读取", "已读取", "会话流转记录"], "thread-transfers"),
  t3_thread_organize: tool(["整理", "正在整理", "已整理", "会话"], "thread-organize"),
  t3_thread_update: tool(["更新", "正在更新", "已更新", "会话信息"], "thread-update"),
  t3_worktree_list: tool(["列出", "正在列出", "已列出", "工作区分支"], "worktree-list"),
  t3_environment_read: tool(["读取", "正在读取", "已读取", "环境偏好设置"], "environment-read"),
  t3_environment_links: tool(["列出", "正在列出", "已列出", "已关联环境"], "environment-links"),
  t3_environment_link: tool(["请求关联", "正在请求关联", "已请求关联", "环境"], "environment-link"),
  t3_environment_unlink: tool(["移除", "正在移除", "已移除", "已关联环境"], "environment-unlink"),
  t3_environment_preferences_update: tool(
    ["更新", "正在更新", "已更新", "环境偏好设置"],
    "environment-update",
  ),
  t3_thread_launch: tool(["启动", "正在启动", "已启动", "项目会话"], "thread-create"),
  t3_project_list: tool(["列出", "正在列出", "已列出", "项目"], "project-list"),
  t3_project_read: tool(["读取", "正在读取", "已读取", "项目"], "project-read"),
  t3_project_create: tool(["注册", "正在注册", "已注册", "项目"], "project-create"),
  t3_project_update: tool(["更新", "正在更新", "已更新", "项目"], "project-update"),
  t3_project_delete: tool(["删除", "正在删除", "已删除", "项目"], "project-delete"),
  t3_project_clone: tool(["克隆", "正在克隆", "已克隆", "仓库"], "project-clone"),
  t3_attachment_prepare_upload: tool(
    ["准备", "正在准备", "已准备", "附件上传"],
    "attachment-prepare",
  ),
  t3_attachment_discard: tool(["丢弃", "正在丢弃", "已丢弃", "待上传附件"], "attachment-discard"),
  t3_thread_send_attachments: tool(["发送", "正在发送", "已发送", "附件"], "attachment-send"),
  html_preview: tool(["预览", "正在预览", "已预览", "HTML 页面"], "html-preview"),
  html_render: tool(["渲染", "正在渲染", "已渲染", "HTML 页面"], "html-render"),
};

export const T3_MCP_TOOL_NAMES: ReadonlySet<string> = new Set(Object.keys(T3_MCP_TOOLS));

function normalizeT3McpToolLabel(value: string): string {
  return value.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
}

// Timelines resolve every work row's tool name on each update; names repeat across updates.
// ACP titles can carry whole commands, so long labels are parsed but not kept.
const toolNameCache = new Map<string, string | null>();
const TOOL_NAME_CACHE_LIMIT = 10_000;
const TOOL_NAME_CACHE_MAX_KEY_LENGTH = 256;

function resolveT3McpToolName(value: string): string | null {
  if (value.length > TOOL_NAME_CACHE_MAX_KEY_LENGTH) return parseT3McpToolName(value);
  const cached = toolNameCache.get(value);
  if (cached !== undefined) return cached;
  const name = parseT3McpToolName(value);
  if (toolNameCache.size >= TOOL_NAME_CACHE_LIMIT) toolNameCache.clear();
  toolNameCache.set(value, name);
  return name;
}

// ACP tool prefixes vary; match loosely but require a known display-name entry.
function parseT3McpToolName(value: string): string | null {
  const label = normalizeT3McpToolLabel(value);
  const mcpMatch = /^mcp__(?<server>.+?)__(?<tool>.+)$/i.exec(label);
  if (mcpMatch?.groups) {
    const { server, tool } = mcpMatch.groups;
    return server !== undefined &&
      tool !== undefined &&
      T3_MCP_SERVER_ALIASES.has(server.toLowerCase())
      ? tool
      : null;
  }

  const namespaceMatch =
    /^(?<server>t3[-_]code[-_]direct|t3-code|t3_code|t3code)(?:[.:/]|\s*·\s*)(?<tool>.+)$/i.exec(
      label,
    );
  if (namespaceMatch?.groups) {
    return namespaceMatch.groups.tool ?? null;
  }

  const prefixed = /^(?:mcp[-_]{1,2})?t3[-_ ]?code(?:__|[-_.:/ ])(?<tool>.+)$/i.exec(label);
  const candidate = prefixed?.groups?.tool ?? label;
  if (Object.hasOwn(T3_MCP_TOOLS, candidate)) return candidate;
  // OpenCode 2 thread prefixes can contain underscores; choose the longest known tool-name suffix.
  if (!/^t3-code-/i.test(label)) return null;
  let longest: string | null = null;
  for (const tool of Object.keys(T3_MCP_TOOLS)) {
    if (label.endsWith(`_${tool}`) && tool.length > (longest?.length ?? 0)) longest = tool;
  }
  return longest;
}

export function resolveT3McpToolId(toolName: string | null | undefined): string | null {
  const name = toolName == null ? null : resolveT3McpToolName(toolName);
  return name !== null && Object.hasOwn(T3_MCP_TOOLS, name) ? name : null;
}

/** The T3 tool a stored call names, even one this app no longer offers. */
export function resolveStoredT3McpToolName(toolName: string | null | undefined): string | null {
  return toolName == null ? null : resolveT3McpToolName(toolName);
}

type SummaryInput = Readonly<Record<string, unknown>>;

const asSummaryInput = (input: unknown): SummaryInput | undefined =>
  typeof input === "object" && input !== null ? (input as SummaryInput) : undefined;

/** Action tools present each call as the single-purpose tool its action replaced. */
const ACTION_TOOLS: Readonly<Record<string, (action: string) => string | undefined>> = {
  t3_queue: (action) => `t3_queue_${action}`,
  t3_pending_request: (action) => `t3_pending_request_${action}`,
  t3_thread_transfer: (action) =>
    ({ fork: "t3_thread_fork", merge_back: "t3_thread_merge_back", status: "t3_thread_transfers" })[
      action
    ],
};

/** Pass the call's input so an action tool resolves to the labels and summary of its action. */
export function resolveT3McpToolDefinition(
  toolName: string | null | undefined,
  input?: unknown,
): T3McpToolDefinition | null {
  const name = toolName == null ? null : resolveT3McpToolName(toolName);
  if (name === null || !Object.hasOwn(T3_MCP_TOOLS, name)) return null;
  const action = asSummaryInput(input)?.action;
  const actionTool = typeof action === "string" ? ACTION_TOOLS[name]?.(action) : undefined;
  return actionTool !== undefined && Object.hasOwn(T3_MCP_TOOLS, actionTool)
    ? T3_MCP_TOOLS[actionTool]!
    : T3_MCP_TOOLS[name]!;
}

/** Tools whose summary depends on which fields a call sets. */
const ACTION_SUMMARIES: Readonly<
  Record<string, (input: SummaryInput) => T3McpToolSummaryAction | undefined>
> = {
  t3_thread_configure: ({ modelSelection }) =>
    modelSelection === undefined ? "thread-configuration" : "thread-configure",
  schedule_task: ({ scheduledTaskId }) =>
    scheduledTaskId === undefined ? "schedule-create" : "schedule-update",
};

export function resolveT3McpSummaryAction(
  toolName: string | null | undefined,
  input: unknown,
): T3McpToolSummaryAction | null {
  const definition = resolveT3McpToolDefinition(toolName, input);
  if (definition === null) return null;
  const summarize = ACTION_SUMMARIES[resolveT3McpToolName(toolName!) ?? ""];
  const fields = asSummaryInput(input);
  return (fields && summarize?.(fields)) ?? definition.summaryAction;
}

export function resolveT3McpToolPresentation(
  toolName: string | null | undefined,
  input?: unknown,
): T3McpToolPresentation | null {
  const definition = resolveT3McpToolDefinition(toolName, input);
  return definition === null ? null : { displayName: definition.displayName, logo: "t3-code" };
}

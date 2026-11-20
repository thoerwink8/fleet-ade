import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthDiagnosticsReadScope,
  AuthEnvironmentMaintainScope,
  AuthFilesystemReadScope,
  AuthFilesystemWriteScope,
  type AuthGrantScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthPreviewOperateScope,
  AuthProvidersManageScope,
  AuthRelayReadScope,
  AuthRelayWriteScope,
  AuthSettingsWriteScope,
  AuthSourceControlWriteScope,
  AuthTerminalOperateScope,
  AuthTerminalReadScope,
} from "@t3tools/contracts";

export const AUTH_SCOPE_OPTIONS: ReadonlyArray<{
  readonly scope: AuthGrantScope;
  readonly title: string;
  readonly description: string;
}> = [
  {
    scope: AuthOrchestrationReadScope,
    title: "查看环境",
    description: "读取会话、状态、检查点和配置。",
  },
  {
    scope: AuthOrchestrationOperateScope,
    title: "操作任务",
    description: "启动、更新和停止任务。",
  },
  {
    scope: AuthSettingsWriteScope,
    title: "修改环境设置",
    description: "编辑环境偏好和快捷键。",
  },
  {
    scope: AuthProvidersManageScope,
    title: "管理提供方",
    description: "配置、安装、登录和更新提供方与用量来源。",
  },
  {
    scope: AuthEnvironmentMaintainScope,
    title: "维护环境",
    description: "更新服务器并控制环境进程。",
  },
  {
    scope: AuthPreviewOperateScope,
    title: "控制预览",
    description: "打开浏览器预览并托管浏览器自动化。",
  },
  {
    scope: AuthDiagnosticsReadScope,
    title: "查看诊断和用量",
    description: "读取进程诊断、资源历史和用量汇总。",
  },
  {
    scope: AuthTerminalReadScope,
    title: "查看终端",
    description: "读取已有终端的输出和状态。",
  },
  {
    scope: AuthTerminalOperateScope,
    title: "使用终端",
    description: "创建终端并向运行中的 shell 发送输入。",
  },
  {
    scope: AuthSourceControlWriteScope,
    title: "修改源代码管理",
    description: "提交、推送，管理分支和仓库，以及修改 pull request。",
  },
  {
    scope: AuthFilesystemReadScope,
    title: "读取文件",
    description: "浏览主机文件、搜索工作区、查看本地改动。",
  },
  {
    scope: AuthFilesystemWriteScope,
    title: "写入文件",
    description: "编辑工作区文件并将计划保存到磁盘。",
  },
  {
    scope: AuthAccessReadScope,
    title: "查看访问",
    description: "查看配对链接和已授权客户端。",
  },
  {
    scope: AuthAccessWriteScope,
    title: "管理访问",
    description: "为其他客户端签发和吊销凭证。",
  },
  {
    scope: AuthRelayReadScope,
    title: "查看中转",
    description: "查看托管中转的连接状态。",
  },
  {
    scope: AuthRelayWriteScope,
    title: "管理中转",
    description: "修改托管隧道的连接。",
  },
];

/** Shown instead of the granted scopes while they are unknown, so every surface says the same thing. */
export function sessionPermissionsUnavailableMessage(input: {
  readonly connected: boolean;
  /** The check errored; the client retries it while connected. */
  readonly failed: boolean;
  /** The environment answered that this session is not signed in; retrying will not change that. */
  readonly rejected: boolean;
}): string {
  if (!input.connected) return "连接到此环境后，才能查看此会话的权限。";
  if (input.rejected) return "此环境没有接受你的会话。请重新连接后重试。";
  return input.failed ? "无法验证你的权限，正在自动重试。" : "正在检查权限…";
}

import {
  OrchestrationV2RollbackFailureCode,
  PROVIDER_DISPLAY_NAMES,
  type ProviderDriverKind,
} from "@t3tools/contracts";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as SqlError from "effect/sql/SqlError";

const GENERIC_ERROR_PREFIXES = [
  "Failed to dispatch orchestration V2 command",
  "Failed to dispatch orchestration command ",
  "Provider adapter failed while dispatching orchestration command ",
];

const SQLITE_RECOVERY_MESSAGES: Readonly<Record<number, string>> = {
  5: "Fleet ADE 服务器数据库正忙（SQLITE_BUSY）。请稍等再试。如果反复出现，请检查是否有另一个 Fleet ADE 进程正在使用服务器上的同一数据目录。",
  6: "Fleet ADE 服务器数据库已锁定（SQLITE_LOCKED）。请稍等再试。如果反复出现，请查看服务器日志，找出占用数据库锁的进程。",
  8: "Fleet ADE 服务器数据库是只读的（SQLITE_READONLY）。请在运行服务器的机器上确认数据目录可写、磁盘以读写方式挂载，然后重试。",
  10: "Fleet ADE 服务器无法读写数据库（SQLITE_IOERR）。请在运行服务器的机器上检查磁盘剩余空间和磁盘健康，然后重试。若仍然失败，请查看服务器日志。",
  11: "Fleet ADE 服务器数据库似乎已损坏（SQLITE_CORRUPT）。请保留服务器数据目录，并在从备份恢复前查看服务器日志。",
  13: "Fleet ADE 服务器无法保存这次更改，因为数据库或磁盘已满（SQLITE_FULL）。请在运行服务器的机器上腾出空间，然后重试。如果空间足够，请查看服务器日志里的数据库大小限制。",
  14: "Fleet ADE 服务器无法打开数据库文件（SQLITE_CANTOPEN）。请在运行服务器的机器上检查磁盘空间，并确认数据和临时目录存在且可写，然后重试。若仍然失败，请查看服务器日志。",
  26: "Fleet ADE 服务器无法读取数据库文件（SQLITE_NOTADB）。请保留服务器数据目录，并在从备份恢复前检查配置的数据库路径和服务器日志。",
};

function databaseErrorMessage(value: unknown): string | undefined {
  if (!SqlError.isSqlError(value)) return undefined;

  let cause: unknown = value.cause;
  const seen = new Set<unknown>();
  while (Predicate.isObject(cause) && !seen.has(cause)) {
    seen.add(cause);
    // node:sqlite uses extended result codes; their low byte is the primary code.
    if (typeof cause.errcode === "number" && Number.isInteger(cause.errcode) && cause.errcode > 0) {
      const message = SQLITE_RECOVERY_MESSAGES[cause.errcode & 0xff];
      if (message !== undefined) return message;
    }
    cause = cause.cause;
  }

  return "Fleet ADE 服务器无法完成这次数据库请求。请重试一次；若仍然失败，请查看服务器日志中的数据库错误。";
}

export function userFacingDatabaseErrorMessage(cause: unknown): string | undefined {
  const seen = new Set<unknown>();
  let value = cause;
  while (Predicate.isObject(value) && !seen.has(value)) {
    seen.add(value);
    const message = databaseErrorMessage(value);
    if (message !== undefined) return message;
    value = value.cause;
  }
  return undefined;
}

const CAPABILITY_REJECTION_MESSAGES: Record<string, (provider: string) => string> = {
  queued_messages: (p) => `${p} 不能在正在进行的运行后面排队消息。`,
  active_steering: (p) => `${p} 不能改道正在进行的运行。请先停止，再发送消息。`,
  interrupt_restart_steering: (p) => `${p} 不能改道正在进行的运行。请先停止，再发送消息。`,
  interrupt: (p) => `${p} 不能在运行开始后停止它。`,
  native_fork: (p) => `${p} 不能原生分叉这个会话。`,
  fork_from_turn: (p) => `${p} 不能从这个会话更早的位置分叉。`,
  rollback: (p) => `${p} 不能回退对话，因此无法在这个会话上恢复此检查点。`,
  rollback_snapshot: (p) => `${p} 没有报告回退后的对话状态，因此没有恢复检查点。`,
  context_handoff: (p) => `${p} 不能接收这次切换所需的上下文交接。`,
  strong_terminal_status: (p) => `${p} 不能可靠确认运行何时结束，因此无法这样做。`,
};

function providerDisplayName(instanceId: string): string {
  const known = PROVIDER_DISPLAY_NAMES[instanceId as ProviderDriverKind];
  if (known !== undefined) return known;
  const trimmed = instanceId.replace(/Agent$/i, "").trim();
  if (trimmed.length === 0) return instanceId;
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

function policyRejectionMessage(value: unknown): string | undefined {
  if (!Predicate.isObject(value) || typeof value.providerInstanceId !== "string") return undefined;
  const provider = providerDisplayName(value.providerInstanceId);
  if (value._tag === "CommandPolicyCapabilityUnsupportedError") {
    const capability = typeof value.capability === "string" ? value.capability : "";
    return CAPABILITY_REJECTION_MESSAGES[capability]?.(provider);
  }
  return undefined;
}

function textValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function messageFrom(value: unknown): string | undefined {
  if (typeof value === "string") {
    return textValue(value);
  }
  const friendly = policyRejectionMessage(value);
  if (friendly !== undefined) {
    return friendly;
  }
  if (value instanceof Error) {
    return textValue(value.message);
  }
  if (!Predicate.isObject(value)) {
    return undefined;
  }
  return textValue(value.detail) ?? textValue(value.message);
}

function isGenericErrorMessage(message: string): boolean {
  return GENERIC_ERROR_PREFIXES.some((prefix) => message.startsWith(prefix));
}

function collectErrorMessages(value: unknown, seen: Set<unknown>): ReadonlyArray<string> {
  if (value === undefined || value === null || seen.has(value)) {
    return [];
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.flatMap((item) => collectErrorMessages(item, seen));
  }

  const databaseMessage = databaseErrorMessage(value);
  if (databaseMessage !== undefined) return [databaseMessage];

  const message = messageFrom(value);
  if (!Predicate.isObject(value)) {
    return message === undefined ? [] : [message];
  }

  const nested = [
    ...collectErrorMessages(value.cause, seen),
    ...collectErrorMessages(value.error, seen),
    ...collectErrorMessages(value.errors, seen),
  ];

  return message === undefined ? nested : [message, ...nested];
}

const isRollbackFailureCode = Schema.is(OrchestrationV2RollbackFailureCode);

export function dispatchErrorCode(cause: unknown): OrchestrationV2RollbackFailureCode | undefined {
  const seen = new Set<unknown>();
  let value = cause;
  while (Predicate.isObject(value) && !seen.has(value)) {
    seen.add(value);
    if ("code" in value && isRollbackFailureCode(value.code)) return value.code;
    value = value.cause;
  }
  return undefined;
}

export function userFacingDispatchErrorMessage(cause: unknown): string | undefined {
  const messages = collectErrorMessages(cause, new Set()).filter(
    (message, index, allMessages) =>
      !isGenericErrorMessage(message) && allMessages.indexOf(message) === index,
  );
  return messages.at(-1);
}

export function threadLaunchBaseRefMessage(input: {
  readonly baseRef: string;
  readonly projectTitle: string;
  readonly workspaceRoot: string;
}): string {
  return `在项目「${input.projectTitle}」（${input.workspaceRoot}）中，基线引用「${input.baseRef}」对不上任何提交。`;
}

export function threadLaunchBranchConflictMessage(input: {
  readonly projectTitle: string;
  readonly branch: string;
  readonly conflictingBranch: string;
}): string {
  return `无法在项目「${input.projectTitle}」里创建分支「${input.branch}」：分支「${input.conflictingBranch}」已经存在。`;
}

export function threadLaunchNotRepositoryMessage(input: {
  readonly projectTitle: string;
  readonly workspaceRoot: string;
}): string {
  return `项目「${input.projectTitle}」（${input.workspaceRoot}）不是 Git 仓库。`;
}

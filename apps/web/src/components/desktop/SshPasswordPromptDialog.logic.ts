import { describeRequestFailure } from "@t3tools/client-runtime/errors";

export function sshPromptErrorMessage(cause: unknown): string {
  const failure = describeRequestFailure(cause);
  const message = failure instanceof Error ? failure.message : "SSH 验证提示失败。";
  return message.includes("expired") || message.includes("no longer pending")
    ? "此 SSH 验证提示已过期，请重新连接。"
    : message;
}

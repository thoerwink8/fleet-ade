import type { ClientSettings } from "@t3tools/contracts/settings";
import { isMacPlatform } from "./lib/utils";

const DEFAULT_COMPOSER_PLACEHOLDER = "想问什么都可以。@ 引用文件，$ 使用技能，/ 输入命令";

export function getComposerPlaceholder(input: {
  readonly isRunning: boolean;
  readonly followUpBehavior: ClientSettings["followUpBehavior"];
  readonly sendShortcut?: ClientSettings["sendShortcut"];
  readonly canSteer?: boolean;
  readonly platform?: string;
  readonly alternateShortcutLabel?: string | null;
  /** False on touch-only devices: the text then names no keys. Defaults to true. */
  readonly hasKeyboard?: boolean;
}): string {
  if (!input.isRunning) {
    return DEFAULT_COMPOSER_PLACEHOLDER;
  }
  const platform = input.platform ?? (typeof navigator !== "undefined" ? navigator.platform : "");
  const isMac = isMacPlatform(platform);
  const requiresMod = input.sendShortcut === "mod-enter";
  const primaryPrefix = requiresMod ? (isMac ? "⌘Enter " : "Ctrl+Enter ") : "回车";
  const queueClause = (prefix: string) => `${prefix}排队，等这一轮做完再发`;
  const steerClause = (prefix: string) => `${prefix}立即发送（会打断当前这一轮）`;

  if (input.hasKeyboard === false) {
    return input.canSteer !== false && input.followUpBehavior === "steer"
      ? "发送后立即发送（会打断当前这一轮）"
      : "发送后排队，等这一轮做完再发";
  }

  if (input.canSteer === false) {
    return queueClause(primaryPrefix);
  }

  const alternateKey =
    input.alternateShortcutLabel !== undefined
      ? input.alternateShortcutLabel
      : requiresMod
        ? isMac
          ? "⇧⌘Enter"
          : "Ctrl+Shift+Enter"
        : isMac
          ? "⌘Enter"
          : "Ctrl+Enter";

  if (input.followUpBehavior === "queue") {
    return alternateKey
      ? `${queueClause(primaryPrefix)}；${steerClause(`${alternateKey} `)}`
      : queueClause(primaryPrefix);
  }
  return alternateKey
    ? `${steerClause(primaryPrefix)}；${queueClause(`${alternateKey} `)}`
    : steerClause(primaryPrefix);
}

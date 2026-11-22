import type { RuntimeMode } from "@t3tools/contracts";
import {
  type LucideIcon,
  LockIcon,
  PenLineIcon,
  ShieldCheckIcon,
  ShieldOffIcon,
} from "lucide-react";

export const runtimeModeConfig: Record<
  RuntimeMode,
  { label: string; description: string; icon: LucideIcon }
> = {
  "approval-required": {
    label: "需审批",
    description: "执行命令和修改文件前询问。",
    icon: LockIcon,
  },
  "auto-accept-edits": {
    label: "自动接受编辑",
    description: "自动批准编辑，其他操作前询问。",
    icon: PenLineIcon,
  },
  auto: {
    label: "自动",
    description: "支持此模式的提供方会自动批准常规操作，其他提供方仍会询问。",
    icon: ShieldCheckIcon,
  },
  "full-access": {
    label: "完全访问",
    description: "允许执行命令和编辑，无需确认。",
    // An open lock reads like a closed one at small sizes; a crossed shield does not.
    icon: ShieldOffIcon,
  },
};

export const runtimeModeOptions = Object.keys(runtimeModeConfig) as RuntimeMode[];

/** The modes a provider supports (all when it reports none) and the mode a thread really runs in. */
export function resolveCompatibleRuntimeMode(
  runtimeMode: RuntimeMode,
  supportedRuntimeModes: ReadonlyArray<RuntimeMode> | undefined,
) {
  const modes =
    supportedRuntimeModes && supportedRuntimeModes.length > 0
      ? runtimeModeOptions.filter((mode) => supportedRuntimeModes.includes(mode))
      : runtimeModeOptions;
  return { modes, mode: modes.includes(runtimeMode) ? runtimeMode : (modes[0] ?? runtimeMode) };
}

export function resolveRuntimeModeOptions(modes: ReadonlyArray<RuntimeMode>) {
  return modes.map((mode) => ({ mode, ...runtimeModeConfig[mode] }));
}

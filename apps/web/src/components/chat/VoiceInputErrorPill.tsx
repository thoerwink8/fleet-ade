import { MICROPHONE_PERMISSION_ERROR } from "@t3tools/client-runtime/voice-input";
import { useNavigate } from "@tanstack/react-router";
import { CircleAlertIcon, XIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { VoiceInputPill } from "./VoiceInputPill";

const VOICE_ERROR_LABELS: Record<string, string> = {
  [MICROPHONE_PERMISSION_ERROR]: "麦克风被拦截",
  "Microphone access is required for voice input.": "麦克风被拦截",
  "This draft is no longer available.": "草稿不可用",
  "Another voice recording is already active.": "已在录音",
  "Voice transcription is not available.": "语音输入不可用",
  "Voice transcription is still finishing. Try again shortly.": "仍在转写",
  "Voice transcription is not available for this language.": "不支持该语言",
  "Could not prepare voice transcription.": "无法开始",
  "Could not start voice recording.": "无法开始",
  "Voice recording was interrupted.": "录音被中断",
  "Could not finish voice recording.": "无法完成",
  "Could not transcribe this recording.": "转写失败",
  "Voice transcription on this environment failed.": "转写失败",
  "The draft changed while voice input was running. The transcript was not added.": "草稿已改动",
  "No speech was detected.": "没有听到语音",
  "Microphone processing failed.": "麦克风出错",
  "The microphone disconnected.": "麦克风已断开",
};

const RETRYABLE_TRANSCRIPTIONS = new Set(["无法转写这段录音。", "此环境上的语音转写失败。"]);

export function VoiceInputErrorPill(props: {
  error: string | null;
  errorAction: "retry" | "settings" | null;
  disabled?: boolean;
  cancelShortcutLabel?: string | null;
  size?: "default" | "compact" | undefined;
  onRetry(): void;
  onDismiss(): void;
}) {
  const navigate = useNavigate();
  const message = props.error ?? "语音输入失败";
  const openSettings = props.errorAction === "settings";
  const compact = props.size === "compact";
  const action = openSettings
    ? { label: "打开语音设置", text: "设置" }
    : props.error && RETRYABLE_TRANSCRIPTIONS.has(props.error)
      ? { label: "重试转写", text: "重试" }
      : { label: "重新录音", text: "重新录音" };
  return (
    <VoiceInputPill tone="error" size={props.size}>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              size={compact ? "icon-xs" : "icon-sm-pill"}
              variant="ghost"
              aria-label="关闭语音输入错误提示"
              onPointerDown={(event) => event.preventDefault()}
              onClick={props.onDismiss}
              className="shrink-0"
            >
              <XIcon />
            </Button>
          }
        />
        <TooltipPopup side="top">
          忽略
          {props.cancelShortcutLabel ? ` (${props.cancelShortcutLabel})` : ""}
        </TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              tabIndex={0}
              role="status"
              aria-label={message}
              className="flex min-w-0 items-center gap-1.5 rounded-sm text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            />
          }
        >
          <CircleAlertIcon aria-hidden className="size-3.5 shrink-0" />
          <span className="truncate">
            {(props.error && VOICE_ERROR_LABELS[props.error]) || "语音输入失败"}
          </span>
        </TooltipTrigger>
        <TooltipPopup side="top">{message}</TooltipPopup>
      </Tooltip>
      {props.errorAction ? (
        <Button
          type="button"
          size={compact ? "xs" : "sm-pill"}
          variant="outline"
          aria-label={action.label}
          disabled={props.disabled}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => {
            if (openSettings) {
              props.onDismiss();
              void navigate({ to: "/settings/voice" });
            } else {
              props.onRetry();
            }
          }}
          className="ms-auto shrink-0"
        >
          {action.text}
        </Button>
      ) : (
        <span aria-hidden className="w-1.5 shrink-0" />
      )}
    </VoiceInputPill>
  );
}

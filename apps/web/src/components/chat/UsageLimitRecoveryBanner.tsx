import {
  type OrchestrationV2LimitRecovery,
  type OrchestrationV2LimitRecoveryUpdate,
  type RunId,
} from "@t3tools/contracts";
import { type TimestampFormat } from "@t3tools/contracts/settings";
import { deadlineStore } from "@t3tools/client-runtime/clock";
import { limitRecoveryOwnsSnooze } from "@t3tools/client-runtime/state/thread-execution";
import {
  CHATGPT_USAGE_LIMIT_CODE,
  CHATGPT_WORKSPACE_USAGE_LIMIT_CODE,
} from "@t3tools/shared/usageLimits";
import { GaugeIcon } from "lucide-react";
import { useState } from "react";
import { useDeadlinePassed } from "../../hooks/useDeadline";
import { OpenAI } from "../Icons";
import { ChatGptUsageButton } from "../settings/ChatGptUsageButton";
import { InlineButton } from "../ui/button";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { toastManager } from "../ui/toast";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

type RecoveryProps = {
  runId: RunId;
  errorCode: string | null;
  resetAt: string | null;
  stoppedAt: string;
  settled: boolean;
  requestPending: boolean;
  snoozedUntil: string | null;
  recovery: OrchestrationV2LimitRecovery | null;
  timestampFormat: TimestampFormat;
  onChange: (recovery: OrchestrationV2LimitRecoveryUpdate) => Promise<void>;
};

export function usageLimitRecoveryBannerItem(props: RecoveryProps): ComposerBannerStackItem {
  const {
    runId,
    errorCode,
    resetAt,
    stoppedAt,
    settled,
    requestPending,
    recovery,
    snoozedUntil,
    timestampFormat,
  } = props;
  // The server refuses recovery changes while a request is pending.
  const canSchedule =
    !settled && !requestPending && resetAt !== null && Date.parse(resetAt) > Date.parse(stoppedAt);
  const resumes =
    canSchedule && recovery?.runId === runId && recovery.resetAt === resetAt && recovery.autoResume;
  const chatGptLimit =
    errorCode === CHATGPT_WORKSPACE_USAGE_LIMIT_CODE || errorCode === CHATGPT_USAGE_LIMIT_CODE;
  const recoveryActions = canSchedule ? (
    <RecoveryActions key={`${runId}:${resetAt}`} {...props} />
  ) : null;
  const displayAt =
    resumes && resetAt && snoozedUntil && Date.parse(snoozedUntil) > Date.parse(resetAt)
      ? snoozedUntil
      : resetAt;
  const when = displayAt ? formatUpcomingTimestamp(displayAt, timestampFormat) : "";
  const resetDescription = displayAt
    ? resumes
      ? `${when} 自动继续`
      : `${when} 重置`
    : "重置时间未知，请手动重试";
  if (!chatGptLimit) {
    return {
      id: `usage-limit-recovery:${runId}`,
      variant: "warning",
      group: "environment",
      icon: <GaugeIcon />,
      title: "已达到用量上限",
      description: resetDescription,
      actions: recoveryActions,
    };
  }
  // OpenAI's partner guidelines specify this ChatGPT notice and its actions.
  return {
    id: `usage-limit-recovery:${runId}`,
    variant: "warning",
    group: "environment",
    icon: <OpenAI aria-hidden="true" />,
    title: "已达到 ChatGPT 用量上限",
    description: resetDescription,
    actions: (
      <>
        {recoveryActions}
        <ChatGptUsageButton size="sm" variant="ghost" />
      </>
    ),
  };
}

export function getUsageLimitRecoveryButtonsState(input: {
  readonly pendingAction: "resume" | "snooze" | null;
  readonly scheduled: boolean;
  readonly snoozed: boolean;
  readonly resetPassed: boolean;
}) {
  const resumePending = input.pendingAction === "resume";
  const snoozePending = input.pendingAction === "snooze";
  return {
    resume: {
      disabled: resumePending,
      label: resumePending ? "正在保存…" : input.scheduled ? "取消自动继续" : "重置后自动继续",
    },
    snooze: {
      disabled: snoozePending || (!input.snoozed && input.resetPassed),
      label: snoozePending ? "正在保存…" : input.snoozed ? "立即唤醒" : "暂缓到重置时",
    },
  };
}

function RecoveryActions({ runId, resetAt, recovery, snoozedUntil, onChange }: RecoveryProps) {
  const [pendingResume, setPendingResume] = useState(false);
  const [pendingSnooze, setPendingSnooze] = useState(false);

  const scheduled =
    recovery?.runId === runId && recovery.resetAt === resetAt && recovery.autoResume;
  // The server leaves snoozedUntil in place after the timer wakes the thread,
  // so a snooze whose reset has passed is no longer active.
  const resetPassed = useDeadlinePassed(resetAt === null ? null : Date.parse(resetAt));
  const snoozed =
    limitRecoveryOwnsSnooze({ runId, resetAt, recovery, snoozedUntil }) && !resetPassed;
  async function toggle(action: "resume" | "snooze") {
    if (resetAt === null) return;
    if (action === "resume" ? pendingResume : pendingSnooze) return;
    if (action === "snooze" && !snoozed && Date.parse(resetAt) <= Date.now()) {
      toastManager.add({
        type: "error",
        title: "无法暂缓会话",
        description: "重置时间已过，请手动重试这个会话。",
      });
      // The deadline timer can lag after a throttled tab or sleep; disable now.
      deadlineStore(Date.parse(resetAt)).refresh();
      return;
    }
    const setActionPending = action === "resume" ? setPendingResume : setPendingSnooze;
    setActionPending(true);
    try {
      await onChange({
        runId,
        resetAt,
        ...(action === "resume" ? { autoResume: !scheduled } : { snooze: !snoozed }),
      });
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: action === "resume" ? "无法修改自动继续" : "无法暂缓会话",
        description: cause instanceof Error ? cause.message : "发生错误。",
      });
    } finally {
      setActionPending(false);
    }
  }
  const resumeState = getUsageLimitRecoveryButtonsState({
    pendingAction: pendingResume ? "resume" : null,
    scheduled,
    snoozed,
    resetPassed,
  }).resume;
  const snoozeState = getUsageLimitRecoveryButtonsState({
    pendingAction: pendingSnooze ? "snooze" : null,
    scheduled,
    snoozed,
    resetPassed,
  }).snooze;
  // Inline errors would widen the actions column and crush the title.
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1">
      <InlineButton
        touchTarget="padded"
        disabled={resumeState.disabled}
        onClick={() => void toggle("resume")}
      >
        {resumeState.label}
      </InlineButton>
      <InlineButton
        touchTarget="padded"
        disabled={snoozeState.disabled}
        onClick={() => void toggle("snooze")}
      >
        {snoozeState.label}
      </InlineButton>
    </span>
  );
}

import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { deriveThreadQueueWorkflowState } from "@t3tools/client-runtime/state/thread-workflows";
import { assistantCitationsToPlainText } from "@t3tools/shared/assistantCitations";
import {
  isAttachmentOnlyBootstrapPrompt,
  replaceComposerContextReferences,
} from "@t3tools/shared/composerContextReferences";
import type {
  ChatAttachment as ContractChatAttachment,
  EnvironmentId,
  MessageId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { resolveUserMessagePresentation } from "@t3tools/client-runtime/user-message";
import { Link } from "@tanstack/react-router";
import { ArrowUpIcon, ChevronDownIcon, Clock3Icon, PencilIcon } from "lucide-react";
import { useId, useImperativeHandle, useRef, useState, type ReactNode, type Ref } from "react";

import { useAssetUrls } from "../../assets/assetUrls";
import { threadEnvironment } from "../../state/threads";
import { useQuietThreadShell, useThreadProjection } from "../../state/entities";
import { useEnvironment } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { isImageAttachment, type ChatMessage } from "../../types";
import { useVisibleShortcutLabel } from "~/hooks/useKeyboardShortcutHints";
import { cn } from "~/lib/utils";
import { Button, InlineButton } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { useScheduledTaskTitle } from "./TimelineUserMessageRow";
import { queuedRunHeldLabel } from "./queuedRunHold.logic";
import type { WithdrawQueuedRunRequest } from "./queuedRunWithdraw";

export type { WithdrawQueuedRunRequest };

export interface EditQueuedRunRequest {
  readonly runId: RunId;
  readonly messageId: MessageId;
  readonly text: string;
  readonly attachments: ReadonlyArray<ContractChatAttachment>;
}

interface QueuedRowThumbnail {
  readonly key: string;
  readonly name: string;
  readonly url: string | null;
}

// A longer queue shows its first messages and a button that shows the rest.
const QUEUE_VISIBLE_ROWS = 3;

export interface QueuedRunsControlHandle {
  steerNext: (repeat: boolean) => boolean;
  editLatest: (repeat: boolean) => boolean;
}

type ThreadQueueProjection = Parameters<typeof deriveThreadQueueWorkflowState>[0];

function queuedImageResources(projection: ThreadQueueProjection | undefined) {
  if (!projection) return [];
  return deriveThreadQueueWorkflowState(projection).queuedRuns.flatMap(({ attachments }) =>
    attachments.flatMap((attachment) =>
      attachment.type === "image"
        ? [{ _tag: "attachment" as const, attachmentId: attachment.id }]
        : [],
    ),
  );
}

export function QueuedRunsControl({
  ref,
  ...props
}: {
  readonly ref?: Ref<QueuedRunsControlHandle>;
  readonly steerShortcutLabel?: string | null;
  readonly editShortcutLabel?: string | null;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly optimisticMessages: ReadonlyArray<
    Pick<ChatMessage, "id" | "inputIntent" | "text" | "attachments">
  >;
  readonly editingRunId: RunId | null;
  /** Set while something else holds the composer, such as an open question. */
  readonly editBlockedReason: string | null;
  readonly sendBlockedReason?: string | null;
  readonly onEditQueuedRun: (request: EditQueuedRunRequest) => void;
  readonly onCancelEdit: () => void;
  readonly onQueuedRunWithdrawn?: (
    request: WithdrawQueuedRunRequest,
    origin: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId },
  ) => void;
  readonly timestampFormat: TimestampFormat;
  readonly onOpenThread: (threadId: ThreadId, environmentId?: EnvironmentId) => void;
}) {
  const projection = useThreadProjection(
    scopeThreadRef(props.environmentId, props.threadId),
  )?.projection;
  const steerShortcutLabel = useVisibleShortcutLabel(props.steerShortcutLabel);
  const editShortcutLabel = useVisibleShortcutLabel(props.editShortcutLabel);
  const promote = useAtomCommand(threadEnvironment.promoteQueuedRun);
  const resume = useAtomCommand(threadEnvironment.resumeThreadQueue);
  const cancel = useAtomCommand(threadEnvironment.cancelQueuedRun);
  const [showAll, setShowAll] = useState(false);
  const queueListId = useId();
  const [busyRunId, setBusyRunId] = useState<RunId | null>(null);
  const steerInFlightRef = useRef(false);
  // Run-only acknowledgements can resurrect pending rows after cancellation or startup.
  const acknowledgedMessageIds = new Set((projection?.messages ?? []).map((message) => message.id));
  const queuedImageAttachmentResources = queuedImageResources(projection);
  const queuedImageAttachmentUrls = useAssetUrls(
    props.environmentId,
    queuedImageAttachmentResources,
  );
  const workflow = projection ? deriveThreadQueueWorkflowState(projection) : null;
  const queued = workflow?.queuedRuns ?? [];
  const activeRun = workflow?.activeRun ?? null;
  // A fresh message starts its own turn: it may skip compaction, but not steer into a turn.
  const canSendRun = (freshContext: boolean) =>
    workflow?.canSendNow === true ||
    (workflow?.canPromoteToSteer === true &&
      (!freshContext || workflow.promoteSkipsCompaction === true));
  const queuedImageUrlById = new Map(
    queuedImageAttachmentUrls.flatMap((url, index) => {
      const resource = queuedImageAttachmentResources[index];
      return url && resource ? [[resource.attachmentId, url] as const] : [];
    }),
  );
  const optimisticQueued = props.optimisticMessages.filter(
    (message) => message.inputIntent === "queued_turn" && !acknowledgedMessageIds.has(message.id),
  );
  const items = [
    ...queued.map(({ run, text, attachments, message, context }, serverIndex) => ({
      key: run.id,
      message,
      runId: run.id,
      messageId: run.userMessageId,
      freshContext: run.freshContext === true,
      heldLabel: queuedRunHeldLabel(run),
      serverIndex,
      text,
      context,
      editable: true,
      attachments,
      thumbnails: attachments
        .filter((attachment) => attachment.type === "image")
        .map<QueuedRowThumbnail>((attachment) => ({
          key: attachment.id,
          name: attachment.name,
          url: queuedImageUrlById.get(attachment.id) ?? null,
        })),
      pending: false,
    })),
    ...optimisticQueued.map((message) => ({
      key: message.id,
      message: undefined,
      runId: null,
      messageId: null,
      freshContext: false,
      heldLabel: null,
      serverIndex: null,
      text: message.text,
      context: undefined,
      editable: true,
      attachments: [] as ReadonlyArray<ContractChatAttachment>,
      thumbnails: (message.attachments ?? [])
        .filter(isImageAttachment)
        .map<QueuedRowThumbnail>((attachment) => ({
          key: attachment.id,
          name: attachment.name,
          url: attachment.previewUrl ?? null,
        })),
      pending: true,
    })),
  ];

  const sendQueuedMessage = async (queuedRunId: RunId) => {
    const freshContext = queued.some(
      ({ run }) => run.id === queuedRunId && run.freshContext === true,
    );
    if (!canSendRun(freshContext) || props.sendBlockedReason != null || steerInFlightRef.current) {
      return;
    }
    steerInFlightRef.current = true;
    setBusyRunId(queuedRunId);
    if (workflow?.canSendNow) {
      await resume({
        environmentId: props.environmentId,
        input: { threadId: props.threadId, runId: queuedRunId },
      });
    } else if (activeRun !== null) {
      await promote({
        environmentId: props.environmentId,
        input: { threadId: props.threadId, queuedRunId, targetRunId: activeRun.id },
      });
    }
    steerInFlightRef.current = false;
    setBusyRunId(null);
  };

  useImperativeHandle(ref, () => ({
    steerNext(repeat) {
      const next = queued[0];
      if (!next || !canSendRun(next.run.freshContext === true) || props.sendBlockedReason != null) {
        return false;
      }
      if (!repeat && busyRunId === null) void sendQueuedMessage(next.run.id);
      return true;
    },
    // Leave the key to caret navigation while editing.
    editLatest(repeat) {
      const latest = queued.at(-1);
      if (
        !latest ||
        props.editingRunId !== null ||
        props.editBlockedReason !== null ||
        busyRunId !== null
      ) {
        return false;
      }
      if (!repeat) {
        setShowAll(true);
        props.onEditQueuedRun({
          runId: latest.run.id,
          messageId: latest.run.userMessageId,
          text: latest.text,
          attachments: latest.attachments,
        });
      }
      return true;
    },
  }));

  if (items.length === 0) return null;

  const withdraw = async (item: (typeof items)[number]) => {
    if (item.runId === null) return;
    setBusyRunId(item.runId);
    const result = await cancel({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, runId: item.runId },
    });
    setBusyRunId(null);
    if (result._tag === "Success" && item.messageId !== null) {
      props.onQueuedRunWithdrawn?.(
        {
          runId: item.runId,
          messageId: item.messageId,
          text: item.text,
          attachments: item.attachments,
          ...(item.context ? { context: item.context } : {}),
        },
        // Captured from the render that started the withdraw: the user may have switched threads meanwhile.
        { environmentId: props.environmentId, threadId: props.threadId },
      );
    }
  };

  const collapsible = items.length > QUEUE_VISIBLE_ROWS;
  const visibleItems = collapsible && !showAll ? items.slice(0, QUEUE_VISIBLE_ROWS - 1) : items;

  return (
    <section
      aria-label={`${items.length} 条排队消息`}
      data-thread-queue="true"
      // Anchors the sr-only live region; unanchored, it escapes the timeline scroller and makes the chat column scroll.
      className="relative mx-auto flex w-full max-w-(--chat-content-max-width) flex-col gap-2 pb-4"
    >
      <span className="sr-only" aria-live="polite">
        {items.length} 条排队
      </span>
      <ol className="flex flex-col gap-2" id={queueListId}>
        {visibleItems.map((item, position) => {
          const previewText = isAttachmentOnlyBootstrapPrompt(item.text)
            ? ""
            : assistantCitationsToPlainText(
                replaceComposerContextReferences(item.text, (reference) => reference.label),
              ).trim();
          const isEditing = item.runId !== null && item.runId === props.editingRunId;
          return (
            <li
              key={item.key}
              aria-label={`排队消息 ${position + 1}/${items.length}，${item.heldLabel ?? "尚未发送"}`}
              aria-posinset={position + 1}
              aria-setsize={items.length}
              aria-current={isEditing ? "true" : undefined}
              className="group/queued w-full"
            >
              <QueuedMessage
                environmentId={props.environmentId}
                message={item.message}
                previewText={previewText}
                thumbnails={item.thumbnails}
                isEditing={isEditing}
                tag={position === 0 ? "下一条" : "排队"}
                heldLabel={isEditing ? null : item.heldLabel}
                onOpenThread={props.onOpenThread}
              >
                {canSendRun(item.freshContext) && !isEditing ? (
                  <>
                    <Tooltip>
                      <TooltipTrigger render={<span className="flex shrink-0" />}>
                        <Button
                          size="xs"
                          variant="muted"
                          disabled={
                            item.runId === null ||
                            busyRunId !== null ||
                            props.sendBlockedReason != null
                          }
                          onClick={() => {
                            if (item.runId !== null) {
                              void sendQueuedMessage(item.runId);
                            }
                          }}
                        >
                          <ArrowUpIcon />
                          立即发送
                        </Button>
                      </TooltipTrigger>
                      <TooltipPopup>
                        {props.sendBlockedReason ??
                          `${workflow?.canSendNow ? "用这条消息开始新一轮" : workflow?.promoteSkipsCompaction ? "跳过压缩并发送这条消息" : "发送到当前这一轮"}${item.serverIndex === 0 && steerShortcutLabel ? ` (${steerShortcutLabel})` : ""}`}
                      </TooltipPopup>
                    </Tooltip>
                  </>
                ) : null}
                {item.pending ? (
                  <span className="flex items-center gap-1 px-1">
                    <Clock3Icon aria-hidden className="size-3" />
                    正在保存
                  </span>
                ) : null}
                {isEditing ? (
                  <>
                    <span className="px-1 text-foreground">正在输入框中编辑</span>
                    <Button
                      size="xs"
                      variant="ghost"
                      aria-label="取消编辑排队消息"
                      onClick={props.onCancelEdit}
                    >
                      取消
                    </Button>
                  </>
                ) : (
                  <>
                    <Tooltip>
                      {/* The span keeps the tooltip, and its reason, on a disabled button. */}
                      <TooltipTrigger render={<span className="flex shrink-0" />}>
                        <Button
                          size="xs"
                          icon
                          variant="muted"
                          aria-label="编辑排队消息"
                          disabled={
                            item.runId === null ||
                            !item.editable ||
                            busyRunId !== null ||
                            props.editBlockedReason !== null
                          }
                          onClick={() => {
                            if (item.runId !== null && item.messageId !== null) {
                              props.onEditQueuedRun({
                                runId: item.runId,
                                messageId: item.messageId,
                                text: item.text,
                                attachments: item.attachments,
                              });
                            }
                          }}
                        >
                          <PencilIcon />
                        </Button>
                      </TooltipTrigger>
                      <TooltipPopup>
                        {props.editBlockedReason ??
                          `在输入框中编辑${item.serverIndex === queued.length - 1 && editShortcutLabel ? ` (${editShortcutLabel})` : ""}`}
                      </TooltipPopup>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            size="xs"
                            variant="muted"
                            aria-label="撤回排队消息"
                            disabled={item.runId === null || busyRunId !== null}
                            onClick={() => {
                              if (item.runId !== null) void withdraw(item);
                            }}
                          />
                        }
                      >
                        撤回
                      </TooltipTrigger>
                      <TooltipPopup>撤回排队消息，放回输入框或暂存</TooltipPopup>
                    </Tooltip>
                  </>
                )}
              </QueuedMessage>
            </li>
          );
        })}
      </ol>
      {collapsible ? (
        <div className="self-end pe-1 text-xs pointer-coarse:pt-4">
          <InlineButton
            tone="muted"
            touchTarget="expand"
            aria-expanded={showAll}
            aria-controls={queueListId}
            // Keep the composer focused; keyboard activation still works.
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => setShowAll((value) => !value)}
          >
            {showAll ? "收起" : `显示全部 ${items.length} 条排队消息`}
            <ChevronDownIcon
              aria-hidden
              className={cn(
                "size-3.5 transition-transform duration-150 motion-reduce:transition-none",
                showAll && "rotate-180",
              )}
            />
          </InlineButton>
        </div>
      ) : null}
    </section>
  );
}

type QueuedRunMessage = NonNullable<ThreadQueueProjection["messages"][number]>;

/**
 * One line above the composer: what goes in next, with its actions at the end. A message that
 * has not been sent is not a bubble yet, so the row stays quiet and flat.
 */
function QueuedMessage(props: {
  readonly environmentId: EnvironmentId;
  readonly message: QueuedRunMessage | undefined;
  readonly previewText: string;
  readonly thumbnails: ReadonlyArray<QueuedRowThumbnail>;
  readonly isEditing: boolean;
  readonly tag: string;
  /** Shown beside the actions when the message waits for the user instead of sending itself. */
  readonly heldLabel: string | null;
  readonly onOpenThread: (threadId: ThreadId, environmentId?: EnvironmentId) => void;
  readonly children: ReactNode;
}) {
  const presentation = props.message ? resolveUserMessagePresentation(props.message) : null;
  const attribution = presentation?.attribution ?? null;
  const scheduledTaskId = presentation?.scheduledTaskId;
  const senderThreadId = props.message?.senderThreadId;
  // A linked environment's agent sent it from a thread there.
  const senderRef =
    props.message?.linkedSender ??
    (senderThreadId === undefined ? null : scopeThreadRef(props.environmentId, senderThreadId));
  const taskTitle = useScheduledTaskTitle(props.environmentId, scheduledTaskId);
  const senderShell = useQuietThreadShell(attribution === "agent" ? senderRef : null);
  const linkedSenderEnvironment = useEnvironment(
    props.message?.linkedSender?.environmentId ?? null,
  );
  const firstLine = props.previewText.replace(/\s+/g, " ");
  const source =
    attribution === "automation"
      ? "自动化"
      : attribution === "agent"
        ? senderShell?.title.trim() || props.message?.linkedSender?.title.trim() || "智能体"
        : null;
  const summary = attribution === "automation" ? (taskTitle ?? firstLine) : firstLine;

  return (
    <div
      data-queued-strip
      className={cn(
        "flex min-h-9 w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 rounded-lg border bg-sidebar px-3 py-1.5 text-meta text-secondary-label",
        props.isEditing ? "border-primary/60" : "border-border",
      )}
    >
      {attribution === "t3code" ? <span className="shrink-0">由 Fleet ADE 发送 ·</span> : null}
      <span className="shrink-0 font-medium">{props.tag} ·</span>
      {props.thumbnails.map((thumbnail) => (
        <span
          key={thumbnail.key}
          className="size-5 shrink-0 overflow-hidden rounded-sm border border-border bg-background"
        >
          {thumbnail.url ? (
            <img src={thumbnail.url} alt={thumbnail.name} className="size-full object-cover" />
          ) : (
            <span aria-label={thumbnail.name} className="block size-full bg-muted/60" />
          )}
        </span>
      ))}
      {source ? <span className="shrink-0 text-muted-foreground">{source}</span> : null}
      <Tooltip>
        <TooltipTrigger render={<span className="min-w-0 flex-1 truncate text-foreground" />}>
          {summary}
        </TooltipTrigger>
        {props.previewText.length > summary.length ? (
          <TooltipPopup className="max-w-96 whitespace-pre-wrap">{props.previewText}</TooltipPopup>
        ) : null}
      </Tooltip>
      {props.heldLabel ? <span className="shrink-0">{props.heldLabel}</span> : null}
      <span className="ade-touch-row ade-touch-row--gap-5 flex shrink-0 items-center gap-0.5 pointer-coarse:gap-5">
        {attribution === "agent" &&
        senderRef &&
        // Only an environment this client is connected to can open the sender's thread there.
        (props.message?.linkedSender === undefined || linkedSenderEnvironment !== null) ? (
          <InlineButton
            tone="muted"
            touchTarget="expand"
            onClick={() => props.onOpenThread(senderRef.threadId, senderRef.environmentId)}
          >
            打开会话
          </InlineButton>
        ) : null}
        {scheduledTaskId ? (
          <InlineButton
            tone="muted"
            touchTarget="expand"
            render={
              <Link
                to="/settings/scheduled-tasks"
                search={{ environmentId: props.environmentId, taskId: scheduledTaskId }}
              />
            }
          >
            打开自动化
          </InlineButton>
        ) : null}
        {props.children}
      </span>
    </div>
  );
}

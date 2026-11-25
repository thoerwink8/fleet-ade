import { EnvironmentId, MessageId, RunId, ThreadId, TurnItemId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
  threadContextRecord,
} from "@t3tools/shared/composerContextReferences";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useComposerDraftStore } from "../../composerDraftStore";
import { removeLocalStorageItem } from "../../hooks/useLocalStorage";
import {
  attachmentContextRecord,
  environmentContextRecord,
  previewAnnotationContextRecord,
  responseContextRecord,
  reviewCommentContextRecord,
  terminalContextRecord,
  threadContextReference,
} from "../../lib/composerContextRecords";
import { formatInlineContextReference } from "../../lib/composerContextReferences";
import type { TerminalContextDraft } from "../../lib/terminalContext";
import {
  MAX_STASH_ENTRIES,
  PROMPT_STASH_STORAGE_KEY,
  usePromptStashStore,
  writePromptStashStorageForTest,
} from "../../promptStashStore";
import type { ReviewCommentContext } from "../../reviewCommentContext";
import { toastManager } from "../ui/toast";
import { resetAutoStashDedupeForTest } from "./composerAutoStash";
import { recoverWithdrawnQueuedRun } from "./queuedRunWithdraw";

const ENV = EnvironmentId.make("env-1");
const THREAD = ThreadId.make("thread-1");
const THREAD_REF = scopeThreadRef(ENV, THREAD);

describe("recoverWithdrawnQueuedRun", () => {
  beforeEach(() => {
    resetAutoStashDedupeForTest();
    useComposerDraftStore.setState({ draftsByThreadKey: {}, draftThreadsByThreadKey: {} });
    usePromptStashStore.setState({ entries: [], stashSeq: 0 });
    writePromptStashStorageForTest("");
    removeLocalStorageItem(PROMPT_STASH_STORAGE_KEY);
  });

  afterEach(() => {
    resetAutoStashDedupeForTest();
    vi.restoreAllMocks();
    useComposerDraftStore.setState({ draftsByThreadKey: {}, draftThreadsByThreadKey: {} });
    usePromptStashStore.setState({ entries: [], stashSeq: 0 });
    writePromptStashStorageForTest("");
    removeLocalStorageItem(PROMPT_STASH_STORAGE_KEY);
  });

  it("restores a withdrawn plain-text queued message into an empty composer", async () => {
    const addToast = vi.spyOn(toastManager, "add");
    const onRestoredToComposer = vi.fn();

    const result = await recoverWithdrawnQueuedRun({
      environmentId: ENV,
      threadId: THREAD,
      threadDraftTarget: THREAD_REF,
      isComposerOccupied: false,
      request: {
        runId: RunId.make("run-plain"),
        messageId: MessageId.make("msg-plain"),
        text: "queued follow-up",
        attachments: [],
      },
      onRestoredToComposer,
    });

    expect(result).toEqual({
      destination: "composer",
      failedAttachmentNames: [],
    });
    expect(useComposerDraftStore.getState().getComposerDraft(THREAD_REF)?.prompt).toBe(
      "queued follow-up",
    );
    expect(usePromptStashStore.getState().entries).toHaveLength(0);
    expect(onRestoredToComposer).toHaveBeenCalledOnce();
    expect(addToast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "info",
        title: "已撤回排队消息，已放回输入框",
      }),
    );
  });

  it("restores attachments, replyTo, and context records into an empty composer and strips bootstrap placeholder", async () => {
    const threadCtx = threadContextRecord(THREAD_REF, "Thread A");
    const envCtx = environmentContextRecord(ENV, "本机");
    const terminal: TerminalContextDraft = {
      id: "term-1",
      threadId: THREAD,
      createdAt: "2026-11-25T00:00:00.000Z",
      terminalId: "default",
      terminalLabel: "终端 1",
      lineStart: 1,
      lineEnd: 2,
      text: "out",
    };
    const review: ReviewCommentContext = {
      id: "rev-1",
      sectionId: "diff",
      sectionTitle: "Diff",
      filePath: "a.ts",
      startIndex: 1,
      endIndex: 1,
      rangeLabel: "+1",
      text: "note",
      diff: "+note",
    };
    const annotation = {
      id: "ann-1",
      pageUrl: "http://localhost:3000",
      pageTitle: "Preview",
      comment: "fix",
      elements: [],
      regions: [],
      strokes: [],
      styleChanges: [],
      screenshot: null,
      createdAt: "2026-11-25T00:00:00.000Z",
    };
    const replyTo = responseContextRecord({
      citation: {
        version: 1,
        environmentId: ENV,
        threadId: THREAD,
        messageId: MessageId.make("msg-prev"),
        text: "Answer",
        start: 0,
        end: 6,
        prefix: "",
        suffix: "",
      },
      itemId: TurnItemId.make("item-1"),
      subagents: [],
    });
    const imageFile = new File(["img"], "shot.png", { type: "image/png" });
    const docFile = new File(["doc"], "spec.md", { type: "text/markdown" });
    const imgAttachment = {
      type: "image" as const,
      id: "att-img" as never,
      name: "shot.png",
      mimeType: "image/png",
      sizeBytes: imageFile.size,
    };
    const docAttachment = {
      type: "file" as const,
      id: "att-doc" as never,
      name: "spec.md",
      mimeType: "text/markdown",
      sizeBytes: docFile.size,
    };
    const inlineText = `${formatInlineContextReference({ kind: "response", contextId: replyTo.contextId, label: replyTo.label })} check ${formatInlineContextReference(threadContextReference(threadCtx))} ${formatInlineContextReference({ kind: "file", contextId: "file_local-doc" as never, label: "spec.md" })}`;

    const result = await recoverWithdrawnQueuedRun(
      {
        environmentId: ENV,
        threadId: THREAD,
        threadDraftTarget: THREAD_REF,
        isComposerOccupied: false,
        request: {
          runId: RunId.make("run-rich"),
          messageId: MessageId.make("msg-rich"),
          text: inlineText,
          attachments: [imgAttachment, docAttachment],
          context: {
            version: 1,
            records: [
              replyTo,
              threadCtx,
              envCtx,
              terminalContextRecord(terminal),
              reviewCommentContextRecord(review),
              previewAnnotationContextRecord(annotation),
              attachmentContextRecord({
                attachment: {
                  type: "file",
                  id: "local-doc",
                  name: "spec.md",
                  mimeType: "text/markdown",
                  sizeBytes: docFile.size,
                  file: docFile,
                },
                attachmentId: "att-doc",
              }),
            ],
          },
        },
      },
      {
        downloadAttachment: async (attachment) =>
          attachment.id === "att-img" ? imageFile : docFile,
      },
    );

    expect(result.destination).toBe("composer");
    const draft = useComposerDraftStore.getState().getComposerDraft(THREAD_REF);
    expect(draft?.prompt).toContain("check");
    expect(draft?.prompt).not.toContain(replyTo.contextId);
    expect(draft?.replyTo).toEqual(replyTo);
    expect(draft?.images).toHaveLength(1);
    expect(draft?.images[0]?.name).toBe("shot.png");
    expect(draft?.files).toHaveLength(1);
    expect(draft?.files[0]?.id).toBe("local-doc");
    expect(draft?.files[0]?.file).toBe(docFile);
    expect(draft?.threadContexts).toEqual([threadCtx]);

    // Also verifies attachment-only queued message strips ATTACHMENT_ONLY_BOOTSTRAP_PROMPT.
    useComposerDraftStore.setState({ draftsByThreadKey: {}, draftThreadsByThreadKey: {} });
    await recoverWithdrawnQueuedRun(
      {
        environmentId: ENV,
        threadId: THREAD,
        threadDraftTarget: THREAD_REF,
        isComposerOccupied: false,
        request: {
          runId: RunId.make("run-attach-only"),
          messageId: MessageId.make("msg-attach-only"),
          text: ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
          attachments: [imgAttachment],
        },
      },
      { downloadAttachment: async () => imageFile },
    );
    expect(useComposerDraftStore.getState().getComposerDraft(THREAD_REF)?.prompt).toBe("");
    expect(useComposerDraftStore.getState().getComposerDraft(THREAD_REF)?.images).toHaveLength(1);
  });

  it("stashes the withdrawn message with attachments when the composer already has content or is occupied", async () => {
    useComposerDraftStore.getState().setPrompt(THREAD_REF, "typing another message");
    const imageFile = new File(["img"], "queued.png", { type: "image/png" });
    const docFile = new File(["pdf"], "plan.pdf", { type: "application/pdf" });
    const addToast = vi.spyOn(toastManager, "add").mockReturnValue("withdraw-stash-toast");
    const closeToast = vi.spyOn(toastManager, "close").mockImplementation(() => {});
    const onRestoreStashEntry = vi.fn();

    const result = await recoverWithdrawnQueuedRun(
      {
        environmentId: ENV,
        threadId: THREAD,
        threadDraftTarget: THREAD_REF,
        isComposerOccupied: false,
        request: {
          runId: RunId.make("run-stash"),
          messageId: MessageId.make("msg-stash"),
          text: "withdrawn prompt",
          attachments: [
            {
              type: "image",
              id: "att-q-img" as never,
              name: "queued.png",
              mimeType: "image/png",
              sizeBytes: imageFile.size,
            },
            {
              type: "file",
              id: "att-q-doc" as never,
              name: "plan.pdf",
              mimeType: "application/pdf",
              sizeBytes: docFile.size,
            },
          ],
        },
        onRestoreStashEntry,
      },
      {
        downloadAttachment: async (attachment) =>
          attachment.id === "att-q-img" ? imageFile : docFile,
        uploadFileForStash: async (file) => ({
          status: "ready",
          environmentId: ENV,
          attachmentId: `pending-${file.name}`,
        }),
        compressImage: async () => ({
          ok: true,
          image: {
            dataUrl: "data:image/webp;base64,DDDD",
            mimeType: "image/webp",
            sizeBytes: 4,
            recompressed: true,
          },
        }),
      },
    );

    expect(result.destination).toBe("stash");
    expect(useComposerDraftStore.getState().getComposerDraft(THREAD_REF)?.prompt).toBe(
      "typing another message",
    );
    const entries = usePromptStashStore.getState().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.prompt).toBe("withdrawn prompt");
    expect(entries[0]?.attachments).toHaveLength(1);
    expect(entries[0]?.files).toEqual([
      expect.objectContaining({
        name: "plan.pdf",
        attachmentId: "pending-plan.pdf",
      }),
    ]);

    expect(addToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "已撤回排队消息，已放进暂存",
        actionProps: expect.objectContaining({ children: "恢复" }),
      }),
    );
    const onClick = (
      addToast.mock.calls[0]?.[0] as { actionProps?: { onClick?: () => void } } | undefined
    )?.actionProps?.onClick;
    onClick?.();
    expect(closeToast).toHaveBeenCalledWith("withdraw-stash-toast");
    expect(onRestoreStashEntry).toHaveBeenCalledExactlyOnceWith(entries[0]!.id);

    // Occupied composer (e.g. editing another queued message) also routes to stash even with empty thread draft.
    useComposerDraftStore.setState({ draftsByThreadKey: {}, draftThreadsByThreadKey: {} });
    const occupied = await recoverWithdrawnQueuedRun({
      environmentId: ENV,
      threadId: THREAD,
      threadDraftTarget: THREAD_REF,
      isComposerOccupied: true,
      request: {
        runId: RunId.make("run-occupied"),
        messageId: MessageId.make("msg-occupied"),
        text: "while editing another",
        attachments: [],
      },
    });
    expect(occupied.destination).toBe("stash");
    expect(useComposerDraftStore.getState().getComposerDraft(THREAD_REF)).toBeNull();
    expect(usePromptStashStore.getState().entries).toHaveLength(2);
  });

  it("reports failed attachment downloads or uploads without losing the withdrawn text", async () => {
    const addToast = vi.spyOn(toastManager, "add");
    const result = await recoverWithdrawnQueuedRun(
      {
        environmentId: ENV,
        threadId: THREAD,
        threadDraftTarget: THREAD_REF,
        isComposerOccupied: false,
        request: {
          runId: RunId.make("run-partial"),
          messageId: MessageId.make("msg-partial"),
          text: "keep this text",
          attachments: [
            {
              type: "file",
              id: "att-missing" as never,
              name: "missing.zip",
              mimeType: "application/zip",
              sizeBytes: 99,
            },
          ],
        },
      },
      {
        downloadAttachment: async () => null,
      },
    );

    expect(result).toEqual({
      destination: "composer",
      failedAttachmentNames: ["missing.zip"],
    });
    expect(useComposerDraftStore.getState().getComposerDraft(THREAD_REF)?.prompt).toBe(
      "keep this text",
    );
    expect(addToast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "warning",
        title: "已撤回排队消息，已放回输入框",
      }),
    );
    expect(String(addToast.mock.calls[0]?.[0]?.description ?? "")).toContain("missing.zip");
  });

  it("stashes once per withdrawn runId and keeps distinct runIds with identical text", async () => {
    useComposerDraftStore.getState().setPrompt(THREAD_REF, "existing");
    const addToast = vi.spyOn(toastManager, "add");

    await recoverWithdrawnQueuedRun({
      environmentId: ENV,
      threadId: THREAD,
      threadDraftTarget: THREAD_REF,
      isComposerOccupied: false,
      request: {
        runId: RunId.make("run-dup"),
        messageId: MessageId.make("msg-1"),
        text: "identical queued text",
        attachments: [],
      },
    });
    const dup = await recoverWithdrawnQueuedRun({
      environmentId: ENV,
      threadId: THREAD,
      threadDraftTarget: THREAD_REF,
      isComposerOccupied: false,
      request: {
        runId: RunId.make("run-dup"),
        messageId: MessageId.make("msg-1"),
        text: "identical queued text",
        attachments: [],
      },
    });
    expect(dup.destination).toBe("duplicate");
    expect(usePromptStashStore.getState().entries).toHaveLength(1);
    expect(addToast).toHaveBeenCalledOnce();

    // Reverse test: a different runId with identical text stashes its own entry.
    await recoverWithdrawnQueuedRun({
      environmentId: ENV,
      threadId: THREAD,
      threadDraftTarget: THREAD_REF,
      isComposerOccupied: false,
      request: {
        runId: RunId.make("run-other"),
        messageId: MessageId.make("msg-2"),
        text: "identical queued text",
        attachments: [],
      },
    });
    expect(usePromptStashStore.getState().entries).toHaveLength(2);
  });

  it("keeps all entries when stashing a withdrawn message while the stash already has 20 entries", async () => {
    for (let index = 0; index < MAX_STASH_ENTRIES; index += 1) {
      usePromptStashStore.getState().stashEntry({
        id: `old-${index}`,
        createdAt: "2026-11-25T00:00:00.000Z",
        prompt: `old ${index}`,
        attachments: [],
        droppedImageNames: [],
      });
    }
    useComposerDraftStore.getState().setPrompt(THREAD_REF, "draft");
    const addToast = vi.spyOn(toastManager, "add");

    await recoverWithdrawnQueuedRun({
      environmentId: ENV,
      threadId: THREAD,
      threadDraftTarget: THREAD_REF,
      isComposerOccupied: false,
      request: {
        runId: RunId.make("run-overflow"),
        messageId: MessageId.make("msg-overflow"),
        text: "new withdrawn",
        attachments: [],
      },
    });

    expect(usePromptStashStore.getState().entries).toHaveLength(MAX_STASH_ENTRIES + 1);
    expect(String(addToast.mock.calls[0]?.[0]?.description ?? "")).toContain("20");
  });
});

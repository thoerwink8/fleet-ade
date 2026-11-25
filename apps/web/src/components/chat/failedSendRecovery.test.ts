import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { threadContextRecord } from "@t3tools/shared/composerContextReferences";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { removeLocalStorageItem } from "../../hooks/useLocalStorage";
import {
  environmentContextRecord,
  previewAnnotationContextRecord,
  responseContextRecord,
  reviewCommentContextRecord,
  terminalContextRecord,
} from "../../lib/composerContextRecords";
import type { TerminalContextDraft } from "../../lib/terminalContext";
import {
  MAX_STASH_ENTRIES,
  PROMPT_STASH_STORAGE_KEY,
  usePromptStashStore,
  writePromptStashStorageForTest,
} from "../../promptStashStore";
import type { ReviewCommentContext } from "../../reviewCommentContext";
import type { ComposerSendSnapshot } from "../ChatView.logic";
import { toastManager } from "../ui/toast";
import { resetAutoStashDedupeForTest } from "./composerAutoStash";
import { recoverFailedComposerSend } from "./failedSendRecovery";

const ENV = EnvironmentId.make("env-1");
const THREAD = ThreadId.make("thread-1");
const THREAD_REF = scopeThreadRef(ENV, THREAD);
const ROUTE_KEY = `${ENV}:${THREAD}`;

function makeImage(id = "img-1", name = "shot.png"): ComposerImageAttachment {
  const file = new File(["img"], name, { type: "image/png" });
  return {
    type: "image",
    id,
    name,
    mimeType: "image/png",
    sizeBytes: file.size,
    previewUrl: URL.createObjectURL(file),
    file,
  };
}

function makeFile(id = "file-1", name = "spec.pdf"): ComposerFileAttachment {
  const file = new File(["spec"], name, { type: "application/pdf" });
  return {
    type: "file",
    id,
    name,
    mimeType: "application/pdf",
    sizeBytes: file.size,
    file,
  };
}

function makeSnapshot(overrides: Partial<ComposerSendSnapshot> = {}): ComposerSendSnapshot {
  return {
    images: [],
    files: [],
    attachments: [],
    terminalContexts: [],
    previewAnnotations: [],
    reviewComments: [],
    threadContexts: [],
    environmentContexts: [],
    replyTo: null,
    messageText: "failed prompt",
    draftText: "failed prompt",
    ...overrides,
  };
}

describe("recoverFailedComposerSend", () => {
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

  it("restores the failed message back into an empty composer draft without stashing", async () => {
    const image = makeImage();
    const file = makeFile();
    const snapshot = makeSnapshot({
      images: [image],
      files: [file],
      attachments: [image, file],
      draftText: "retry me",
      messageText: "retry me",
    });
    const addToast = vi.spyOn(toastManager, "add");
    const onRestoredToComposer = vi.fn();

    const result = await recoverFailedComposerSend({
      environmentId: ENV,
      routeThreadKey: ROUTE_KEY,
      composerDraftTarget: THREAD_REF,
      messageId: MessageId.make("msg-empty"),
      sendSnapshot: snapshot,
      interrupted: false,
      onRestoredToComposer,
    });

    expect(result.outcome).toBe("restored-to-composer");
    expect(usePromptStashStore.getState().entries).toHaveLength(0);
    const draft = useComposerDraftStore.getState().getComposerDraft(THREAD_REF);
    expect(draft?.prompt).toBe("retry me");
    expect(draft?.images).toHaveLength(1);
    expect(draft?.files).toEqual([file]);
    expect(onRestoredToComposer).toHaveBeenCalledOnce();
    expect(addToast).not.toHaveBeenCalled();
  });

  it("stashes failed text, attachments, and contexts when a newer draft exists and offers a Restore action", async () => {
    useComposerDraftStore.getState().setPrompt(THREAD_REF, "newer draft");

    const image = makeImage("img-fail", "fail.png");
    const readyFile = makeFile("file-ready", "spec.pdf");
    const terminal: TerminalContextDraft = {
      id: "term-1",
      threadId: THREAD,
      createdAt: "2026-11-25T00:00:00.000Z",
      terminalId: "default",
      terminalLabel: "终端 1",
      lineStart: 1,
      lineEnd: 3,
      text: "exit 1",
    };
    const review: ReviewCommentContext = {
      id: "rev-1",
      sectionId: "diff",
      sectionTitle: "Diff",
      filePath: "src/app.ts",
      startIndex: 10,
      endIndex: 12,
      rangeLabel: "+10 to +12",
      text: "check null",
      diff: "+check",
    };
    const annotation = {
      id: "img-fail",
      pageUrl: "http://localhost:3000",
      pageTitle: "Preview",
      comment: "spacing",
      elements: [],
      regions: [],
      strokes: [],
      styleChanges: [],
      screenshot: null,
      createdAt: "2026-11-25T00:00:00.000Z",
    };
    const threadCtx = threadContextRecord(THREAD_REF, "Linked thread");
    const envCtx = environmentContextRecord(ENV, "本机");
    const replyTo = responseContextRecord({
      citation: {
        version: 1,
        environmentId: ENV,
        threadId: THREAD,
        messageId: MessageId.make("msg-prev"),
        text: "Previous answer",
        start: 0,
        end: 15,
        prefix: "",
        suffix: "",
      },
      subagents: [],
    });

    const snapshot = makeSnapshot({
      draftText: "failed with attachments",
      messageText: "failed with attachments",
      images: [image],
      files: [readyFile],
      attachments: [image, readyFile],
      terminalContexts: [terminal],
      previewAnnotations: [annotation],
      reviewComments: [review],
      threadContexts: [threadCtx],
      environmentContexts: [envCtx],
      replyTo,
    });

    const addToast = vi.spyOn(toastManager, "add").mockReturnValue("failed-toast-1");
    const closeToast = vi.spyOn(toastManager, "close").mockImplementation(() => {});
    const releaseUpload = vi.fn();
    const onRestoreStashEntry = vi.fn();

    const result = await recoverFailedComposerSend(
      {
        environmentId: ENV,
        routeThreadKey: ROUTE_KEY,
        composerDraftTarget: THREAD_REF,
        messageId: MessageId.make("msg-1"),
        sendSnapshot: snapshot,
        interrupted: false,
        onRestoreStashEntry,
      },
      {
        readUpload: (id) =>
          id === "file-ready"
            ? { status: "ready", environmentId: ENV, attachmentId: "pending-spec-pdf" }
            : undefined,
        compressImage: async () => ({
          ok: true,
          image: {
            dataUrl: "data:image/webp;base64,BBBB",
            mimeType: "image/webp",
            sizeBytes: 4,
            recompressed: true,
          },
        }),
        releaseUpload,
      },
    );

    expect(result.outcome).toBe("stashed");
    // Newer draft remains completely untouched.
    expect(useComposerDraftStore.getState().getComposerDraft(THREAD_REF)?.prompt).toBe(
      "newer draft",
    );

    // Failed message is in the stash with compressed image, uploaded file, and contexts.
    const stashed = usePromptStashStore.getState().entries;
    expect(stashed).toHaveLength(1);
    expect(stashed[0]?.prompt).toBe("failed with attachments");
    expect(stashed[0]?.attachments).toHaveLength(1);
    expect(stashed[0]?.files).toEqual([
      expect.objectContaining({
        id: "file-ready",
        attachmentId: "pending-spec-pdf",
      }),
    ]);
    expect(stashed[0]?.records).toEqual(
      expect.arrayContaining([
        replyTo,
        threadCtx,
        envCtx,
        terminalContextRecord(terminal),
        reviewCommentContextRecord(review),
        previewAnnotationContextRecord(annotation, { screenshotContextId: "img-fail" }),
      ]),
    );

    // Images release their pending upload (stored as dataUrl), while stashed files stay alive.
    expect(releaseUpload).toHaveBeenCalledExactlyOnceWith("img-fail");

    expect(addToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "消息没发出去，已放进暂存",
        actionProps: expect.objectContaining({ children: "恢复" }),
      }),
    );
    const description = String(addToast.mock.calls[0]?.[0]?.description ?? "");
    expect(description).toContain("暂存");
    expect(description).toContain("恢复");
    expect(description).not.toContain("复制");

    const restoreClick = (
      addToast.mock.calls[0]?.[0] as { actionProps?: { onClick?: () => void } } | undefined
    )?.actionProps?.onClick;
    restoreClick?.();
    expect(closeToast).toHaveBeenCalledWith("failed-toast-1");
    expect(onRestoreStashEntry).toHaveBeenCalledExactlyOnceWith(stashed[0]!.id);
  });

  it("stashes attachment-only failed sends and reports any unuploaded file names", async () => {
    useComposerDraftStore.getState().setPrompt(THREAD_REF, "newer draft");
    const image = makeImage("img-only", "only.png");
    const unuploaded = makeFile("file-unuploaded", "big.zip");
    const snapshot = makeSnapshot({
      draftText: "",
      messageText: "",
      images: [image],
      files: [unuploaded],
      attachments: [image, unuploaded],
    });
    const addToast = vi.spyOn(toastManager, "add").mockReturnValue("toast-attach");

    const result = await recoverFailedComposerSend(
      {
        environmentId: ENV,
        routeThreadKey: ROUTE_KEY,
        composerDraftTarget: THREAD_REF,
        messageId: MessageId.make("msg-attach-only"),
        sendSnapshot: snapshot,
        interrupted: true,
      },
      {
        readUpload: () => undefined,
        compressImage: async () => ({
          ok: true,
          image: {
            dataUrl: "data:image/webp;base64,CCCC",
            mimeType: "image/webp",
            sizeBytes: 4,
            recompressed: true,
          },
        }),
        releaseUpload: vi.fn(),
      },
    );

    expect(result.outcome).toBe("stashed");
    expect(usePromptStashStore.getState().entries).toHaveLength(1);
    expect(addToast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "warning",
        title: "消息可能没发出去，已放进暂存",
      }),
    );
    expect(String(addToast.mock.calls[0]?.[0]?.description ?? "")).toContain("big.zip");
  });

  it("stashes once per failed messageId and never swallows distinct sends with identical text", async () => {
    useComposerDraftStore.getState().setPrompt(THREAD_REF, "newer draft");
    const addToast = vi.spyOn(toastManager, "add").mockReturnValue("toast-dedupe");
    const snapshot = makeSnapshot({
      draftText: "same failed text",
      messageText: "same failed text",
    });

    const first = await recoverFailedComposerSend({
      environmentId: ENV,
      routeThreadKey: ROUTE_KEY,
      composerDraftTarget: THREAD_REF,
      messageId: MessageId.make("msg-dup"),
      sendSnapshot: snapshot,
      interrupted: false,
    });
    const second = await recoverFailedComposerSend({
      environmentId: ENV,
      routeThreadKey: ROUTE_KEY,
      composerDraftTarget: THREAD_REF,
      messageId: MessageId.make("msg-dup"),
      sendSnapshot: snapshot,
      interrupted: false,
    });

    expect(first.outcome).toBe("stashed");
    expect(second.outcome).toBe("duplicate");
    expect(usePromptStashStore.getState().entries).toHaveLength(1);
    expect(addToast).toHaveBeenCalledOnce();

    // Reverse test: a different messageId with identical text creates its own stash entry.
    const third = await recoverFailedComposerSend({
      environmentId: ENV,
      routeThreadKey: ROUTE_KEY,
      composerDraftTarget: THREAD_REF,
      messageId: MessageId.make("msg-distinct"),
      sendSnapshot: snapshot,
      interrupted: false,
    });
    expect(third.outcome).toBe("stashed");
    expect(usePromptStashStore.getState().entries).toHaveLength(2);
  });

  it("keeps existing entries when stash is full and warns in the notice", async () => {
    for (let index = 0; index < MAX_STASH_ENTRIES; index += 1) {
      usePromptStashStore.getState().stashEntry({
        id: `existing-${index}`,
        createdAt: "2026-11-25T00:00:00.000Z",
        prompt: `old ${index}`,
        attachments: [],
        droppedImageNames: [],
      });
    }
    useComposerDraftStore.getState().setPrompt(THREAD_REF, "newer draft");
    const addToast = vi.spyOn(toastManager, "add").mockReturnValue("toast-full");

    await recoverFailedComposerSend({
      environmentId: ENV,
      routeThreadKey: ROUTE_KEY,
      composerDraftTarget: THREAD_REF,
      messageId: MessageId.make("msg-overflow"),
      sendSnapshot: makeSnapshot({ draftText: "keep me", messageText: "keep me" }),
      interrupted: false,
    });

    expect(usePromptStashStore.getState().entries).toHaveLength(MAX_STASH_ENTRIES + 1);
    expect(usePromptStashStore.getState().entries.at(-1)?.id).toBe("existing-0");
    expect(String(addToast.mock.calls[0]?.[0]?.description ?? "")).toContain("20");
  });
});

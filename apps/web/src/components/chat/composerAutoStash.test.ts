import { EnvironmentId, MessageId, ThreadId, TurnItemId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { threadContextRecord } from "@t3tools/shared/composerContextReferences";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ComposerFileAttachment, ComposerImageAttachment } from "../../composerDraftStore";
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
import {
  autoStashDraftContent,
  formatAutoStashNoticeDescription,
  resetAutoStashDedupeForTest,
} from "./composerAutoStash";

const ENV = EnvironmentId.make("env-1");
const THREAD = ThreadId.make("thread-1");

function makeImage(id = "img-1", name = "shot.png"): ComposerImageAttachment {
  return {
    type: "image",
    id,
    name,
    mimeType: "image/png",
    sizeBytes: 5,
    previewUrl: `blob:${id}`,
    file: new File(["image"], name, { type: "image/png" }),
  };
}

function makeFile(
  id = "file-1",
  name = "notes.txt",
  uploadedAttachmentId?: string,
): ComposerFileAttachment {
  return {
    type: "file",
    id,
    name,
    mimeType: "text/plain",
    sizeBytes: 4,
    file: new File(["body"], name, { type: "text/plain" }),
    ...(uploadedAttachmentId ? { uploadedAttachmentId, uploadEnvironmentId: ENV } : {}),
  };
}

describe("composerAutoStash", () => {
  beforeEach(() => {
    resetAutoStashDedupeForTest();
    usePromptStashStore.setState({ entries: [], stashSeq: 0 });
    writePromptStashStorageForTest("");
    removeLocalStorageItem(PROMPT_STASH_STORAGE_KEY);
  });

  afterEach(() => {
    resetAutoStashDedupeForTest();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    usePromptStashStore.setState({ entries: [], stashSeq: 0 });
    writePromptStashStorageForTest("");
    removeLocalStorageItem(PROMPT_STASH_STORAGE_KEY);
  });

  it("stashes text, compressed images, uploaded files, and all context records", async () => {
    const terminal: TerminalContextDraft = {
      id: "term-1",
      threadId: THREAD,
      createdAt: "2026-11-25T00:00:00.000Z",
      terminalId: "default",
      terminalLabel: "终端 1",
      lineStart: 1,
      lineEnd: 2,
      text: "err",
    };
    const review: ReviewCommentContext = {
      id: "rev-1",
      sectionId: "diff",
      sectionTitle: "Diff",
      filePath: "a.ts",
      startIndex: 1,
      endIndex: 1,
      rangeLabel: "+1",
      text: "fix",
      diff: "+fix",
    };
    const annotation = {
      id: "img-1",
      pageUrl: "http://localhost:3000",
      pageTitle: "App",
      comment: "align button",
      elements: [],
      regions: [],
      strokes: [],
      styleChanges: [],
      screenshot: null,
      createdAt: "2026-11-25T00:00:00.000Z",
    };
    const threadCtx = threadContextRecord(scopeThreadRef(ENV, THREAD), "Other thread");
    const envCtx = environmentContextRecord(ENV, "本机");
    const replyTo = responseContextRecord({
      citation: {
        version: 1,
        environmentId: ENV,
        threadId: THREAD,
        messageId: MessageId.make("msg-1"),
        text: "Earlier answer",
        start: 0,
        end: 14,
        prefix: "",
        suffix: "",
      },
      itemId: TurnItemId.make("item-1"),
      subagents: [],
    });

    const result = await autoStashDraftContent(
      {
        dedupeKey: "test:all",
        environmentId: ENV,
        prompt: "keep everything",
        images: [makeImage("img-1", "shot.png")],
        files: [makeFile("file-1", "ready.txt"), makeFile("file-2", "pending.txt")],
        terminalContexts: [terminal],
        previewAnnotations: [annotation],
        reviewComments: [review],
        threadContexts: [threadCtx],
        environmentContexts: [envCtx],
        replyTo,
      },
      {
        readUpload: (id) =>
          id === "file-1"
            ? { status: "ready", environmentId: ENV, attachmentId: "pending-ready-id" }
            : undefined,
        compressImage: async () => ({
          ok: true,
          image: {
            dataUrl: "data:image/webp;base64,AAAA",
            mimeType: "image/webp",
            sizeBytes: 4,
            recompressed: true,
          },
        }),
      },
    );

    expect(result).toEqual({
      status: "stashed",
      entryId: expect.any(String),
      overflowed: false,
      durable: false,
      unsavedFileNames: ["pending.txt"],
      droppedImageNames: [],
      unreadableImageNames: [],
    });

    const entry = usePromptStashStore.getState().entries[0];
    expect(entry?.prompt).toBe("keep everything");
    expect(entry?.attachments).toHaveLength(1);
    expect(entry?.attachments[0]?.dataUrl).toBe("data:image/webp;base64,AAAA");
    expect(entry?.files).toEqual([
      expect.objectContaining({
        id: "file-1",
        name: "ready.txt",
        attachmentId: "pending-ready-id",
        environmentId: ENV,
      }),
    ]);
    expect(entry?.records).toEqual(
      expect.arrayContaining([
        replyTo,
        threadCtx,
        envCtx,
        terminalContextRecord(terminal),
        reviewCommentContextRecord(review),
        previewAnnotationContextRecord(annotation, { screenshotContextId: "img-1" }),
      ]),
    );
  });

  it("reports unsaved-attachments-only when there is no text, image, reply, or uploaded file", async () => {
    const result = await autoStashDraftContent(
      {
        dedupeKey: "test:unsaved-only",
        environmentId: ENV,
        prompt: "   ",
        images: [],
        files: [makeFile("file-1", "local-only.pdf")],
      },
      { readUpload: () => undefined },
    );

    expect(result).toEqual({
      status: "unsaved-attachments-only",
      unsavedFileNames: ["local-only.pdf"],
    });
    expect(usePromptStashStore.getState().entries).toHaveLength(0);
  });

  it("deduplicates repeated calls with the same dedupeKey and keeps distinct keys with identical text", async () => {
    const [first, second] = await Promise.all([
      autoStashDraftContent({
        dedupeKey: "same-op-1",
        environmentId: ENV,
        prompt: "same text",
        images: [],
        files: [],
      }),
      autoStashDraftContent({
        dedupeKey: "same-op-1",
        environmentId: ENV,
        prompt: "same text",
        images: [],
        files: [],
      }),
    ]);
    expect(first.status).toBe("stashed");
    expect(second).toEqual({ status: "duplicate" });
    expect(usePromptStashStore.getState().entries).toHaveLength(1);

    // Distinct operation keys with identical content must NEVER be swallowed.
    const third = await autoStashDraftContent({
      dedupeKey: "same-op-2",
      environmentId: ENV,
      prompt: "same text",
      images: [],
      files: [],
    });
    expect(third.status).toBe("stashed");
    expect(usePromptStashStore.getState().entries).toHaveLength(2);
  });

  it("does not evict existing stash entries when the stash already holds 20 entries", async () => {
    const store = usePromptStashStore.getState();
    for (let index = 0; index < MAX_STASH_ENTRIES; index += 1) {
      store.stashEntry({
        id: `old-${index}`,
        createdAt: "2026-11-25T00:00:00.000Z",
        prompt: `old ${index}`,
        attachments: [],
        droppedImageNames: [],
      });
    }

    const result = await autoStashDraftContent({
      dedupeKey: "overflow-op",
      environmentId: ENV,
      prompt: "important failed prompt",
      images: [],
      files: [],
    });

    expect(result).toMatchObject({ status: "stashed", overflowed: true });
    expect(usePromptStashStore.getState().entries).toHaveLength(MAX_STASH_ENTRIES + 1);
    expect(usePromptStashStore.getState().entries.at(-1)?.id).toBe("old-0");
  });

  it("formats concise Chinese descriptions covering location, recovery, and partial-save warnings", () => {
    const text = formatAutoStashNoticeDescription({
      prefix: "新草稿已保留；点「恢复」或打开输入框上方的「暂存」即可取回。",
      unsavedFileNames: ["a.zip"],
      droppedImageNames: ["huge.png"],
      unreadableImageNames: ["bad.png"],
      overflowed: true,
      durable: false,
    });
    expect(text).toContain("暂存");
    expect(text).toContain("恢复");
    expect(text).toContain("a.zip");
    expect(text).toContain("huge.png");
    expect(text).toContain("bad.png");
    expect(text).toContain("20");
    expect(text).toContain("刷新");
  });
});

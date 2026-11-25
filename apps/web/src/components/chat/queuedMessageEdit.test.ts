import { EnvironmentId, RunId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { threadContextRecord } from "@t3tools/shared/composerContextReferences";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  DraftId,
  useComposerDraftStore,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
} from "../../composerDraftStore";
import { removeLocalStorageItem } from "../../hooks/useLocalStorage";
import {
  MAX_STASH_ENTRIES,
  PROMPT_STASH_STORAGE_KEY,
  usePromptStashStore,
  writePromptStashStorageForTest,
} from "../../promptStashStore";
import { resetAutoStashDedupeForTest } from "./composerAutoStash";
import { prepareQueuedEditAttachments, recoverQueuedMessageEdit } from "./queuedMessageEdit";

const environmentId = EnvironmentId.make("remote-environment");
const threadTarget = scopeThreadRef(environmentId, ThreadId.make("thread:edit"));
const editTarget = DraftId.make("queued-edit:test");
const file: ComposerFileAttachment = {
  type: "file",
  id: "file:report",
  name: "report.pdf",
  mimeType: "application/pdf",
  sizeBytes: 6,
  file: new File(["report"], "report.pdf", { type: "application/pdf" }),
};
const image: ComposerImageAttachment = {
  type: "image",
  id: "image:screen",
  name: "screen.png",
  mimeType: "image/png",
  sizeBytes: 5,
  file: new File(["image"], "screen.png", { type: "image/png" }),
  previewUrl: "blob:screen",
};
const uploadedFile = {
  type: "file" as const,
  id: "upload:report",
  name: file.name,
  mimeType: file.mimeType,
  sizeBytes: file.sizeBytes,
};

describe("queued message file edits", () => {
  beforeEach(() => {
    resetAutoStashDedupeForTest();
    useComposerDraftStore.setState({ draftsByThreadKey: {}, draftThreadsByThreadKey: {} });
    usePromptStashStore.setState({ entries: [], stashSeq: 0 });
    writePromptStashStorageForTest("");
    removeLocalStorageItem(PROMPT_STASH_STORAGE_KEY);
  });

  afterEach(() => {
    resetAutoStashDedupeForTest();
    useComposerDraftStore.setState({ draftsByThreadKey: {}, draftThreadsByThreadKey: {} });
    usePromptStashStore.setState({ entries: [], stashSeq: 0 });
    writePromptStashStorageForTest("");
    removeLocalStorageItem(PROMPT_STASH_STORAGE_KEY);
  });

  it.each([
    { images: [], label: "file-only" },
    { images: [image], label: "mixed" },
  ])("preserves a generic file in a $label save", async ({ images }) => {
    const attachments = await prepareQueuedEditAttachments({
      existingAttachments: [],
      images,
      files: [file],
      uploadFiles: async () => [uploadedFile],
      readImage: async () => "data:image/png;base64,aW1hZ2U=",
    });
    expect(attachments.at(-1)).toEqual(uploadedFile);
    expect(attachments.length).toBe(images.length + 1);
    if (images.length > 0)
      expect(attachments[0]).toMatchObject({
        type: "image",
        dataUrl: "data:image/png;base64,aW1hZ2U=",
      });
  });

  it("fails a save instead of dropping a file whose upload is missing", async () => {
    await expect(
      prepareQueuedEditAttachments({
        existingAttachments: [],
        images: [image],
        files: [file],
        uploadFiles: async () => [],
        readImage: async () => "image",
      }),
    ).rejects.toThrow("保存前请重试或移除上传失败的附件。");
  });

  it("stashes file-only edits instead of touching an empty thread draft when the queued run leaves", async () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(editTarget, "Original message");
    store.addFiles(editTarget, [file]);

    const result = await recoverQueuedMessageEdit(
      {
        environmentId,
        editTarget,
        dedupeKey: `edit:${RunId.make("run-file")}`,
        originalText: "Original message",
      },
      {
        uploadFileForStash: async (targetFile) => ({
          status: "ready",
          environmentId,
          attachmentId: `pending-${targetFile.id}`,
        }),
      },
    );

    expect(result).toMatchObject({ outcome: "stashed" });
    expect(store.getComposerDraft(threadTarget)).toBeNull();
    expect(store.getComposerDraft(editTarget)).toBeNull();
    const stashed = usePromptStashStore.getState().entries;
    expect(stashed).toHaveLength(1);
    expect(stashed[0]?.prompt).toBe("Original message");
    expect(stashed[0]?.files).toEqual([
      expect.objectContaining({
        id: file.id,
        attachmentId: `pending-${file.id}`,
      }),
    ]);
  });

  it("removes the edit draft and preserves its thread mention in the stash when displaced", async () => {
    const store = useComposerDraftStore.getState();
    const otherThread = threadContextRecord(
      scopeThreadRef(environmentId, ThreadId.make("thread:other")),
      "Other",
    );
    store.setPrompt(editTarget, "Edited message");
    store.setThreadContexts(editTarget, [otherThread]);

    const result = await recoverQueuedMessageEdit({
      environmentId,
      editTarget,
      dedupeKey: `edit:${RunId.make("run-mention")}`,
      originalText: "Original message",
    });

    expect(result).toMatchObject({ outcome: "stashed" });
    expect(store.getComposerDraft(editTarget)).toBeNull();
    const stashed = usePromptStashStore.getState().entries;
    expect(stashed).toHaveLength(1);
    expect(stashed[0]?.records).toEqual([otherThread]);
  });

  it("stashes text when a queued attachment was removed, and returns clean if cleared completely", async () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(editTarget, "Original message");
    const withText = await recoverQueuedMessageEdit({
      environmentId,
      editTarget,
      dedupeKey: `edit:${RunId.make("run-removed-att-1")}`,
      originalText: "Original message",
      removedExistingAttachment: true,
    });
    expect(withText).toMatchObject({ outcome: "stashed" });
    expect(usePromptStashStore.getState().entries[0]?.prompt).toBe("Original message");
    expect(store.getComposerDraft(threadTarget)).toBeNull();

    // An attachment-only edit cleared completely has nothing left to stash.
    const cleared = await recoverQueuedMessageEdit({
      environmentId,
      editTarget,
      dedupeKey: `edit:${RunId.make("run-removed-att-2")}`,
      originalText: "",
      removedExistingAttachment: true,
    });
    expect(cleared).toEqual({ outcome: "clean" });
    expect(store.getComposerDraft(threadTarget)).toBeNull();
  });

  it("stashes a displaced edit into prompt stash without overwriting an existing thread draft", async () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(threadTarget, "Separate draft");
    store.addFiles(editTarget, [file]);
    store.addImages(editTarget, [image]);

    const result = await recoverQueuedMessageEdit(
      {
        environmentId,
        editTarget,
        dedupeKey: `edit:${RunId.make("run-nonempty-draft")}`,
        originalText: "",
      },
      {
        uploadFileForStash: async (targetFile) => ({
          status: "ready",
          environmentId,
          attachmentId: `pending-${targetFile.id}`,
        }),
        compressImage: async () => ({
          ok: true,
          image: {
            dataUrl: "data:image/webp;base64,EEEE",
            mimeType: "image/webp",
            sizeBytes: 4,
            recompressed: true,
          },
        }),
      },
    );

    expect(result).toMatchObject({ outcome: "stashed" });
    expect(store.getComposerDraft(threadTarget)?.prompt).toBe("Separate draft");
    expect(store.getComposerDraft(editTarget)).toBeNull();
    const stashed = usePromptStashStore.getState().entries;
    expect(stashed).toHaveLength(1);
    expect(stashed[0]?.attachments).toHaveLength(1);
    expect(stashed[0]?.files).toHaveLength(1);
  });

  it("stashes once per displaced edit key and keeps existing entries when full", async () => {
    for (let index = 0; index < MAX_STASH_ENTRIES; index += 1) {
      usePromptStashStore.getState().stashEntry({
        id: `old-${index}`,
        createdAt: "2026-11-25T00:00:00.000Z",
        prompt: `old ${index}`,
        attachments: [],
        droppedImageNames: [],
      });
    }
    const store = useComposerDraftStore.getState();
    store.setPrompt(editTarget, "edited text");
    const first = await recoverQueuedMessageEdit({
      environmentId,
      editTarget,
      dedupeKey: `edit:${RunId.make("run-same")}`,
      originalText: "orig",
    });
    store.setPrompt(editTarget, "edited text");
    const dup = await recoverQueuedMessageEdit({
      environmentId,
      editTarget,
      dedupeKey: `edit:${RunId.make("run-same")}`,
      originalText: "orig",
    });

    expect(first).toMatchObject({ outcome: "stashed", overflowed: true });
    expect(dup).toEqual({ outcome: "duplicate" });
    expect(usePromptStashStore.getState().entries).toHaveLength(MAX_STASH_ENTRIES + 1);
  });
});

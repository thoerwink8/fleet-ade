import { describe, expect, it } from "vite-plus/test";
import { stashWaitReason, waitForStashReadiness } from "./composerStashReadiness.logic";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}

describe("stashWaitReason", () => {
  it("returns null when nothing is busy", () => {
    expect(
      stashWaitReason({
        preparingImages: false,
        loadingContext: false,
        uploadingFiles: false,
      }),
    ).toBeNull();
  });

  it("prioritizes image compression, context loading, then file upload", () => {
    expect(
      stashWaitReason({
        preparingImages: true,
        loadingContext: true,
        uploadingFiles: true,
      }),
    ).toBe("等待图片压缩完成后自动暂存");
    expect(
      stashWaitReason({
        preparingImages: false,
        loadingContext: true,
        uploadingFiles: true,
      }),
    ).toBe("等待上下文加载完成后自动暂存");
    expect(
      stashWaitReason({
        preparingImages: false,
        loadingContext: false,
        uploadingFiles: true,
      }),
    ).toBe("等待文件上传完成后自动暂存");
  });
});

describe("waitForStashReadiness", () => {
  it("resolves immediately when nothing is waiting", async () => {
    const ready = await waitForStashReadiness({
      isLoadingContext: () => false,
      waitForContextIdle: async () => true,
      isPreparingImages: () => false,
      waitForImagesIdle: async () => true,
      readUploadingFileIds: () => [],
      waitForFileUploads: async () => undefined,
    });
    expect(ready).toBe(true);
  });

  it("waits across chained context, image compression and subsequent file uploads", async () => {
    let loadingContext = true;
    let preparingImages = true;
    let uploadingIds: string[] = [];
    const contextIdle = deferred<boolean>();
    const imagesIdle = deferred<boolean>();
    const filesUploaded = deferred<void>();
    const uploadWaitStarted = deferred<void>();
    let waitedUploadIds: ReadonlyArray<string> = [];

    const waitPromise = waitForStashReadiness({
      isLoadingContext: () => loadingContext,
      waitForContextIdle: () => contextIdle.promise,
      isPreparingImages: () => preparingImages,
      waitForImagesIdle: () => imagesIdle.promise,
      readUploadingFileIds: () => uploadingIds,
      waitForFileUploads: (ids) => {
        waitedUploadIds = ids;
        uploadWaitStarted.resolve();
        return filesUploaded.promise;
      },
    });

    // Context finishes first and yields a file whose upload begins.
    loadingContext = false;
    uploadingIds = ["file-1"];
    contextIdle.resolve(true);

    // Image compression finishes next; upload is still running.
    preparingImages = false;
    imagesIdle.resolve(true);

    await uploadWaitStarted.promise;
    expect(waitedUploadIds).toEqual(["file-1"]);

    uploadingIds = [];
    filesUploaded.resolve();
    await expect(waitPromise).resolves.toBe(true);
  });

  it("resolves false immediately when aborted mid-wait", async () => {
    const controller = new AbortController();
    const neverSettled = new Promise<boolean>(() => undefined);

    const waitPromise = waitForStashReadiness({
      isLoadingContext: () => true,
      waitForContextIdle: () => neverSettled,
      isPreparingImages: () => false,
      waitForImagesIdle: async () => true,
      readUploadingFileIds: () => [],
      waitForFileUploads: async () => undefined,
      signal: controller.signal,
    });

    controller.abort();
    await expect(waitPromise).resolves.toBe(false);
  });
});

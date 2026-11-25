export function stashWaitReason(input: {
  readonly preparingImages: boolean;
  readonly loadingContext: boolean;
  readonly uploadingFiles: boolean;
}): string | null {
  if (input.preparingImages) return "等待图片压缩完成后自动暂存";
  if (input.loadingContext) return "等待上下文加载完成后自动暂存";
  if (input.uploadingFiles) return "等待文件上传完成后自动暂存";
  return null;
}

function awaitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<boolean> {
  if (!signal) {
    return promise.then(() => true);
  }
  if (signal.aborted) {
    return Promise.resolve(false);
  }
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      resolve(false);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      () => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(!signal.aborted);
      },
      () => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(!signal.aborted);
      },
    );
  });
}

export async function waitForStashReadiness(input: {
  readonly isLoadingContext: () => boolean;
  readonly waitForContextIdle: (signal?: AbortSignal) => Promise<boolean>;
  readonly isPreparingImages: () => boolean;
  readonly waitForImagesIdle: (signal?: AbortSignal) => Promise<boolean>;
  readonly readUploadingFileIds: () => ReadonlyArray<string>;
  readonly waitForFileUploads: (ids: ReadonlyArray<string>) => Promise<void>;
  readonly signal?: AbortSignal | undefined;
}): Promise<boolean> {
  const { signal } = input;
  for (;;) {
    if (signal?.aborted) {
      return false;
    }
    const waits: Promise<unknown>[] = [];
    if (input.isLoadingContext()) {
      waits.push(input.waitForContextIdle(signal));
    }
    if (input.isPreparingImages()) {
      waits.push(input.waitForImagesIdle(signal));
    }
    const uploadingIds = input.readUploadingFileIds();
    if (uploadingIds.length > 0) {
      waits.push(input.waitForFileUploads(uploadingIds));
    }
    if (waits.length === 0) {
      return true;
    }
    const continued = await awaitWithAbort(Promise.all(waits), signal);
    if (!continued) {
      return false;
    }
  }
}

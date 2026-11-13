import { BINARY_PREVIEW_MAX_BYTES } from "./binaryPreviewProtocol";

export async function readBinaryPreview(src: string, signal: AbortSignal) {
  const response = await fetch(src, { signal });
  if (!response.ok) throw new Error("无法加载文件。请关闭后重试。");
  if (Number(response.headers.get("content-length")) > BINARY_PREVIEW_MAX_BYTES)
    throw new Error("预览仅支持小于 50 MB 的文件。");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("文件不可用。");
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > BINARY_PREVIEW_MAX_BYTES) throw new Error("预览仅支持小于 50 MB 的文件。");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return new Blob(chunks).arrayBuffer();
}

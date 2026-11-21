import * as Electron from "electron";

const MAX_IMAGE_BYTES = 32 * 1024 * 1024;

interface ImageDimensions {
  readonly width: number;
  readonly height: number;
}

function sourceDimensions(buffer: Buffer): ImageDimensions | null {
  if (
    buffer.byteLength >= 24 &&
    buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.byteLength >= 10 && /^GIF8[79]a$/u.test(buffer.subarray(0, 6).toString("ascii"))) {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }
  if (
    buffer.byteLength >= 30 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    const kind = buffer.subarray(12, 16).toString("ascii");
    if (kind === "VP8X") {
      return { width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) };
    }
    if (kind === "VP8 " && buffer.subarray(23, 26).equals(Buffer.from([0x9d, 0x01, 0x2a]))) {
      return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
    }
    if (kind === "VP8L" && buffer[20] === 0x2f) {
      return {
        width: 1 + buffer[21]! + ((buffer[22]! & 0x3f) << 8),
        height: 1 + (buffer[22]! >> 6) + (buffer[23]! << 2) + ((buffer[24]! & 0x0f) << 10),
      };
    }
  }
  if (buffer.byteLength >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 8 < buffer.byteLength) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1]!;
      if (
        [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
          marker,
        )
      ) {
        return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
      }
      if (marker === 0xd9 || marker === 0xda) break;
      const length = buffer.readUInt16BE(offset + 2);
      if (length < 2) break;
      offset += length + 2;
    }
  }
  return null;
}

export async function copyContextMenuImage(
  contents: Electron.WebContents,
  params: Electron.ContextMenuParams,
): Promise<void> {
  const frame = params.frame;
  if (contents.isDestroyed() || !frame || frame.isDestroyed()) return;
  if (frame === contents.mainFrame) {
    contents.copyImageAt(params.x, params.y);
    return;
  }

  const url = new URL(params.srcURL);
  if (
    !["https:", "http:", "data:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    (url.protocol === "data:" && params.srcURL.length > MAX_IMAGE_BYTES * 3)
  ) {
    throw new Error("Unsupported image URL");
  }
  const fetchImage = url.protocol === "data:" ? globalThis.fetch : Electron.net.fetch;
  const response = await fetchImage(url.href, {
    credentials: "omit",
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok || Number(response.headers.get("content-length")) > MAX_IMAGE_BYTES) {
    await response.body?.cancel();
    throw new Error("Image request failed or exceeded the size limit");
  }
  if (!response.body) throw new Error("Image response has no body");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      byteLength += chunk.value.byteLength;
      if (byteLength > MAX_IMAGE_BYTES) {
        await reader.cancel();
        throw new Error("Image exceeded the size limit");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = Buffer.concat(chunks, byteLength);
  const dimensions = sourceDimensions(bytes);
  if (
    !dimensions ||
    dimensions.width <= 0 ||
    dimensions.height <= 0 ||
    dimensions.width * dimensions.height > MAX_IMAGE_BYTES / 4
  ) {
    throw new Error("Image dimensions exceed the size limit");
  }
  if (contents.isDestroyed() || frame.isDestroyed()) return;
  const image = Electron.nativeImage.createFromBuffer(bytes);
  let png: Buffer;
  if (image.isEmpty()) {
    const decoded: unknown = await contents.executeJavaScriptInIsolatedWorld(1002, [
      {
        code: `(async () => {
          const source = Uint8Array.from(atob("${bytes.toString("base64")}"), char => char.charCodeAt(0));
          const bitmap = await createImageBitmap(new Blob([source]));
          try {
            if (bitmap.width <= 0 || bitmap.height <= 0 || bitmap.width * bitmap.height > ${MAX_IMAGE_BYTES / 4}) {
              throw new Error("Image dimensions exceed the size limit");
            }
            const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
            const context = canvas.getContext("2d");
            if (!context) throw new Error("Image could not be decoded");
            context.drawImage(bitmap, 0, 0);
            const output = await canvas.convertToBlob({ type: "image/png" });
            if (output.size > ${MAX_IMAGE_BYTES}) throw new Error("PNG exceeded the size limit");
            return await output.arrayBuffer();
          } finally {
            bitmap.close();
          }
        })()`,
      },
    ]);
    if (!(decoded instanceof ArrayBuffer)) throw new Error("Image could not be decoded");
    png = Buffer.from(decoded);
  } else {
    png = image.toPNG();
  }
  if (png.byteLength > MAX_IMAGE_BYTES) throw new Error("PNG exceeded the size limit");
  if (contents.isDestroyed() || frame.isDestroyed()) return;
  await Electron.clipboard.write([
    new Electron.ClipboardItem({
      "image/png": new Blob([Uint8Array.from(png)], { type: "image/png" }),
    }),
  ]);
}

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { ChatAttachment, PROVIDER_SEND_TURN_MAX_FILE_BYTES } from "./chatAttachment.ts";

const decodeAttachment = Schema.decodeUnknownEffect(ChatAttachment);

it.effect("tolerates attachment types from newer builds", () =>
  Effect.gen(function* () {
    const attachment = yield* decodeAttachment({
      type: "somethingnew",
      id: "thread-1-00000000-0000-4000-8000-000000000003-glb",
      name: "scene.glb",
      mimeType: "model/gltf-binary",
      sizeBytes: 12,
    });
    assert.strictEqual(attachment.type, "somethingnew");
  }),
);

it.effect("rejects malformed known attachment types instead of tolerating them", () =>
  Effect.gen(function* () {
    const base = {
      id: "thread-1-00000000-0000-4000-8000-000000000003-pdf",
      name: "report.pdf",
      mimeType: "application/pdf",
    };
    const oversizedFile = yield* Effect.exit(
      decodeAttachment({ ...base, type: "file", sizeBytes: PROVIDER_SEND_TURN_MAX_FILE_BYTES + 1 }),
    );
    assert.strictEqual(Exit.isFailure(oversizedFile), true);
    const badMimeImage = yield* Effect.exit(
      decodeAttachment({ ...base, type: "image", mimeType: "application/pdf", sizeBytes: 12 }),
    );
    assert.strictEqual(Exit.isFailure(badMimeImage), true);
  }),
);

it.effect("reads an image saved with captured-window data as a plain image", () =>
  Effect.gen(function* () {
    const attachment = yield* decodeAttachment({
      type: "image",
      id: "thread-1-00000000-0000-4000-8000-000000000004-png",
      name: "window.png",
      mimeType: "image/png",
      sizeBytes: 12,
      source: {
        kind: "snap-shot",
        capturedAt: "2026-08-24T11:00:00.000Z",
        appName: "Editor",
        windowTitle: "main.ts",
        accessibility: { format: "flat-text", text: "Saved text", truncated: false },
      },
    });
    assert.deepStrictEqual(attachment, {
      type: "image",
      id: "thread-1-00000000-0000-4000-8000-000000000004-png",
      name: "window.png",
      mimeType: "image/png",
      sizeBytes: 12,
    });
  }),
);

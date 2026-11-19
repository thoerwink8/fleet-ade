import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { OrchestrationV2Command } from "./orchestrationV2.ts";
import { ThreadGuestShare } from "./guestShare.ts";

// Threads and shells persisted while guest links existed carry this state; decoding
// must keep working after the feature is gone.
describe("ThreadGuestShare", () => {
  it("decodes a share stored before guest links were removed", () => {
    const decode = Schema.decodeSync(ThreadGuestShare);
    expect(
      decode({
        id: "share:one",
        host: "machine.tailnet.ts.net",
        createdAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2026-01-02T00:00:00.000Z",
        guestName: "Sam",
        messages: [
          {
            id: "guest-message:one",
            text: "Why not keep the old cache?",
            status: "pending",
            submittedAt: "2026-01-01T00:00:01.000Z",
            attachments: [
              {
                id: "attachment-one",
                type: "file",
                name: "notes.txt",
                sizeBytes: 3,
                mimeType: "text/plain",
              },
            ],
          },
        ],
      }).messages[0]?.status,
    ).toBe("pending");
  });
});

describe("retired guest commands", () => {
  it("rejects guest share commands and a client-supplied guest message id", () => {
    const decode = Schema.decodeUnknownSync(OrchestrationV2Command);
    for (const command of [
      { type: "thread.guest-share.close", commandId: "cmd-close", threadId: "thread-1" },
      {
        type: "thread.guest-message.dismiss",
        commandId: "cmd-dismiss",
        threadId: "thread-1",
        guestMessageId: "guest-message:one",
      },
      {
        type: "thread.guest-share.open",
        commandId: "cmd-open",
        threadId: "thread-1",
        shareId: "share:one",
        host: "machine.tailnet.ts.net",
        expiresAt: "2026-01-02T00:00:00.000Z",
      },
      {
        type: "thread.guest-share.redeem",
        commandId: "cmd-redeem",
        threadId: "thread-1",
        shareId: "share:one",
        guestName: "Sam",
      },
      {
        type: "thread.guest-message.submit",
        commandId: "cmd-submit",
        threadId: "thread-1",
        shareId: "share:one",
        guestMessageId: "guest-message:one",
        text: "hello",
      },
    ]) {
      expect(() => decode(command)).toThrow();
    }
    const sent = decode({
      type: "message.dispatch",
      commandId: "cmd-send",
      threadId: "thread-1",
      messageId: "message-1",
      createdBy: "user",
      creationSource: "web",
      text: "hi",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      guestMessageId: "guest-message:one",
    });
    expect(sent).not.toHaveProperty("guestMessageId");
  });
});

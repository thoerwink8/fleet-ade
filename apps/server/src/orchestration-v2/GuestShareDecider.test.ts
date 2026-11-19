import { assert, it } from "@effect/vitest";
import {
  GuestMessageId,
  GuestShareId,
  type OrchestrationV2AppThread,
  type ThreadGuestShare,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { guestShareAfterCancelledSend, releasedGuestAttachmentIds } from "./GuestShareDecider.ts";

const sentId = GuestMessageId.make("guest-message:sent");
const waitingId = GuestMessageId.make("guest-message:wait");
const shareId = GuestShareId.make("share:one");

const share: ThreadGuestShare = {
  id: shareId,
  host: "machine.tailnet.ts.net",
  createdAt: "2026-01-01T00:00:00.000Z",
  expiresAt: "2026-01-02T00:00:00.000Z",
  guestName: "Sam",
  messages: [
    {
      id: sentId,
      text: "sent",
      status: "sent",
      submittedAt: "2026-01-01T00:00:01.000Z",
      attachments: [
        { id: "file-sent", type: "file", name: "a.txt", sizeBytes: 1, mimeType: "text/plain" },
      ],
    },
    {
      id: waitingId,
      text: "wait",
      status: "pending",
      submittedAt: "2026-01-01T00:00:02.000Z",
      attachments: [
        {
          id: "file-pending",
          type: "file",
          name: "b.txt",
          sizeBytes: 1,
          mimeType: "text/plain",
        },
      ],
    },
  ],
};

it.effect("dismisses a cancelled guest send and releases only waiting files", () =>
  Effect.sync(() => {
    const thread = { guestShare: share } as OrchestrationV2AppThread;
    const now = DateTime.makeUnsafe("2026-01-03T00:00:00.000Z");
    const cancelled = guestShareAfterCancelledSend(
      thread,
      { guestMessageId: sentId, shareId },
      now,
    );
    assert.equal(cancelled.guestShare?.messages[0]?.status, "dismissed");
    assert.equal(cancelled.guestShare?.messages[1]?.status, "pending");
    assert.equal(
      guestShareAfterCancelledSend(
        thread,
        { guestMessageId: sentId, shareId: GuestShareId.make("share:other") },
        now,
      ),
      thread,
    );
    assert.deepEqual(releasedGuestAttachmentIds(share, null), ["file-pending"]);
    assert.deepEqual(releasedGuestAttachmentIds(share, cancelled.guestShare ?? null), []);
  }),
);

import "~/index.css";

import { expect, it } from "vite-plus/test";
import { act, render } from "../../../test/render";
import { PendingSendWaitingBar } from "./PendingSendWaitingBar";
import {
  armPendingComposerSend,
  cancelPendingComposerSend,
  dismissPendingSendCancelNotice,
  getPendingComposerSend,
  getPendingSendCancelNotice,
} from "./pendingComposerSend.logic";

const TARGET = "env-1:thread-a";

it("cancels the armed send without leaving a 'cancelled for you' notice when the user clicks Cancel", async () => {
  using _cleanup = {
    [Symbol.dispose]() {
      cancelPendingComposerSend(TARGET);
      dismissPendingSendCancelNotice(TARGET);
    },
  };
  armPendingComposerSend({
    targetKey: TARGET,
    dispatchMode: "auto",
    submissionIntent: "foreground",
    submissionTarget: "provider-turn",
    waitedForPreviousSend: false,
    baseline: { imageFailureSeq: 0, contextFailureSeq: 0, previousSendFailureSeq: 0 },
  });
  await using screen = await render(
    <PendingSendWaitingBar
      id="pending-send"
      targetKey={TARGET}
      reason="正在压缩图片，好了自动发送"
    />,
  );

  const cancel = screen.getByRole("button", { name: "取消" }).element() as HTMLButtonElement;
  await act(() => cancel.click());

  expect(getPendingComposerSend(TARGET)).toBeNull();
  expect(getPendingSendCancelNotice(TARGET)).toBeNull();
});

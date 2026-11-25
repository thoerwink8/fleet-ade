import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_TAKEOVER_DRAFT,
  questionTakeoverNotice,
  takeoverDraftSnapshot,
} from "./questionTakeoverNotice.logic";

const NOTICE = "你写的消息先收起来了，回答后会回到输入框";

describe("questionTakeoverNotice", () => {
  it.each([
    [
      "draft hidden behind the answer",
      { draftText: "还没发的话", questionOwnsComposer: true },
      NOTICE,
    ],
    ["empty draft", { draftText: "", questionOwnsComposer: true }, null],
    ["blank draft", { draftText: "   \n", questionOwnsComposer: true }, null],
    [
      "question does not use the composer",
      { draftText: "还没发的话", questionOwnsComposer: false },
      null,
    ],
  ])("%s", (_label, input, expected) => {
    expect(questionTakeoverNotice(input)).toBe(expected);
  });
});

describe("takeoverDraftSnapshot", () => {
  it("keeps the draft from the render the question arrived", () => {
    const first = takeoverDraftSnapshot(EMPTY_TAKEOVER_DRAFT, "req-1", "还没发的话");
    const afterCarry = takeoverDraftSnapshot(first, "req-1", "还没发的话\n\n写在回答里的");
    expect(afterCarry.draft).toBe("还没发的话");
  });

  it("drops the snapshot when the question no longer owns the composer", () => {
    const first = takeoverDraftSnapshot(EMPTY_TAKEOVER_DRAFT, "req-1", "还没发的话");
    expect(takeoverDraftSnapshot(first, "", "还没发的话")).toEqual(EMPTY_TAKEOVER_DRAFT);
  });

  it("captures again for the next question", () => {
    const first = takeoverDraftSnapshot(EMPTY_TAKEOVER_DRAFT, "req-1", "第一段");
    const released = takeoverDraftSnapshot(first, "", "第一段");
    expect(takeoverDraftSnapshot(released, "req-2", "第二段").draft).toBe("第二段");
  });
});

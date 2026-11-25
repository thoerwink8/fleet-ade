export interface TakeoverDraftSnapshot {
  readonly requestId: string;
  readonly draft: string;
}

export const EMPTY_TAKEOVER_DRAFT: TakeoverDraftSnapshot = { requestId: "", draft: "" };

/**
 * The draft from the render a question first took the composer. A later edit
 * of that draft, including an answer carried back into it, is not the hidden
 * message.
 */
export function takeoverDraftSnapshot(
  previous: TakeoverDraftSnapshot,
  requestId: string,
  prompt: string,
): TakeoverDraftSnapshot {
  if (requestId.length === 0) return EMPTY_TAKEOVER_DRAFT;
  if (previous.requestId === requestId) return previous;
  return { requestId, draft: prompt };
}

const QUESTION_TAKEOVER_NOTICE = "你写的消息先收起来了，回答后会回到输入框";

/**
 * The line above a question that has taken over the composer, when the draft
 * the user was writing is hidden behind the answer. Nothing to say when the
 * draft was empty, or when the question does not use the composer.
 */
export function questionTakeoverNotice(input: {
  readonly draftText: string;
  readonly questionOwnsComposer: boolean;
}): string | null {
  return input.questionOwnsComposer && input.draftText.trim().length > 0
    ? QUESTION_TAKEOVER_NOTICE
    : null;
}

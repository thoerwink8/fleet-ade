import type { ProviderAuthState } from "@t3tools/contracts";

export const TERMINAL_UNAVAILABLE_MESSAGE = "智能体登录终端已不可用。";

/**
 * Message for a terminal input that the server rejected, or null when it should stay silent.
 * Once the login command has ended (success, failure, cancel) the server drops the flow and
 * rejects late input; the flow's own outcome is already shown, so that is not a second error.
 */
export function terminalSendFailureMessage(input: {
  readonly interrupted: boolean;
  readonly sent: { readonly flowId: string; readonly interactionId: string };
  readonly latest: Pick<ProviderAuthState, "flowId" | "phase" | "interaction"> | null | undefined;
}): string | null {
  if (input.interrupted) return null;
  const { latest, sent } = input;
  const stillOnThisTerminal =
    latest?.phase === "waiting" &&
    latest.flowId === sent.flowId &&
    latest.interaction?.type === "terminal" &&
    latest.interaction.id === sent.interactionId;
  if (!stillOnThisTerminal) return null;
  return TERMINAL_UNAVAILABLE_MESSAGE;
}

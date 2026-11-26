export function resetSentComposerPrompt(input: {
  readonly currentRouteThreadKey: string | null;
  readonly sentRouteThreadKey: string;
  readonly clearPrompt: () => void;
  readonly resetCursor: () => void;
}) {
  if (input.currentRouteThreadKey !== input.sentRouteThreadKey) return;
  input.clearPrompt();
  input.resetCursor();
}

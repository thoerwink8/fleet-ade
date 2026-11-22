/**
 * Fires on every window focus and every switch to a visible tab: focus coming back from an
 * iframe, or an alt-tab whose blur was missed, still counts as a return.
 */
export function subscribeDocumentReturn(listener: () => void): () => void {
  if (typeof document === "undefined") return () => {};
  const handleVisibilityChange = () => {
    if (document.visibilityState === "visible") listener();
  };
  window.addEventListener("focus", listener);
  document.addEventListener("visibilitychange", handleVisibilityChange);
  return () => {
    window.removeEventListener("focus", listener);
    document.removeEventListener("visibilitychange", handleVisibilityChange);
  };
}

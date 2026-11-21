import { useStableCallback } from "~/hooks/useStableCallback";
import { readLocalApi } from "~/localApi";

/** Rejects if the system-browser handoff fails. */
export function useOpenLink(): (url: string) => Promise<void> {
  return useStableCallback(async (url: string) => {
    const api = readLocalApi();
    if (!api) throw new Error("无法打开链接。");
    await api.shell.openExternal(url);
  });
}

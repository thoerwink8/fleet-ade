import { readLocalApi } from "~/localApi";
import { useStableCallback } from "~/hooks/useStableCallback";
export function useOpenLink(_threadRef?: unknown) {
  return useStableCallback(async (url: string): Promise<void> => {
    const localApi = readLocalApi();
    if (localApi) {
      await localApi.shell.openExternal(url);
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
  });
}

import { useCallback } from "react";
import { readLocalApi } from "~/localApi";

export function useOpenLink(_threadRef?: unknown) {
  return useCallback(async (url: string): Promise<void> => {
    const localApi = readLocalApi();
    if (localApi) {
      await localApi.shell.openExternal(url);
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
  }, []);
}

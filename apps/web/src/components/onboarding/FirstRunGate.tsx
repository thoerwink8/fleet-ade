import { RefreshIcon } from "~/components/ui/refresh-icon";
import {
  useClientSettingsHydrationStatus,
  ensureClientSettingsHydrated,
} from "../../hooks/useSettings";
import { Button } from "../ui/button";

export function FirstRunGate({ children }: { readonly children: React.ReactNode }) {
  const hydrationStatus = useClientSettingsHydrationStatus();
  if (hydrationStatus === "failed" || hydrationStatus === "retrying") {
    return <FirstRunRecovery retrying={hydrationStatus === "retrying"} />;
  }
  if (hydrationStatus !== "ready") return null;
  return children;
}

function FirstRunRecovery({ retrying = false }: { readonly retrying?: boolean }) {
  return (
    <main className="flex h-dvh min-h-0 items-center justify-center bg-background px-6 text-foreground">
      <div className="flex max-w-sm flex-col items-center text-center">
        <h1 className="text-lg font-medium">无法读取设置</h1>
        <p className="mt-2 text-sm text-muted-foreground">无法加载你保存的设置。</p>
        <Button
          className="mt-5"
          size="sm"
          variant="secondary"
          disabled={retrying}
          onClick={() => {
            void ensureClientSettingsHydrated().catch(() => undefined);
          }}
        >
          <RefreshIcon refreshing={retrying} />
          重试
        </Button>
      </div>
    </main>
  );
}

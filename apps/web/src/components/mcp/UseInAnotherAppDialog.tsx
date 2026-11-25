import { useAtomValue } from "@effect/atom-react";
import { environmentMcpUrl } from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { usePreparedConnection } from "~/state/session";
import { useAccessEnvironment } from "../settings/useAccessEnvironment";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { WizardHeader, WizardPanel, WizardPopup } from "../ui/wizard";

const requestAtom = Atom.make<{ readonly environmentId: EnvironmentId | null } | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("mcp:use-in-another-app"),
);

/** Opens the wizard for `environmentId`, or for the one Sharing & access picks when null. */
export function openUseInAnotherApp(environmentId: EnvironmentId | null): void {
  appAtomRegistry.set(requestAtom, { environmentId });
}

const close = () => appAtomRegistry.set(requestAtom, null);

/** Hosted once at the root, so Cmd-K and Settings can open it from anywhere. */
export function UseInAnotherAppDialogHost() {
  const request = useAtomValue(requestAtom);
  return request === null ? null : <UseInAnotherAppDialog requested={request.environmentId} />;
}

function UseInAnotherAppDialog({ requested }: { readonly requested: EnvironmentId | null }) {
  const { environment, label } = useAccessEnvironment(requested);
  const title = `在其他应用中使用 Fleet ADE（MCP）· ${label ?? "Fleet ADE"}`;
  const prepared = usePreparedConnection(environment?.environmentId ?? null);
  const connected = environment?.connection.phase === "connected" && prepared._tag === "Some";
  const mcpUrl =
    environment === null
      ? null
      : environmentMcpUrl({
          entry: environment.entry,
          ...(connected ? { connectedTarget: prepared.value.target } : {}),
        });
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : close())}>
      <WizardPopup>
        <WizardHeader title={title} />
        <WizardPanel>
          {environment === null ? (
            <p className="text-sm text-muted-foreground">请先连接一台电脑。</p>
          ) : mcpUrl === null ? (
            <p className="text-sm text-muted-foreground">
              请先连接 {environment.label}。连接后，这里会给出它的 MCP 地址。
            </p>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                把这个地址交给要接入 MCP 的应用，它需要能访问这个地址。地址指向当前连接的{" "}
                {environment.label}。
              </p>
              <p className="break-all font-mono text-xs">{mcpUrl}</p>
              <Button
                variant="outline"
                size="sm"
                disabled={!connected}
                onClick={() => copyToClipboard(mcpUrl)}
              >
                {isCopied ? "已复制" : "复制 MCP 地址"}
              </Button>
            </div>
          )}
        </WizardPanel>
      </WizardPopup>
    </Dialog>
  );
}

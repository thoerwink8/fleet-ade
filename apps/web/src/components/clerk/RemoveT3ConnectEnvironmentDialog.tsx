import { Discovery } from "@t3tools/client-runtime/relay";
import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";

import { useRelayEnvironmentDiscovery } from "../../state/environments";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button, InlineButton } from "../ui/button";
import { useT3ConnectAccountPage } from "./T3ConnectAccountPages";

export function RemoveT3ConnectEnvironmentDialog({
  environmentLabel,
  environmentId,
  onCancel,
  onConfirm,
}: {
  readonly environmentLabel: string | null;
  readonly environmentId: EnvironmentId | null;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  const accountPage = useT3ConnectAccountPage();
  const discovery = useRelayEnvironmentDiscovery();
  const registration = environmentId
    ? Discovery.relayEnvironmentRegistration(discovery, environmentId)
    : "unknown";
  const [shown, setShown] = useState({ label: environmentLabel, registration });
  if (
    environmentLabel !== null &&
    (environmentLabel !== shown.label || registration !== shown.registration)
  ) {
    setShown({ label: environmentLabel, registration });
  }
  const openAccountPage = accountPage.open;
  const accountPageLink = openAccountPage ? (
    <InlineButton
      onClick={() => {
        onCancel();
        openAccountPage();
      }}
    >
      T3 Connect 设置
    </InlineButton>
  ) : (
    "T3 Connect 设置"
  );

  return (
    <>
      <AlertDialog
        open={environmentLabel !== null}
        onOpenChange={(open) => {
          if (!open) onCancel();
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>要从此设备移除 {shown.label} 吗？</AlertDialogTitle>
            <AlertDialogDescription>
              这会清除它在此设备上的配对、凭据和缓存的会话。
            </AlertDialogDescription>
            <AlertDialogDescription>
              {shown.registration === "registered" ? (
                <>
                  它仍在你的 T3 Connect 账户中，并保留主机空间。可在 {accountPageLink}{" "}
                  中注销以释放它。
                </>
              ) : shown.registration === "unregistered" ? (
                "它已不在你的 T3 Connect 账户中。"
              ) : (
                <>这不会更改你的 T3 Connect 账户。若要在那里注销，请使用 {accountPageLink}。</>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>取消</AlertDialogClose>
            <Button variant="destructive" onClick={onConfirm}>
              从此设备移除
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
      {accountPage.portals}
    </>
  );
}

import { useSyncExternalStore } from "react";

import {
  completeConfirmDialogClose,
  readConfirmDialogState,
  respondToConfirmDialog,
  setConfirmDialogChecked,
  subscribeConfirmDialogHost,
} from "../confirmDialog";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogAction,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";

export function ConfirmDialogHost() {
  const state = useSyncExternalStore(
    subscribeConfirmDialogHost,
    readConfirmDialogState,
    readConfirmDialogState,
  );

  const idle = state.status === "idle";
  const confirmVariant = idle ? "default" : state.variant;
  const focusConfirm = !idle && state.initialFocus === "confirm";
  const onCancel = () => respondToConfirmDialog(false);
  const onConfirm = () => respondToConfirmDialog(true);
  const confirmLabel = idle ? "" : state.confirmLabel;

  return (
    <AlertDialog
      open={state.status === "confirming"}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      onOpenChangeComplete={(open) => {
        if (!open) completeConfirmDialogClose();
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>{idle ? "" : state.title}</AlertDialogTitle>
          {!idle && state.message ? (
            <AlertDialogDescription className="whitespace-pre-line">
              {state.message}
            </AlertDialogDescription>
          ) : null}
          {!idle && state.checkbox ? (
            <Checkbox
              label={state.checkbox.label}
              checked={state.checkbox.checked}
              onCheckedChange={(checked) => setConfirmDialogChecked(checked === true)}
            />
          ) : null}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>
            {idle ? "" : state.cancelLabel}
          </AlertDialogClose>
          {focusConfirm && confirmVariant === "default" ? (
            <AlertDialogAction onClick={onConfirm}>{confirmLabel}</AlertDialogAction>
          ) : (
            <Button variant={confirmVariant} onClick={onConfirm}>
              {confirmLabel}
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

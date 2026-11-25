import { useState } from "react";

import { useEnvironments } from "../../state/environments";
import { AddEnvironmentDialog } from "./AddEnvironmentDialog";

/** The add-computer entry for General settings, which owns the dialog's open and error state. */
export function AddComputerControl() {
  const { environments } = useEnvironments();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <AddEnvironmentDialog
      open={open}
      routeTarget={null}
      error={error}
      savedEnvironments={environments.filter(
        (environment) => environment.entry.target._tag !== "PrimaryConnectionTarget",
      )}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setError(null);
      }}
      onErrorChange={setError}
    />
  );
}

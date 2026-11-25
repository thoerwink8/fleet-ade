import type { ConnectionTarget } from "@t3tools/client-runtime/connection";
import { isDesktopLocalConnectionTarget } from "../../connection/desktopLocal";

/**
 * The offline banner may offer hiding a machine only after the disconnect
 * delay, and never for this app's own machine.
 */
export function canOfferEnvironmentDisconnect(input: {
  readonly delayElapsed: boolean;
  readonly target: ConnectionTarget | null;
}): boolean {
  return (
    input.delayElapsed &&
    input.target !== null &&
    input.target._tag !== "PrimaryConnectionTarget" &&
    !isDesktopLocalConnectionTarget(input.target)
  );
}

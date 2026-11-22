import { Atom } from "effect/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { appAtomRegistry } from "../rpc/atomRegistry";

export const primaryEnvironmentIdAtom = Atom.make((get) => {
  for (const [environmentId, entry] of get(environmentCatalog.catalogValueAtom).entries) {
    if (entry.target._tag === "PrimaryConnectionTarget") {
      return environmentId;
    }
  }
  return null;
}).pipe(Atom.withLabel("web-primary-environment-id"));

export const hostEnvironmentIdAtom = Atom.make<string | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("web-host-environment-id"),
);

export function startHostEnvironmentLookup(): void {
  void window.desktopBridge
    ?.getHostEnvironmentId?.()
    .then((environmentId) => appAtomRegistry.set(hostEnvironmentIdAtom, environmentId))
    .catch(() => {});
}

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  type VcsDriverKind,
  type VcsError,
  type VcsInitInput,
  VcsUnsupportedOperationError,
} from "@t3tools/contracts";
import * as VcsDriverRegistry from "./VcsDriverRegistry.ts";

export class VcsProvisioningService extends Context.Service<
  VcsProvisioningService,
  {
    readonly initRepository: (input: VcsInitInput) => Effect.Effect<void, VcsError>;
  }
>()("t3/vcs/VcsProvisioningService") {}

function resolveRequestedKind(
  kind: VcsDriverKind | undefined,
): Effect.Effect<VcsDriverKind, VcsUnsupportedOperationError> {
  if (kind === undefined) {
    return Effect.succeed("git");
  }
  if (kind === "unknown") {
    return Effect.fail(
      new VcsUnsupportedOperationError({
        operation: "VcsProvisioningService.resolveRequestedKind",
        kind,
        detail: "创建仓库需要指定具体的版本控制驱动种类。",
      }),
    );
  }
  return Effect.succeed(kind);
}

/** @public */
export const make = Effect.gen(function* () {
  const registry = yield* VcsDriverRegistry.VcsDriverRegistry;

  const initRepository: VcsProvisioningService["Service"]["initRepository"] = Effect.fn(
    "VcsProvisioningService.initRepository",
  )(function* (input) {
    const kind = yield* resolveRequestedKind(input.kind);
    const driver = yield* registry.get(kind);
    return yield* driver.initRepository(input);
  });

  return VcsProvisioningService.of({
    initRepository,
  });
});

export const layer = Layer.effect(VcsProvisioningService, make);

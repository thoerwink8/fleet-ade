import { describe, expect, it } from "@effect/vitest";
import { OrchestrationV2ProviderRef, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { buildUnavailableProviderSnapshot } from "../provider/unavailableProviderSnapshot.ts";

const decodeProviderRef = Schema.decodeSync(OrchestrationV2ProviderRef);

describe("retired provider literals", () => {
  it("decodes an event provider ref that names a removed driver", () => {
    const decoded = decodeProviderRef({
      driver: "cursor",
      nativeId: "thread-old",
      strength: "strong",
    });
    expect(decoded.driver).toBe("cursor");
    expect(decoded.nativeId).toBe("thread-old");
  });

  it.effect("shows the removed driver's display name, not its raw slug", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildUnavailableProviderSnapshot({
        driverKind: "cursor",
        instanceId: ProviderInstanceId.make("cursor"),
        reason: "This build does not include the cursor driver.",
      });
      expect(snapshot.displayName).toBe("Cursor");
    }),
  );
});

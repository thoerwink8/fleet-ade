import { describe, expect, it } from "@effect/vitest";
import { OrchestrationV2ProviderRef, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { buildUnavailableProviderSnapshot } from "../provider/unavailableProviderSnapshot.ts";
import { decodeImportedTranscriptPayload } from "./AgentSessionScanner.ts";

const decodeProviderRef = Schema.decodeSync(OrchestrationV2ProviderRef);

const transcript = (provider: string, filePath: string) => ({
  provider,
  providerInstanceId: ProviderInstanceId.make(provider),
  providerSessionId: "sess",
  filePath,
  size: 12,
  mtimeMs: null,
  device: 1,
  inode: "9",
  birthtimeMs: null,
});

describe("retired provider literals", () => {
  it("keeps a pi transcript beside the other entries instead of dropping the payload", () => {
    const decoded = decodeImportedTranscriptPayload({
      cwd: "/work",
      importedTranscripts: [
        transcript("pi", "/tmp/pi.jsonl"),
        transcript("codex", "/tmp/codex.jsonl"),
      ],
    });

    expect(Option.isSome(decoded)).toBe(true);
    if (Option.isSome(decoded)) {
      expect(decoded.value.importedTranscripts?.map((source) => source.provider)).toEqual([
        "pi",
        "codex",
      ]);
    }
  });

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

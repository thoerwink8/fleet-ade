import {
  isRetiredSourceControlKind,
  SourceControlProviderKind,
  UNSUPPORTED_SOURCE_CONTROL_LABEL,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { makeSourceControlDefinitionRegistry } from "./definition.ts";

const decodeKind = Schema.decodeSync(SourceControlProviderKind);
const encodeKind = Schema.encodeSync(SourceControlProviderKind);

describe("retired source control hosts", () => {
  const registry = makeSourceControlDefinitionRegistry([]);

  it.each(["gitlab"] as const)(
    "decodes %s without rewriting it and presents it as unsupported",
    (kind) => {
      const decoded = decodeKind(kind);
      expect(encodeKind(decoded)).toBe(kind);
      expect(isRetiredSourceControlKind(decoded)).toBe(true);
      expect(registry.get(decoded).label).toBe(UNSUPPORTED_SOURCE_CONTROL_LABEL);
      expect(registry.find(decoded)).toBeUndefined();
    },
  );

  it("recognizes a GitLab remote as unsupported instead of another host", () => {
    expect(registry.recognizeRemote("git@gitlab.com:group/project.git")).toMatchObject({
      kind: "gitlab",
      name: UNSUPPORTED_SOURCE_CONTROL_LABEL,
    });
  });
});

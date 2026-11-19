import { UNSUPPORTED_SOURCE_CONTROL_LABEL } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { sourceControlClients } from "./sourceControlClients.ts";

describe("built-in source control hosts", () => {
  it("keeps GitHub and does not offer a retired host", () => {
    expect(sourceControlClients.definitions.map((definition) => definition.kind)).toContain(
      "github",
    );
    expect(sourceControlClients.definitions.map((definition) => definition.kind)).not.toContain(
      "gitlab",
    );
    expect(sourceControlClients.get("gitlab").label).toBe(UNSUPPORTED_SOURCE_CONTROL_LABEL);
    expect(sourceControlClients.find("gitlab")).toBeUndefined();
  });
});

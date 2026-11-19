import { UNSUPPORTED_SOURCE_CONTROL_LABEL } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { sourceControlClients } from "./sourceControlClients.ts";

describe("built-in source control hosts", () => {
  it("keeps GitHub and does not offer a retired host", () => {
    expect(sourceControlClients.definitions.map((definition) => definition.kind)).toContain(
      "github",
    );
    for (const kind of [
      "gitlab",
      "forgejo",
      "gitcafe",
      "bitbucket",
      "azure-devops",
      "cursor-origin",
    ]) {
      expect(sourceControlClients.definitions.map((definition) => definition.kind)).not.toContain(
        kind,
      );
      expect(sourceControlClients.get(kind).label).toBe(UNSUPPORTED_SOURCE_CONTROL_LABEL);
      expect(sourceControlClients.find(kind)).toBeUndefined();
    }
  });

  it.each([
    ["gitcafe", "https://git.cafe/team/repo/pull/2"],
    ["forgejo", "https://forge.example/team/repo/pulls/2"],
    ["bitbucket", "https://bitbucket.org/team/repo/pull-requests/2"],
    ["azure-devops", "https://dev.azure.com/org/project/_git/repo/pullrequest/2"],
    ["cursor-origin", "https://cursor.com/codebase/team/repo/pull/2"],
  ])("does not claim retired %s URLs as GitHub", (kind, url) => {
    const parsed = sourceControlClients.parseChangeRequestUrl(url);
    expect(parsed?.definition.kind).toBe(kind);
    expect(parsed?.definition.label).toBe(UNSUPPORTED_SOURCE_CONTROL_LABEL);
  });
});

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

  it.each(["gitlab", "forgejo", "gitcafe", "bitbucket", "azure-devops", "cursor-origin"] as const)(
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

  it.each([
    [
      "forgejo",
      "https://codeberg.org/team/repo.git",
      "https://forge.example/mount/team/repo/pulls/2",
    ],
    ["gitcafe", "git@staging.git.cafe:team/repo.git", "https://git.cafe/team/repo/pull/2"],
    [
      "bitbucket",
      "git@bitbucket.org:team/repo.git",
      "https://bitbucket.example/team/repo/pull-requests/2",
    ],
    [
      "azure-devops",
      "git@ssh.dev.azure.com:v3/org/project/repo",
      "https://server.example/org/project/_git/repo/pullrequest/2",
    ],
    [
      "cursor-origin",
      "https://origin.cursor.com/team/repo.git",
      "https://cursor.com/codebase/team/repo/pull/2",
    ],
  ])("preserves %s remote and URL identities", (kind, remote, url) => {
    expect(registry.recognizeRemote(remote)).toMatchObject({
      kind,
      name: UNSUPPORTED_SOURCE_CONTROL_LABEL,
    });
    expect(registry.parseChangeRequestUrl(url)?.definition.kind).toBe(kind);
    expect(registry.hostLabelForChangeRequestUrl(url)).toBe(UNSUPPORTED_SOURCE_CONTROL_LABEL);
  });
});

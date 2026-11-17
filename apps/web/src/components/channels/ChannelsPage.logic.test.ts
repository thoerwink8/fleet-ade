import { describe, expect, it } from "vite-plus/test";
import { ProviderInstanceId, type ModelSelection } from "@t3tools/contracts";

import { groupChannelCandidates } from "./ChannelsPage.logic";

const model = (instanceId: string, name: string): ModelSelection => ({
  instanceId: ProviderInstanceId.make(instanceId),
  model: name,
});

const authorFirst = model("claude-code", "claude-sonnet-4");
const authorSecond = model("grok", "grok-code");
const verifierOnly = model("cursor", "cursor-fast");

describe("groupChannelCandidates", () => {
  it("两段候选都按设置里的顺序出现：写单在前、验单在后，段内不重新排", () => {
    const groups = groupChannelCandidates({
      author: [authorFirst, authorSecond],
      verifier: [verifierOnly],
    });
    expect(groups.map((group) => group.stage)).toEqual(["写单", "验单"]);
    expect(groups[0]?.candidates.map((item) => item.model)).toEqual([
      authorFirst.model,
      authorSecond.model,
    ]);
    expect(groups[1]?.candidates.map((item) => item.model)).toEqual([verifierOnly.model]);
  });
});

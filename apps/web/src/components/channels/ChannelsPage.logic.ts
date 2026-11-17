import type { ModelSelection } from "@t3tools/contracts";

export interface ChannelStageGroup {
  readonly stage: "写单" | "验单";
  readonly candidates: ReadonlyArray<ModelSelection>;
}

/** Both stages show their candidate lists in the order the settings stored them. */
export function groupChannelCandidates(settings: {
  readonly author: ReadonlyArray<ModelSelection>;
  readonly verifier: ReadonlyArray<ModelSelection>;
}): ReadonlyArray<ChannelStageGroup> {
  return [
    { stage: "写单", candidates: settings.author },
    { stage: "验单", candidates: settings.verifier },
  ];
}

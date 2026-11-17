import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId, type ModelSelection } from "@t3tools/contracts";

import {
  orderedCandidates,
  pickRouteCandidate,
  type CandidateAvailability,
  type RouteCandidate,
  type StageCandidateSettings,
} from "./routeCandidates.ts";

const claude: ModelSelection = {
  instanceId: ProviderInstanceId.make("claude-code"),
  model: "claude-sonnet-4",
};
const grok: ModelSelection = {
  instanceId: ProviderInstanceId.make("grok"),
  model: "grok-code",
};
const cursor: ModelSelection = {
  instanceId: ProviderInstanceId.make("cursor"),
  model: "cursor-fast",
};

const candidate = (model: ModelSelection, availability: CandidateAvailability): RouteCandidate => ({
  model,
  availability,
});

// Settings hold two ordered candidate lists, one per stage, not one model each.
const settings: StageCandidateSettings = {
  author: orderedCandidates([claude, grok]),
  verifier: orderedCandidates([cursor, claude]),
};

describe("route candidate settings", () => {
  it("写单、验单各是一串有序候选，不是各一个模型", () => {
    assert.deepEqual(
      settings.author.map((item) => item.model),
      [claude, grok],
    );
    assert.deepEqual(
      settings.verifier.map((item) => item.model),
      [cursor, claude],
    );
  });
});

describe("pickRouteCandidate", () => {
  it("第一个候选读不到时用第二个", () => {
    const picked = pickRouteCandidate([
      candidate(claude, "unreadable"),
      candidate(grok, "ready"),
      candidate(cursor, "ready"),
    ]);
    assert.deepEqual(picked, {
      kind: "open-session",
      sessionOpened: true,
      model: grok,
    });
  });

  it("第一个候选已用尽时用第二个", () => {
    const picked = pickRouteCandidate([
      candidate(claude, "exhausted"),
      candidate(cursor, "exhausted"),
      candidate(grok, "ready"),
    ]);
    assert.deepEqual(picked, {
      kind: "open-session",
      sessionOpened: true,
      model: grok,
    });
  });

  it("候选都读不到或都用尽时卡住，原因候选用尽，且没有开会话", () => {
    const opened: ModelSelection[] = [];
    for (const availability of ["unreadable", "exhausted"] as const) {
      const picked = pickRouteCandidate([
        candidate(claude, availability),
        candidate(grok, availability),
      ]);
      if (picked.kind === "open-session") opened.push(picked.model);
      assert.deepEqual(picked, {
        kind: "stuck",
        sessionOpened: false,
        reason: "候选用尽",
      });
    }
    assert.deepEqual(opened, []);
  });

  it("候选串是空的，原因是没配模型，不是候选用尽", () => {
    const picked = pickRouteCandidate([]);
    assert.deepEqual(picked, {
      kind: "stuck",
      sessionOpened: false,
      reason: "没配模型",
    });
  });
});

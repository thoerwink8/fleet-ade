import { ProviderDriverKind, ProviderInstanceId, type ModelSelection } from "@t3tools/contracts";
import type { ServerProvider } from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { describe, expect, it } from "vite-plus/test";

import { getCustomModelOptionsByInstance } from "../../modelSelection";
import { providerInstanceEntriesFor } from "../../providerInstances";
import {
  appendCandidate,
  moveCandidate,
  pipelineCandidateDisabledReason,
  pipelineCandidateDisplay,
  removeCandidateAt,
  samePipelineModel,
  verifierConflictsWithAuthor,
} from "./PipelineModelsSettings.logic";

const claude = ProviderInstanceId.make("claudeAgent");
const codex = ProviderInstanceId.make("codex");

const model = (instanceId: ProviderInstanceId, name: string, options?: ModelSelection["options"]) =>
  ({ instanceId, model: name, ...(options ? { options } : {}) }) satisfies ModelSelection;

const claudeSonnet = model(claude, "claude-sonnet-4");
const codexLuna = model(codex, "gpt-6-luna");

const provider = (overrides?: Partial<ServerProvider>): ServerProvider => ({
  instanceId: claude,
  driver: ProviderDriverKind.make("claudeAgent"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-11-23T00:00:00.000Z",
  models: [
    { slug: "claude-sonnet-4", name: "Claude Sonnet 4", isCustom: false, capabilities: null },
  ],
  slashCommands: [],
  skills: [],
  ...overrides,
});

describe("candidate list operations", () => {
  it("reorders, removes, and dedupes candidates without losing stored options", () => {
    const optioned = model(claude, "claude-sonnet-4", [{ id: "effort", value: "high" }]);
    const list = [claudeSonnet, codexLuna, model(claude, "claude-opus-4")];

    expect(moveCandidate(list, 2, -1).map((item) => item.model)).toEqual([
      "claude-sonnet-4",
      "claude-opus-4",
      "gpt-6-luna",
    ]);
    expect(moveCandidate(list, 0, -1)).toBe(list);
    expect(moveCandidate(list, list.length - 1, 1)).toBe(list);
    expect(moveCandidate(list, 4, 1)).toBe(list);
    expect(removeCandidateAt(list, 1)).toEqual([list[0], list[2]]);
    expect(removeCandidateAt([optioned], 0)).toEqual([]);

    // Adding an instance+model already in the list is a no-op, even with different options.
    expect(appendCandidate([optioned], claudeSonnet)).toHaveLength(1);
    const grown = appendCandidate([claudeSonnet], codexLuna);
    expect(grown).toEqual([claudeSonnet, codexLuna]);
    expect(appendCandidate(grown, codexLuna)).toBe(grown);
  });

  it("reports already-listed models to the picker", () => {
    const list = [claudeSonnet];
    expect(pipelineCandidateDisabledReason(list, claude, "claude-sonnet-4")).toBe("已在候选中");
    expect(pipelineCandidateDisabledReason(list, claude, "claude-opus-4")).toBeNull();
    expect(pipelineCandidateDisabledReason(list, codex, "claude-sonnet-4")).toBeNull();
    expect(pipelineCandidateDisabledReason([], claude, "claude-sonnet-4")).toBeNull();
  });
});

describe("verifier/author conflict", () => {
  it("flags only when the first author and verifier candidates are the same model", () => {
    expect(verifierConflictsWithAuthor([claudeSonnet], [claudeSonnet])).toBe(true);
    expect(verifierConflictsWithAuthor([claudeSonnet], [codexLuna, claudeSonnet])).toBe(false);
    expect(verifierConflictsWithAuthor([], [claudeSonnet])).toBe(false);
    expect(verifierConflictsWithAuthor([claudeSonnet], [])).toBe(false);
    const optioned = model(claude, "claude-sonnet-4", [{ id: "effort", value: "low" }]);
    expect(samePipelineModel(optioned, claudeSonnet)).toBe(false);
    expect(verifierConflictsWithAuthor([claudeSonnet], [optioned])).toBe(false);
  });
});

describe("candidate display", () => {
  const entries = providerInstanceEntriesFor([provider()], DEFAULT_UNIFIED_SETTINGS, null);
  const options = getCustomModelOptionsByInstance(DEFAULT_UNIFIED_SETTINGS, [provider()]);

  it("shows the provider model name and no warning for a healthy candidate", () => {
    const display = pipelineCandidateDisplay({
      selection: claudeSonnet,
      entries,
      modelOptionsByInstance: options,
    });
    expect(display.name).toBe("Claude Sonnet 4");
    expect(display.unavailableReason).toBeNull();
  });

  it("keeps the saved slug when the instance or model is gone from this environment", () => {
    expect(
      pipelineCandidateDisplay({
        selection: codexLuna,
        entries,
        modelOptionsByInstance: options,
      }),
    ).toEqual({
      name: "gpt-6-luna",
      slug: "gpt-6-luna",
      unavailableReason: "这台电脑上没有这个智能体。",
    });
    expect(
      pipelineCandidateDisplay({
        selection: model(claude, "claude-removed"),
        entries,
        modelOptionsByInstance: options,
      }).unavailableReason,
    ).toBe("此模型不可用。");
  });

  it("explains disabled and unavailable providers", () => {
    const disabled = providerInstanceEntriesFor(
      [provider({ enabled: false })],
      {
        ...DEFAULT_UNIFIED_SETTINGS,
        providerInstances: {
          [claude]: { driver: ProviderDriverKind.make("claudeAgent"), enabled: false },
        },
      },
      null,
    );
    expect(
      pipelineCandidateDisplay({
        selection: claudeSonnet,
        entries: disabled,
        modelOptionsByInstance: options,
      }).unavailableReason,
    ).toBe("Claude 已关闭。");
    const offline = providerInstanceEntriesFor(
      [provider({ availability: "unavailable" })],
      DEFAULT_UNIFIED_SETTINGS,
      null,
    );
    expect(
      pipelineCandidateDisplay({
        selection: claudeSonnet,
        entries: offline,
        modelOptionsByInstance: options,
      }).unavailableReason,
    ).toBe("Claude 不可用。");
  });
});

import { describe, expect, it, vi } from "vite-plus/test";

import {
  collectComposerModelMentions,
  formatComposerModelMention,
  rankComposerModelMentions,
} from "./composerModelMentions.ts";

const models = [
  { id: "traex:gpt", name: "GPT-6.1", driverKind: "codex", providerDisplayName: "Traex" },
  {
    id: "grok:traex-gpt",
    name: "GPT-6.1",
    subProvider: "Traex",
    driverKind: "grok",
    providerDisplayName: "Grok",
  },
  {
    id: "grok:opus",
    name: "Claude Opus 5.5",
    subProvider: "Anthropic",
    driverKind: "grok",
    providerDisplayName: "Grok",
  },
  {
    id: "claude:opus",
    name: "Claude Opus 5.5",
    driverKind: "claudeAgent",
    providerDisplayName: "Claude",
  },
];

function rank(query: string): string[] {
  return rankComposerModelMentions(models, query, (model) => model).map((model) => model.id);
}

describe("rankComposerModelMentions", () => {
  it.each(["", "-", "---", ":/-/:"])(
    "offers no models for a bare or separator-only @%s",
    (query) => {
      expect(rank(query)).toEqual([]);
    },
  );

  it("finds a model under every provider that serves it", () => {
    expect(rank("gpt").toSorted()).toEqual(["grok:traex-gpt", "traex:gpt"]);
  });

  it("splits words a mention joins with :, / or -", () => {
    expect(rank("grok:traex")).toEqual(["grok:traex-gpt"]);
    expect(rank("grok/gpt")).toEqual(["grok:traex-gpt"]);
    expect(rank("grok-gpt")).toEqual(["grok:traex-gpt"]);
  });

  it("keeps a hyphenated model name whole when it matches", () => {
    expect(rank("gpt-6.1").toSorted()).toEqual(["grok:traex-gpt", "traex:gpt"]);
  });

  it.each(["src", "g", "agent", "pus"])(
    "does not offer models whose words only contain @%s",
    (query) => {
      expect(rank(query)).toEqual([]);
    },
  );
});

describe("collectComposerModelMentions", () => {
  it("reads back what formatComposerModelMention writes, inside prose", () => {
    const text = `use ${formatComposerModelMention("grok", "anthropic/opus")}, then model:codex/gpt-5.4.`;
    expect(collectComposerModelMentions(text)).toEqual([
      {
        instanceId: "grok",
        model: "anthropic/opus",
        source: "model:grok/anthropic/opus",
        start: 4,
        end: 29,
      },
      { instanceId: "codex", model: "gpt-5.4", source: "model:codex/gpt-5.4", start: 36, end: 55 },
    ]);
  });

  it.each([
    ["(model:codex/gpt-6.1).", ["codex/gpt-6.1"]],
    ['"model:codex/gpt-6.1"', ["codex/gpt-6.1"]],
    ["model:codex/gpt-6.1,model:claudeAgent/sonnet", ["codex/gpt-6.1", "claudeAgent/sonnet"]],
    ["model:codex/gpt-6.1's output", ["codex/gpt-6.1"]],
    ["model:grok/foo(bar)", ["grok/foo(bar)"]],
    ["(model:codex/GPT-6.1-Sol[1m]).", ["codex/GPT-6.1-Sol[1m]"]],
    ["model:codex/gpt-6.1" + ")".repeat(128), ["codex/gpt-6.1"]],
  ])("bounds the reference in %s", (text, expected) => {
    const { mentions, rescans } = (() => {
      using split = vi.spyOn(String.prototype, "split");
      const mentions = collectComposerModelMentions(text);
      return { mentions, rescans: split.mock.calls.length };
    })();
    expect(mentions.map(({ instanceId, model }) => `${instanceId}/${model}`)).toEqual(expected);
    expect(rescans).toBeLessThanOrEqual(expected.length * 4);
  });

  it.each(["remodel:codex/gpt", "model:codex", "model:/gpt", "model:codex/.", "model:1x/gpt"])(
    "ignores %s",
    (text) => {
      expect(collectComposerModelMentions(text)).toEqual([]);
    },
  );
});

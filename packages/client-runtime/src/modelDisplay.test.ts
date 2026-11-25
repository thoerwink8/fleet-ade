import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  formatModelDisplayName,
  resolveCanonicalModelId,
  resolveCatalogModel,
  resolveModelDisplayName,
} from "./modelDisplay.ts";

const claude = ProviderDriverKind.make("claudeAgent");
const acpRegistry = ProviderDriverKind.make("acpRegistry");

describe("modelDisplay", () => {
  it("formats display names solely from provider name with exact id fallback", () => {
    expect(
      formatModelDisplayName({
        slug: "claude-opus-5-5",
        name: "  Claude Opus 5.5  ",
      }),
    ).toBe("Claude Opus 5.5");
    expect(
      formatModelDisplayName({
        slug: "MyCustom_Model-v1",
        name: "   ",
      }),
    ).toBe("MyCustom_Model-v1");
    expect(formatModelDisplayName({ slug: "showcase" })).toBe("showcase");
  });

  it("drops a repeated subProvider prefix from display names without touching ids", () => {
    expect(
      formatModelDisplayName({
        slug: "openrouter/anthropic/claude-opus-4.5",
        name: "openrouter/Claude Opus 4.5",
        subProvider: "openrouter",
      }),
    ).toBe("Claude Opus 4.5");
    expect(
      formatModelDisplayName({
        slug: "openrouter/anthropic/claude-opus-4.5",
        name: "OpenRouter: Claude Opus 4.5",
        subProvider: "openrouter",
      }),
    ).toBe("Claude Opus 4.5");
    expect(
      formatModelDisplayName({
        slug: "moonshot/kimi-k2",
        name: "Moonshot Kimi K2",
        subProvider: "Moonshot",
      }),
    ).toBe("Kimi K2");
    expect(
      formatModelDisplayName({
        slug: "openrouter/anthropic/claude-opus-4.5",
        name: "anthropic/claude-opus-4.5",
        subProvider: "openrouter",
      }),
    ).toBe("anthropic/claude-opus-4.5");
    expect(
      formatModelDisplayName({
        slug: "openrouter/openrouter",
        name: "openrouter",
        subProvider: "openrouter",
      }),
    ).toBe("openrouter");
  });

  it("prefers exact slug matches over colliding display names", () => {
    const models = [
      { slug: "model-a", name: "Shared" },
      { slug: "model-b", name: "model-a" },
    ];
    expect(resolveCatalogModel({ driverKind: claude, model: "model-a", models })).toEqual(
      models[0],
    );
    expect(resolveModelDisplayName({ driverKind: claude, model: "model-a", models })).toBe(
      "Shared",
    );
  });

  it("preserves exact raw id without inventing casing when uncataloged", () => {
    expect(
      resolveModelDisplayName({
        driverKind: acpRegistry,
        model: "showcase",
        models: [{ slug: "default", name: "Default", isDefault: true }],
      }),
    ).toBe("showcase");
    expect(
      resolveModelDisplayName({
        driverKind: null,
        model: "  MyCustom-ID  ",
        models: undefined,
      }),
    ).toBe("MyCustom-ID");
    expect(resolveModelDisplayName({ driverKind: claude, model: "   ", models: [] })).toBe("");
  });

  it("resolves acpRegistry default placeholder to discovered default model and provider aliases", () => {
    const acpModels = [
      { slug: "showcase", name: "Showcase", isDefault: true },
      { slug: "other", name: "Other Model" },
    ];
    expect(
      resolveCanonicalModelId({
        driverKind: acpRegistry,
        model: "default",
        models: acpModels,
      }),
    ).toBe("showcase");
    expect(
      resolveModelDisplayName({
        driverKind: acpRegistry,
        model: "default",
        models: acpModels,
      }),
    ).toBe("Showcase");

    const aliasModels = [
      {
        slug: "claude-opus-4-6",
        name: "Claude Opus 4.6",
        aliases: ["opus-latest"],
      },
    ];
    expect(
      resolveCanonicalModelId({
        driverKind: claude,
        model: "opus-latest",
        models: aliasModels,
      }),
    ).toBe("claude-opus-4-6");
    expect(
      resolveModelDisplayName({
        driverKind: claude,
        model: "opus-latest",
        models: aliasModels,
      }),
    ).toBe("Claude Opus 4.6");
  });
});

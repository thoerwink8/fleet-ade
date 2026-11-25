import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  resolveModelPickerTriggerDisplay,
  retainedModelWhileProviderLocked,
} from "./ProviderModelPicker.logic";
import type { ModelEsque } from "./providerIconUtils";

const claude = ProviderDriverKind.make("claudeAgent");
const acpRegistry = ProviderDriverKind.make("acpRegistry");
const antigravity = ProviderDriverKind.make("antigravity");
const opus = { slug: "claude-opus-5-5", name: "Claude Opus 5.5", shortName: "Opus 5.5" };
const sonnet = { slug: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", shortName: "Sonnet 5.5" };
const retained = (enabled: boolean, isAvailable: boolean, models = [sonnet, opus]) =>
  retainedModelWhileProviderLocked({ driverKind: claude, enabled, isAvailable, models }, opus.slug);

describe("retainedModelWhileProviderLocked", () => {
  it("shows a hidden saved model while its provider cannot run", () => {
    expect(retained(false, true)).toBe(opus);
    expect(retained(true, false)).toBe(opus);
    expect(retained(false, true, [sonnet])).toEqual({ slug: opus.slug, name: opus.slug });
    expect(retained(true, true)).toBeUndefined();
    expect(retainedModelWhileProviderLocked(null, opus.slug)).toBeUndefined();
  });
});

describe("resolveModelPickerTriggerDisplay", () => {
  const resolveTrigger = (input: {
    driverKind: ProviderDriverKind | undefined;
    model: string;
    options: ReadonlyArray<ModelEsque>;
  }) => resolveModelPickerTriggerDisplay(input);

  it("uses provider display name rather than shortName for known models", () => {
    expect(
      resolveTrigger({
        driverKind: claude,
        model: opus.slug,
        options: [opus, sonnet],
      }),
    ).toEqual({
      triggerTitle: "Claude Opus 5.5",
      triggerLabel: "Claude Opus 5.5",
      isUnavailable: false,
    });
  });

  it("displays exact non-empty model id instead of falling back to the placeholder option", () => {
    expect(
      resolveTrigger({
        driverKind: acpRegistry,
        model: "showcase",
        options: [{ slug: "default", name: "Default", isDefault: true }],
      }),
    ).toEqual({
      triggerTitle: "showcase",
      triggerLabel: "showcase",
      isUnavailable: false,
    });
  });

  it("maps acpRegistry default to the discovered default option and appends unavailable suffix", () => {
    expect(
      resolveTrigger({
        driverKind: acpRegistry,
        model: "default",
        options: [{ slug: "showcase", name: "Showcase", isDefault: true }],
      }),
    ).toEqual({
      triggerTitle: "Showcase",
      triggerLabel: "Showcase",
      isUnavailable: false,
    });

    expect(
      resolveTrigger({
        driverKind: acpRegistry,
        model: "showcase",
        options: [{ slug: "showcase", name: "showcase", isUnavailable: true }],
      }),
    ).toEqual({
      triggerTitle: "showcase",
      triggerLabel: "showcase（不可用）",
      isUnavailable: true,
    });
  });

  it("keeps empty-selection fallback when model is empty", () => {
    expect(
      resolveTrigger({
        driverKind: acpRegistry,
        model: "",
        options: [{ slug: "default", name: "Default", isDefault: true }],
      }),
    ).toEqual({
      triggerTitle: "Default",
      triggerLabel: "Default",
      isUnavailable: false,
    });
    expect(
      resolveTrigger({
        driverKind: antigravity,
        model: "",
        options: [{ slug: "gemini-3.1-pro", name: "Gemini 3.1 Pro" }],
      }),
    ).toEqual({
      triggerTitle: "选择模型",
      triggerLabel: "选择模型",
      isUnavailable: false,
    });
  });
});

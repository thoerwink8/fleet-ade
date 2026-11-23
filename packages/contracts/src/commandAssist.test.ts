import { describe, expect, it } from "vite-plus/test";
import { ProviderInstanceId } from "./providerInstance.ts";
import {
  COMMAND_ASSIST_TIMEOUT_MS,
  defaultCommandAssistRows,
  lookupCommandAssistRow,
} from "./commandAssist.ts";

const text = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "text-model",
};
const named = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "name-model",
};

describe("lookupCommandAssistRow", () => {
  it("uses text generation when the cell is empty, and skips a row that is off or has no model", () => {
    const rows = defaultCommandAssistRows();
    expect(lookupCommandAssistRow(rows, "naming", text)).toEqual({ _tag: "ready", model: text });
    expect(
      lookupCommandAssistRow(
        { ...rows, naming: { enabled: true, modelSelection: named } },
        "naming",
        text,
      ),
    ).toEqual({
      _tag: "ready",
      model: named,
    });
    expect(
      lookupCommandAssistRow(
        { ...rows, drift: { enabled: false, modelSelection: named } },
        "drift",
        text,
      ),
    ).toEqual({
      _tag: "skipped",
      reason: "off",
    });
    expect(lookupCommandAssistRow(rows, "activity", null)).toEqual({
      _tag: "skipped",
      reason: "no-model",
    });
    expect(COMMAND_ASSIST_TIMEOUT_MS).toBe(15_000);
  });

  it("does not run an unknown step that settings kept", () => {
    expect(
      lookupCommandAssistRow(
        {
          ...defaultCommandAssistRows(),
          futureStep: { enabled: true, modelSelection: named },
        },
        "futureStep",
        text,
      ),
    ).toEqual({ _tag: "skipped", reason: "unknown" });
  });
});

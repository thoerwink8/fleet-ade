import { SecretProviderId, SecretProviderKind } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render, type Screen } from "../../../test/render";
import { SecretSourceInput } from "./SecretSourceInput";

// No kind ships, so the reference syntax check runs against a stand-in definition.
vi.mock("@t3tools/secret-provider-definitions/registry", async () => {
  const Schema = await import("effect/Schema");
  const definition = {
    kind: "test_vault",
    label: "Test vault",
    configSchema: Schema.Struct({}),
    isReference: (reference: string) => reference.startsWith("ref://"),
    referencePlaceholder: "ref://vault/item/field",
    invalidReferenceMessage: "Use a reference like ref://vault/item/field.",
  };
  return {
    builtInSecretProviderDefinitions: {
      definitions: [definition],
      find: (kind: string) => (kind === definition.kind ? definition : undefined),
    },
  };
});

const personal = SecretProviderId.make("personal");
const work = SecretProviderId.make("work");
const sources = [
  { id: personal, kind: SecretProviderKind.make("test_vault"), label: "个人" },
  { id: work, kind: SecretProviderKind.make("test_vault"), label: "Work" },
];

const reference = (screen: Screen) => screen.getByRole("textbox", { name: "API 密钥 引用" });

async function commitReference(screen: Screen, value: string) {
  await userEvent.clear(reference(screen));
  await userEvent.type(reference(screen), value);
  await userEvent.keyboard("{Enter}");
}

describe("SecretSourceInput", () => {
  it("moves a reference to another provider only once one is committed for it", async () => {
    const onSecretChange = vi.fn();
    const onValidityChange = vi.fn();
    await using screen = await render(
      <SecretSourceInput
        aria-label="API 密钥"
        value={{ provider: personal, reference: "ref://Private/OpenAI/credential" }}
        sources={sources}
        onCommit={() => {}}
        onSecretChange={onSecretChange}
        onValidityChange={onValidityChange}
      />,
    );

    await userEvent.click(screen.getByRole("combobox", { name: "API 密钥 来源" }));
    await userEvent.click(screen.getByRole("option", { name: "Work" }));
    expect(onSecretChange).not.toHaveBeenCalled();
    expect(onValidityChange).toHaveBeenLastCalledWith(false);
    await expect.element(reference(screen)).toHaveValue("");

    await commitReference(screen, "ref://Shared/OpenAI/credential");
    expect(onSecretChange).toHaveBeenCalledExactlyOnceWith({
      provider: work,
      reference: "ref://Shared/OpenAI/credential",
    });
    expect(onValidityChange).toHaveBeenLastCalledWith(true);
  });

  it("removes the reference when its field is cleared", async () => {
    const onSecretChange = vi.fn();
    await using screen = await render(
      <SecretSourceInput
        aria-label="API 密钥"
        value={{ provider: personal, reference: "ref://Private/OpenAI/credential" }}
        sources={sources}
        onCommit={() => {}}
        onSecretChange={onSecretChange}
      />,
    );

    await commitReference(screen, "invalid-reference");
    await expect.element(reference(screen)).toHaveAttribute("aria-invalid", "true");
    await userEvent.clear(reference(screen));
    await userEvent.keyboard("{Enter}");
    expect(onSecretChange).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it("rejects a reference its provider cannot read", async () => {
    const onSecretChange = vi.fn();
    const onValidityChange = vi.fn();
    await using screen = await render(
      <SecretSourceInput
        aria-label="API 密钥"
        value={{ provider: personal, reference: "ref://Private/OpenAI/credential" }}
        sources={sources}
        onCommit={() => {}}
        onSecretChange={onSecretChange}
        onValidityChange={onValidityChange}
      />,
    );

    await commitReference(screen, "Private/OpenAI/credential");
    expect(onSecretChange).not.toHaveBeenCalled();
    expect(onValidityChange).toHaveBeenLastCalledWith(false);
    await expect.element(reference(screen)).toHaveAttribute("aria-invalid", "true");
    await expect.element(reference(screen)).toHaveValue("Private/OpenAI/credential");
    await commitReference(screen, "ref://Private/OpenAI/replacement");
    expect(onValidityChange).toHaveBeenLastCalledWith(true);
    expect(onSecretChange).toHaveBeenCalledExactlyOnceWith({
      provider: personal,
      reference: "ref://Private/OpenAI/replacement",
    });
  });
});

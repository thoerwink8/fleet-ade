import { describe, expect, it, vi } from "vite-plus/test";
import { useSyncExternalStore } from "react";

import { act, render } from "../../../test/render";

const connection = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  let connected = true;
  // A single computer has no machine picked, so its scope is "all"; a merged page picks one.
  // Picking a scope also starts a test connected, so a failed test cannot leak its state.
  const scopes = {
    environment: { kind: "environment", label: "Build workstation" },
    all: { kind: "all", label: "全部", environmentIds: ["env-1"] },
  };
  let scope: (typeof scopes)[keyof typeof scopes] = scopes.environment;
  return {
    get: () => connected,
    scope: () => scope,
    pick: (kind: keyof typeof scopes) => {
      scope = scopes[kind];
      connected = true;
    },
    toggle: () => {
      connected = !connected;
      for (const listener of listeners) listener();
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
});

vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useOptionalSettingsScope: (() => {
    const connected = useSyncExternalStore(connection.subscribe, connection.get);
    return {
      scope: connection.scope(),
      connectedEnvironments: connected
        ? [{ environmentId: "env-1", label: "Build workstation" }]
        : [],
      targets: [],
      environments: [],
      groups: [],
    };
  }) as never,
}));

vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: (() => true) as never,
  useEnvironmentsWithScope: ((environments: ReadonlyArray<{ environmentId: string }>) =>
    new Set(environments.map((environment) => environment.environmentId))) as never,
}));

import { DraftInput, DraftTextarea } from "../ui/draft-input";
import { SettingsEnvironmentScopeGate, SettingsRow } from "./settingsLayout";

describe("SettingsEnvironmentScopeGate", () => {
  it("keeps a typed draft through a disconnect and reconnect", async () => {
    connection.pick("environment");
    await using screen = await render(
      <SettingsEnvironmentScopeGate>
        <DraftInput aria-label="draft" value="saved" onCommit={() => false} />
      </SettingsEnvironmentScopeGate>,
    );
    const input = screen.getByRole("textbox", { name: "draft" });
    await input.fill("keep/me/");

    await act(() => connection.toggle());
    await expect
      .element(screen.getByText("重新连接 Build workstation，才能改它的设置。"))
      .toBeVisible();
    expect(screen.container.querySelector<HTMLInputElement>("input")?.value).toBe("keep/me/");

    await act(() => connection.toggle());
    await expect.element(input).toHaveValue("keep/me/");
  });
});

describe("SettingsRow", () => {
  it("keeps a typed draft in a single-computer row through a disconnect and reconnect", async () => {
    connection.pick("all");
    await using screen = await render(
      <SettingsRow
        serverScoped
        title="Branch prefix"
        control={<DraftInput aria-label="prefix" value="t3" onCommit={() => false} />}
      />,
    );
    const input = screen.getByRole("textbox", { name: "prefix" });
    await input.fill("keep/me/");

    await act(() => connection.toggle());
    expect(screen.container.querySelector("[inert]")).not.toBeNull();
    expect(screen.container.querySelector<HTMLInputElement>("input")?.value).toBe("keep/me/");

    await act(() => connection.toggle());
    await expect.element(input).toHaveValue("keep/me/");
  });

  it("keeps a typed draft in a row's children through a disconnect and reconnect", async () => {
    connection.pick("all");
    await using screen = await render(
      <SettingsRow serverScoped title="Instructions">
        <DraftTextarea aria-label="notes" value="" onCommit={() => false} />
      </SettingsRow>,
    );
    const textarea = screen.getByRole("textbox", { name: "notes" });
    await textarea.fill("keep this");

    await act(() => connection.toggle());
    expect(screen.container.querySelector("[inert]")).not.toBeNull();
    expect(screen.container.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe(
      "keep this",
    );

    await act(() => connection.toggle());
    await expect.element(textarea).toHaveValue("keep this");
  });
});

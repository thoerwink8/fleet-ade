import { describe, expect, it, vi } from "vite-plus/test";
import { useSyncExternalStore } from "react";

import { render } from "../../../test/render";

const connection = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  let connected = true;
  return {
    get: () => connected,
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
      scope: { kind: "environment", label: "Build workstation" },
      connectedEnvironments: connected ? [{}] : [],
    };
  }) as never,
}));

import { DraftInput } from "../ui/draft-input";
import { SettingsEnvironmentScopeGate } from "./settingsLayout";

describe("SettingsEnvironmentScopeGate", () => {
  it("keeps a typed draft through a disconnect and reconnect", async () => {
    await using screen = await render(
      <SettingsEnvironmentScopeGate>
        <DraftInput aria-label="draft" value="saved" onCommit={() => false} />
      </SettingsEnvironmentScopeGate>,
    );
    const input = screen.getByRole("textbox", { name: "draft" });
    await input.fill("keep/me/");

    connection.toggle();
    await expect
      .element(screen.getByText("重新连接 Build workstation，才能改它的设置。"))
      .toBeVisible();
    expect(screen.container.querySelector<HTMLInputElement>("input")?.value).toBe("keep/me/");

    connection.toggle();
    await expect.element(input).toHaveValue("keep/me/");
  });
});

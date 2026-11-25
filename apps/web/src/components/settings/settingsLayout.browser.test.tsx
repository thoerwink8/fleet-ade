import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
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
  // With a real provider the page reads one fake computer whose link and config the test drives.
  let real = false;
  let serverConfig: { settings: unknown; environment: unknown } = {
    settings: {},
    environment: { platform: { os: "linux" } },
  };
  const notify = () => {
    for (const listener of listeners) listener();
  };
  return {
    get: () => connected,
    scope: () => scope,
    isReal: () => real,
    pick: (kind: keyof typeof scopes) => {
      scope = scopes[kind];
      connected = true;
      real = false;
    },
    useRealProvider: (settings: unknown) => {
      real = true;
      connected = true;
      serverConfig = { settings, environment: { platform: { os: "linux" } } };
    },
    environments: () => [
      {
        environmentId: "env-1",
        label: "Build workstation",
        displayUrl: "",
        connection: { phase: connected ? "connected" : "disconnected" },
        serverConfig,
      },
    ],
    /** The config another device saved; the page learns it once the link is back. */
    serverSaves: (settings: unknown) => {
      serverConfig = { settings, environment: { platform: { os: "linux" } } };
    },
    toggle: () => {
      connected = !connected;
      notify();
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
});

vi.mock(import("./SettingsScopeContext"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    useOptionalSettingsScope: (() => {
      const connected = useSyncExternalStore(connection.subscribe, connection.get);
      const real = actual.useOptionalSettingsScope();
      if (connection.isReal()) return real;
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
  };
});

vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => {
    useSyncExternalStore(connection.subscribe, connection.get);
    return { isReady: true, networkStatus: "online", environments: connection.environments() };
  }) as never,
  usePrimaryEnvironmentId: (() => "env-1") as never,
  usePrimaryEnvironment: (() => connection.environments()[0]) as never,
}));

vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: (() => true) as never,
  useEnvironmentsWithScope: ((environments: ReadonlyArray<{ environmentId: string }>) =>
    new Set(environments.map((environment) => environment.environmentId))) as never,
}));

import { BranchNamingSettings } from "./BranchNamingSettings";
import { SettingsScopeProvider } from "./SettingsScopeContext";
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

describe("branch naming on a dropped connection", () => {
  const custom = {
    ...DEFAULT_SERVER_SETTINGS,
    branchNamingMode: "custom",
    branchNameInstructions: "use julius/",
  };
  const renderPage = () =>
    render(
      <SettingsScopeProvider search={{}} onChange={() => {}}>
        <BranchNamingSettings />
      </SettingsScopeProvider>,
    );

  it("keeps the mode and a typed instruction draft when the connection drops", async () => {
    connection.useRealProvider(custom);
    await using screen = await renderPage();
    const textarea = screen.getByRole("textbox", { name: "分支命名指令" });
    await textarea.fill("line one\nline two");

    await act(() => connection.toggle());
    // The mode still reads "custom", so the textarea that depends on it is not unmounted.
    expect(screen.container.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe(
      "line one\nline two",
    );
    expect(screen.container.querySelector("[inert]")).not.toBeNull();

    await act(() => connection.toggle());
    await expect.element(textarea).toHaveValue("line one\nline two");
  });

  it("shows what another device saved once the connection is back", async () => {
    connection.useRealProvider(custom);
    await using screen = await renderPage();
    const textarea = screen.getByRole("textbox", { name: "分支命名指令" });
    await expect.element(textarea).toHaveValue("use julius/");

    await act(() => connection.toggle());
    await expect.element(textarea).toHaveValue("use julius/");

    connection.serverSaves({ ...custom, branchNameInstructions: "use fleet/" });
    await act(() => connection.toggle());
    await expect.element(textarea).toHaveValue("use fleet/");
  });
});

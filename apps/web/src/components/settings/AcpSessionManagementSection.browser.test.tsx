import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ServerProvider,
  type AcpRegistryConfigurableProvider,
} from "@t3tools/contracts";
import type { ComponentProps } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";

const commands = vi.hoisted(() => ({
  list: vi.fn(),
  import: vi.fn(),
  delete: vi.fn(),
  listProviders: vi.fn(),
  setProvider: vi.fn(),
  disableProvider: vi.fn(),
  logout: vi.fn(),
}));
const grants = vi.hoisted(() => ({ scopes: new Set<string>() }));
const dialogs = vi.hoisted(() => ({ confirm: vi.fn() }));

vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: ((_id: unknown, scope: string) => grants.scopes.has(scope)) as never,
  readEnvironmentScope: ((_id: unknown, scope: string) => grants.scopes.has(scope)) as never,
}));
vi.mock(import("../../state/use-atom-command"), async (original) => {
  const { serverEnvironment } = await import("../../state/server");
  const byAtom = new Map<unknown, unknown>([
    [serverEnvironment.listAcpRegistrySessions, commands.list],
    [serverEnvironment.importAcpRegistrySession, commands.import],
    [serverEnvironment.deleteAcpRegistrySession, commands.delete],
    [serverEnvironment.listAcpRegistryProviders, commands.listProviders],
    [serverEnvironment.setAcpRegistryProvider, commands.setProvider],
    [serverEnvironment.disableAcpRegistryProvider, commands.disableProvider],
    [serverEnvironment.logoutAcpRegistry, commands.logout],
  ]);
  return {
    ...(await original()),
    useAtomCommand: ((atom: unknown) => byAtom.get(atom)) as never,
  };
});
vi.mock(import("../../localApi"), async (original) => ({
  ...(await original()),
  ensureLocalApi: () => ({ dialogs }) as never,
}));

import { AcpSessionManagementSection } from "./AcpSessionManagementSection";

const environmentId = EnvironmentId.make("remote-device");
const instanceId = ProviderInstanceId.make("acpRegistry_antigravity");
const projectId = ProjectId.make("project-antigravity");
const session = {
  sessionId: "native-session-1",
  cwd: "/workspace/antigravity",
  additionalDirectories: [],
  title: "Native Antigravity session",
  updatedAt: "2026-08-23T00:00:00Z",
  importedThreadId: null,
} as const;
const provider = {
  instanceId,
  driver: ProviderDriverKind.make("acpRegistry"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated", canLogout: true },
  nativeSessions: { canList: true, canLoad: true, canResume: true, canDelete: true },
  configurableProviders: true,
  checkedAt: "2026-08-23T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
} satisfies ServerProvider;

const project = { id: projectId, title: "Antigravity", workspaceRoot: session.cwd };
const replacement = {
  id: ProjectId.make("replacement"),
  title: "Replacement",
  workspaceRoot: "/replacement",
};
type Projects = ComponentProps<typeof AcpSessionManagementSection>["projects"];

function actionLabel(action: string) {
  if (action === "Save") return "保存";
  if (action === "Disable") return "停用";
  if (action === "Delete") return "删除";
  return action;
}

async function renderSection(options: { canList?: boolean; projects?: Projects } = {}) {
  const section = (projects = options.projects ?? [project]) => (
    <AcpSessionManagementSection
      environmentId={environmentId}
      instanceId={instanceId}
      provider={{
        ...provider,
        nativeSessions: { ...provider.nativeSessions, canList: options.canList ?? true },
      }}
      projects={projects}
      readOnly={false}
    />
  );
  const screen = await render(section());
  const button = (label: string) => {
    const found = [...screen.container.querySelectorAll("button")].find(
      (element) => element.textContent === label,
    );
    expect(found, `button ${label}`).toBeDefined();
    return found!;
  };
  return Object.assign(screen, {
    button,
    click: (label: string) => act(async () => button(label).click()),
    setProjects: (projects: Projects) => screen.rerender(section(projects)),
  });
}

function setup() {
  grants.scopes = new Set(["orchestration:read", "orchestration:operate", "providers:manage"]);
  commands.list.mockReset().mockResolvedValue({
    _tag: "Success",
    value: {
      sessions: [session],
      nextCursor: null,
      canLoad: true,
      canResume: true,
      canDelete: true,
    },
  });
  commands.import.mockReset().mockResolvedValue({
    _tag: "Success",
    value: { threadId: ThreadId.make("thread-imported"), imported: true },
  });
  commands.delete.mockReset().mockResolvedValue({
    _tag: "Success",
    value: { deleted: true },
  });
  commands.listProviders.mockReset().mockResolvedValue({
    _tag: "Success",
    value: {
      providers: [
        {
          providerId: "google",
          supported: ["openai"],
          required: false,
          current: { apiType: "openai", baseUrl: "https://api.example.test/v1" },
        },
      ],
    },
  });
  commands.setProvider.mockReset().mockResolvedValue({
    _tag: "Success",
    value: { configured: true },
  });
  commands.disableProvider.mockReset().mockResolvedValue({
    _tag: "Success",
    value: { disabled: true },
  });
  commands.logout.mockReset().mockResolvedValue({
    _tag: "Success",
    value: { loggedOut: true },
  });
  dialogs.confirm.mockReset().mockResolvedValue(true);
}

it("does not import with provider management alone", async () => {
  setup();
  grants.scopes.delete("orchestration:operate");
  await using screen = await renderSection();
  await screen.click("列出原生会话");
  expect(screen.button("导入").disabled).toBe(true);
  await screen.click("导入");
  expect(commands.import).not.toHaveBeenCalled();
});

it("rechecks task access after confirming deletion", async () => {
  setup();
  await using screen = await renderSection();
  await screen.click("列出原生会话");
  dialogs.confirm.mockImplementationOnce(async () => {
    grants.scopes.delete("orchestration:operate");
    return true;
  });
  await screen.click("删除");
  expect(commands.delete).not.toHaveBeenCalled();
});

it.each(["Save", "Disable"])("keeps other provider edits through a %s refetch", async (action) => {
  setup();
  const providers: AcpRegistryConfigurableProvider[] = ["google", "other"].map((providerId) => ({
    providerId,
    supported: ["openai"],
    required: false,
    current: { apiType: "openai", baseUrl: "https://api.example.test/v1" },
  }));
  const response = { _tag: "Success" as const, value: { providers } };
  commands.listProviders.mockResolvedValue(response);
  await using screen = await renderSection();
  await screen.click("列出模型服务");
  const input = (label: string) =>
    screen.container.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
  await userEvent.fill(input("other 基础 URL"), "https://other.example.test/v1");
  await userEvent.fill(input("other 只写请求头 JSON"), '{"X-Test":"unsaved"}');
  await userEvent.fill(input("google 只写请求头 JSON"), '{"X-Test":"saved"}');

  let resolveReload!: (value: typeof response) => void;
  const reload = new Promise<typeof response>((resolve) => {
    resolveReload = resolve;
  });
  commands.listProviders.mockReturnValueOnce(reload);
  let resolveMutation!: () => void;
  const mutation = new Promise<void>((resolve) => {
    resolveMutation = resolve;
  });
  const command = action === "Save" ? commands.setProvider : commands.disableProvider;
  command.mockReturnValueOnce(
    mutation.then(() => ({
      _tag: "Success",
      value: action === "Save" ? { configured: true } : { disabled: true },
    })),
  );
  await screen.click(actionLabel(action));
  expect(screen.button("刷新").disabled).toBe(true);
  await act(async () => resolveMutation());
  for (const button of screen.container.querySelectorAll<HTMLButtonElement>("button")) {
    if (button.textContent === "保存" || button.textContent === "停用") {
      expect(button.disabled).toBe(true);
    }
  }
  await userEvent.fill(input("other 基础 URL"), "https://newer.example.test/v1");
  await act(async () => resolveReload(response));

  expect(input("other 基础 URL").value).toBe("https://newer.example.test/v1");
  expect(input("other 只写请求头 JSON").value).toBe('{"X-Test":"unsaved"}');
  expect(input("google 只写请求头 JSON").value).toBe("");
  await screen.click("刷新");
  expect(input("other 基础 URL").value).toBe("https://api.example.test/v1");
  expect(input("other 只写请求头 JSON").value).toBe("");
});

it.each([true, false])(
  "enables project actions after projects arrive (sessions: %s)",
  async (canList) => {
    setup();
    await using screen = await renderSection({ canList, projects: [] });
    await screen.setProjects([project]);
    const action = screen.getByRole("button", {
      name: canList ? "列出原生会话" : "列出模型服务",
    });
    await expect.element(action).toBeEnabled();
    if (!canList) {
      await expect.element(screen.getByRole("combobox")).not.toBeInTheDocument();
    }
    await action.click();
    if (canList) {
      await expect.element(screen.getByText(session.title)).toBeVisible();
      expect(commands.list).toHaveBeenCalledWith({
        environmentId,
        input: { instanceId, projectId },
      });
    } else {
      await expect
        .element(screen.getByRole("textbox", { name: "google 基础 URL" }))
        .toHaveValue("https://api.example.test/v1");
      expect(commands.listProviders).toHaveBeenCalledWith({
        environmentId,
        input: { instanceId, projectId },
      });
    }
  },
);

it.each([true, false])(
  "preserves a valid selection and clears a removed project's data (sessions: %s)",
  async (canList) => {
    setup();
    const second = { id: ProjectId.make("second"), title: "Second", workspaceRoot: "/second" };
    commands.list.mockResolvedValue({
      _tag: "Success",
      value: { sessions: [session], nextCursor: "page-2" },
    });
    await using screen = await renderSection({ canList, projects: [project, second] });
    await screen.getByRole("combobox").click();
    if (canList) await userEvent.keyboard("{ArrowDown}{Enter}");
    else await screen.getByRole("option", { name: "Second", exact: true }).click();
    await expect
      .element(
        screen.getByRole("combobox", {
          name: canList ? "ACP 原生会话所属项目" : "ACP 模型服务所属项目",
        }),
      )
      .toHaveFocus();
    if (canList) await screen.getByRole("button", { name: "列出原生会话" }).click();
    await screen.getByRole("button", { name: "列出模型服务" }).click();
    await userEvent.fill(
      screen.getByRole("textbox", { name: "google 基础 URL" }),
      "https://draft.test",
    );
    await userEvent.fill(screen.getByLabelText("google 只写请求头 JSON"), '{"Secret":"draft"}');

    await screen.setProjects([project, replacement, second]);
    await expect
      .element(
        screen.getByRole("combobox", {
          name: canList ? "ACP 原生会话所属项目" : "ACP 模型服务所属项目",
        }),
      )
      .toHaveTextContent("Second");
    await expect
      .element(screen.getByRole("textbox", { name: "google 基础 URL" }))
      .toHaveValue("https://draft.test");
    await screen.getByRole("button", { name: "保存", exact: true }).click();
    expect(commands.setProvider).toHaveBeenLastCalledWith({
      environmentId,
      input: {
        instanceId,
        projectId: second.id,
        providerId: "google",
        apiType: "openai",
        baseUrl: "https://draft.test",
        headers: { Secret: "draft" },
      },
    });

    await screen.setProjects([project]);
    await expect.element(screen.getByText(session.title)).not.toBeInTheDocument();
    await expect.element(screen.getByRole("button", { name: "加载更多" })).not.toBeInTheDocument();
    await expect
      .element(screen.getByRole("textbox", { name: "google 基础 URL" }))
      .not.toBeInTheDocument();
    await screen.getByRole("button", { name: "列出模型服务" }).click();
    expect(commands.listProviders).toHaveBeenLastCalledWith({
      environmentId,
      input: { instanceId, projectId },
    });
    await expect.element(screen.getByLabelText("google 只写请求头 JSON")).toHaveValue("");
    await expect
      .element(screen.getByRole("textbox", { name: "google 基础 URL" }))
      .toHaveValue("https://api.example.test/v1");

    await screen.setProjects([second, project]);
    await expect
      .element(
        screen.getByRole("combobox", {
          name: canList ? "ACP 原生会话所属项目" : "ACP 模型服务所属项目",
        }),
      )
      .toHaveTextContent("Antigravity");
    await expect
      .element(screen.getByRole("textbox", { name: "google 基础 URL" }))
      .toHaveValue("https://api.example.test/v1");

    await screen.setProjects([]);
    await expect.element(screen.getByRole("button", { name: "列出模型服务" })).toBeDisabled();
    await expect
      .element(screen.getByRole("textbox", { name: "google 基础 URL" }))
      .not.toBeInTheDocument();
  },
);

it("ignores a late listing after project replacement", async () => {
  setup();
  let finish!: (value: unknown) => void;
  commands.list.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await using screen = await renderSection();
  await screen.click("列出原生会话");
  await screen.setProjects([replacement]);
  await act(async () =>
    finish({ _tag: "Success", value: { sessions: [session], nextCursor: "old-page" } }),
  );
  await expect.element(screen.getByText(session.title)).not.toBeInTheDocument();
  await expect.element(screen.getByRole("button", { name: "加载更多" })).not.toBeInTheDocument();
  await expect.element(screen.getByRole("button", { name: "列出原生会话" })).toBeEnabled();
});

it.each(["Save", "Disable"])("does not refetch the old project after a late %s", async (action) => {
  setup();
  const command = action === "Save" ? commands.setProvider : commands.disableProvider;
  let finish!: () => void;
  command.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      finish = resolve;
    }).then(() => ({
      _tag: "Success",
      value: action === "Save" ? { configured: true } : { disabled: true },
    })),
  );
  await using screen = await renderSection();
  await screen.click("列出模型服务");
  await screen.click(actionLabel(action));
  expect(command).toHaveBeenCalledOnce();
  await screen.setProjects([replacement]);
  await act(async () => finish());
  expect(commands.listProviders).toHaveBeenCalledOnce();
  await expect.element(screen.getByRole("button", { name: "列出模型服务" })).toBeEnabled();
});

it.each(["Delete", "停用"])(
  "does not act on a replaced project after confirming %s",
  async (action) => {
    setup();
    let finish!: (confirmed: boolean) => void;
    dialogs.confirm.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
    );
    await using screen = await renderSection();
    await screen.click(action === "Delete" ? "列出原生会话" : "列出模型服务");
    await screen.click(actionLabel(action));
    await screen.setProjects([replacement]);
    await act(async () => finish(true));
    expect(action === "Delete" ? commands.delete : commands.disableProvider).not.toHaveBeenCalled();
  },
);

it("keeps logout pending across project replacement and clears replacement sessions", async () => {
  setup();
  let finish!: () => void;
  commands.logout.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      finish = resolve;
    }).then(() => ({
      _tag: "Success",
      value: { loggedOut: true },
    })),
  );
  await using screen = await renderSection();
  await screen.click("退出登录");
  await screen.setProjects([replacement]);
  await screen.click("列出原生会话");
  await expect.element(screen.getByText(session.title)).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "正在退出登录" })).toBeDisabled();
  await screen.click("正在退出登录");
  expect(commands.logout).toHaveBeenCalledOnce();
  await act(async () => finish());
  await expect.element(screen.getByText(session.title)).not.toBeInTheDocument();
  await expect.element(screen.getByRole("button", { name: "退出登录", exact: true })).toBeEnabled();
});

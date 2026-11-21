import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

const persisted = vi.hoisted(() => ({ title: "" }));
const openMenu = vi.hoisted(() => vi.fn());
vi.mock(import("../../state/session"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
}));
vi.mock(import("../../state/use-orchestration-command"), async (importOriginal) => ({
  ...(await importOriginal()),
  useOrchestrationCommand: (() =>
    async ({ input }: { input: { title: string } }) => {
      persisted.title = input.title;
      return { _tag: "Success" };
    }) as never,
}));
vi.mock(import("~/hooks/useThreadActionMenu"), () => ({
  useThreadActionMenu: () => ({ openMenu, closeMenu: () => {} }),
}));

import { render, stubGlobal } from "../../../test/render";
import { PopoverCreateHandle } from "../ui/popover";
import { ChatHeader } from "./ChatHeader";
import { ThreadHeaderContext } from "./ThreadHeaderMeta";

function header(title: string) {
  return (
    <>
      <ChatHeader
        activeThreadEnvironmentId={EnvironmentId.make("environment")}
        activeThreadId={ThreadId.make("thread")}
        activeThreadTitle={title}
        isServerThread
        activeProject={null}
        parentThreadLink={null}
        onOpenThread={() => {}}
        rightPanelOpen={false}
        onNewThreadInProject={() => {}}
      />
      <div tabIndex={0}>Outside rename</div>
    </>
  );
}

it.each(["blur", "Enter"] as const)(
  "preserves a concurrent title update when an untouched rename ends with %s",
  async (finish) => {
    persisted.title = "新建会话";
    await using screen = await render(header(persisted.title));
    await screen.getByRole("button", { name: "新建会话 的会话操作" }).dblClick();
    const input = screen.getByRole("textbox", { name: "会话标题" });
    await expect.element(input).toHaveValue("新建会话");

    persisted.title = "Fix login redirect";
    await screen.rerender(header(persisted.title));
    if (finish === "Enter") await userEvent.keyboard("{Enter}");
    else await screen.getByText("Outside rename").click();

    await expect.element(input).not.toBeInTheDocument();
    expect(persisted.title).toBe("Fix login redirect");

    await screen.rerender(header(persisted.title));
    await screen.getByRole("button", { name: "Fix login redirect 的会话操作" }).dblClick();
    await screen.getByRole("textbox", { name: "会话标题" }).fill("My edited title");
    persisted.title = "Another concurrent title";
    await screen.rerender(header(persisted.title));
    await userEvent.keyboard("{Enter}");
    await expect.element(screen.getByRole("textbox", { name: "会话标题" })).not.toBeInTheDocument();
    expect(persisted.title).toBe("My edited title");
  },
);

it("opens the thread menu on a desktop title click without waiting", async () => {
  openMenu.mockClear();
  using _bridge = stubGlobal("desktopBridge", {});
  await using screen = await render(header("新建会话"));
  await screen.getByRole("button", { name: "新建会话 的会话操作" }).click();
  expect(openMenu).toHaveBeenCalledOnce();
});

it("shows percent and cost on desktop, omits cost when absent, and hides cost suffix on narrow viewports", async () => {
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(1280, 800);
  await using _viewport = {
    [Symbol.asyncDispose]: () => page.viewport(viewport.width, viewport.height),
  };

  const contextButton = (cost: string | null) => (
    <ThreadHeaderContext
      percent="19.3%"
      cost={cost}
      open={false}
      presentation="inline"
      popoverHandle={PopoverCreateHandle()}
      shortcutLabel={null}
      onToggle={() => {}}
    />
  );

  await using screen = await render(contextButton("$0.38"));
  const button = screen.getByRole("button", {
    name: "上下文已用 19.3%，本会话花费 $0.38，打开会话详情",
  });
  await expect.element(button).toBeVisible();
  await expect.element(screen.getByText("19.3%")).toBeVisible();
  await expect.element(screen.getByText("· $0.38")).toBeVisible();

  await page.viewport(390, 844);
  await expect.element(screen.getByText("19.3%")).toBeVisible();
  await expect.element(screen.getByText("· $0.38")).not.toBeVisible();

  await page.viewport(1280, 800);
  await screen.rerender(contextButton(null));
  await expect
    .element(screen.getByRole("button", { name: "上下文已用 19.3%，打开会话详情" }))
    .toBeVisible();
  expect(document.querySelector("[data-thread-header-cost]")).toBeNull();
});

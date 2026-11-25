import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { serializeAssistantCitation } from "@t3tools/shared/assistantCitations";
import {
  formatComposerContextReference,
  toComposerContextId,
} from "@t3tools/shared/composerContextReferences";
import * as DateTime from "effect/DateTime";
import type { ComponentProps } from "react";
import { expect, it, vi } from "vite-plus/test";
import { cdp, page } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({
  projection: null as unknown,
  workflow: null as unknown,
}));

vi.mock(import("@t3tools/client-runtime/state/thread-workflows"), async (importOriginal) => ({
  ...(await importOriginal()),
  deriveThreadQueueWorkflowState: (() => state.workflow) as never,
}));

vi.mock(import("../../state/entities"), async (importOriginal) => ({
  ...(await importOriginal()),
  useThreadProjection: (() => state.projection) as never,
  // The linked environment is connected, but its thread is not in the loaded shell.
  useQuietThreadShell: ((target: { readonly environmentId: string } | null) =>
    target === null || target.environmentId === "environment:linked"
      ? null
      : { title: "Release lead" }) as never,
}));

vi.mock(import("../../state/environments"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironment: ((environmentId: string | null) =>
    environmentId === "environment:linked" ? { environmentId } : null) as never,
}));

vi.mock(import("../../state/query"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentQuery: (() => ({
    data: { tasks: [{ id: "task:webhook", title: "PR dispatcher" }] },
  })) as never,
}));

vi.mock(import("../../state/use-atom-command"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAtomCommand: (() => async () => undefined) as never,
}));

vi.mock(import("../../assets/assetUrls"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAssetUrls: ((_environmentId: never, resources: ReadonlyArray<{ attachmentId: string }>) =>
    resources.map((resource) => `https://assets.test/${resource.attachmentId}`)) as never,
}));

import "~/index.css";
import { render as renderUi } from "../../../test/render";
import { QueuedRunsControl } from "./QueuedRunsControl";

function setup() {
  state.projection = null;
  state.workflow = null;
}

const baseProps = {
  environmentId: "environment:test" as never,
  optimisticMessages: [],
  threadId: "thread:test" as never,
  editingRunId: null,
  editBlockedReason: null,
  onEditQueuedRun: () => undefined,
  onCancelEdit: () => undefined,
  timestampFormat: "locale",
  onOpenThread: () => undefined,
} satisfies ComponentProps<typeof QueuedRunsControl>;

async function renderQueue(props: Partial<ComponentProps<typeof QueuedRunsControl>> = {}) {
  return renderUi(<QueuedRunsControl {...baseProps} {...props} />);
}

it("previews assistant quotes as readable text and preserves the citation when editing", async () => {
  setup();
  const quotedText = "Cache the parsed config per worktree.";
  const quote = serializeAssistantCitation({
    version: 1,
    environmentId: EnvironmentId.make("environment:test"),
    threadId: ThreadId.make("thread:test"),
    messageId: MessageId.make("message:assistant"),
    text: quotedText,
    start: 0,
    end: quotedText.length,
    prefix: "",
    suffix: "",
  });
  const quoteAndText = `${quote}\n\nWhy per worktree?`;
  const inlineImage = formatComposerContextReference({
    kind: "image",
    contextId: toComposerContextId("header"),
    label: "header.png",
  });
  state.projection = { projection: { messages: [] } };
  state.workflow = {
    activeRun: { id: "run:active" },
    canPromoteToSteer: true,
    queuedRuns: [
      {
        run: { id: "run:quote-only", userMessageId: "message:quote-only" },
        text: quote,
        attachments: [],
      },
      {
        run: { id: "run:quote-and-text", userMessageId: "message:quote-and-text" },
        text: quoteAndText,
        attachments: [],
      },
      {
        run: { id: "run:inline-image", userMessageId: "message:inline-image" },
        text: `Make the header look like ${inlineImage} and keep the logo.`,
        attachments: [{ type: "image", id: "attachment:header", name: "header.png" }],
      },
    ],
  };
  const onEditQueuedRun = vi.fn();
  await using _screen = await renderQueue({ onEditQueuedRun });

  await expect.element(page.getByText(quotedText, { exact: true })).toBeVisible();
  await expect
    .element(page.getByText(`${quotedText} Why per worktree?`, { exact: true }))
    .toBeVisible();
  await expect
    .element(
      page.getByText("Make the header look like header.png and keep the logo.", { exact: true }),
    )
    .toBeVisible();

  await page.getByRole("button", { name: "编辑排队消息", exact: true }).nth(1).click();
  expect(onEditQueuedRun).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ text: quoteAndText }),
  );
});

it("shows who sent a queued message and folds automation and agent prompts", async () => {
  setup();
  const message = (id: string, fields: Record<string, unknown>) => ({
    id,
    role: "user",
    createdAt: DateTime.makeUnsafe("2026-10-27T12:00:00.000Z"),
    ...fields,
  });
  state.projection = { projection: { messages: [] } };
  state.workflow = {
    activeRun: { id: "run:active" },
    canPromoteToSteer: true,
    queuedRuns: [
      [
        "run:automation",
        "GitHub labeled a pull request.\nFollow the runbook.",
        {
          createdBy: "agent",
          scheduledTaskId: "task:webhook",
        },
      ],
      [
        "run:agent",
        "Review finished.",
        {
          createdBy: "agent",
          creationSource: "provider",
          senderThreadId: "thread:lead",
        },
      ],
      [
        "run:linked",
        "Linked review finished.",
        {
          createdBy: "agent",
          creationSource: "mcp",
          linkedSender: {
            environmentId: "environment:linked",
            threadId: "thread:linked-lead",
            title: "Title when sent",
          },
        },
      ],
      [
        "run:server",
        "Continue where you left off.",
        {
          createdBy: "agent",
          creationSource: "server",
        },
      ],
    ].map(([runId, text, fields]) => ({
      run: { id: runId, userMessageId: `${runId}:message` },
      text,
      attachments: [],
      message: message(`${runId}:message`, { text, ...(fields as object) }),
    })),
  };
  const onOpenThread = vi.fn();
  await using _screen = await renderQueue({ onOpenThread });
  // Four rows collapse the queue.
  await page.getByRole("button", { name: "显示全部 4 条排队消息" }).click();

  // An automation's row shows its task title; the prompt stays out of the strip.
  await expect.element(page.getByText("PR dispatcher", { exact: true })).toBeVisible();
  await expect.element(page.getByText(/Follow the runbook/)).not.toBeInTheDocument();
  await expect.element(page.getByRole("link", { name: "打开自动化" })).toBeInTheDocument();

  await expect.element(page.getByText("Release lead", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "打开会话" }).nth(0).click({ force: true });
  expect(onOpenThread).toHaveBeenCalledExactlyOnceWith("thread:lead", "environment:test");
  // A sender in a connected linked environment keeps the title it sent and opens there.
  await expect.element(page.getByText("Title when sent", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "打开会话" }).nth(1).click({ force: true });
  expect(onOpenThread).toHaveBeenLastCalledWith("thread:linked-lead", "environment:linked");

  await expect.element(page.getByText("由 Fleet ADE 发送 ·", { exact: true })).toBeVisible();
  await expect.element(page.getByText("Continue where you left off.")).toBeVisible();
});

it("stays inside the timeline scroller instead of growing the chat column", async () => {
  setup();
  state.projection = { projection: { messages: [] } };
  state.workflow = {
    activeRun: { id: "run:active" },
    canPromoteToSteer: true,
    queuedRuns: [
      {
        run: { id: "run:queued", userMessageId: "message:queued" },
        text: "稍后",
        attachments: [],
      },
    ],
  };
  // Mirrors ChatView: a scrollable column, a positioned wrapper, then a non-positioned scroller.
  await using screen = await renderUi(
    <div data-testid="column" style={{ height: 200, overflowY: "auto" }}>
      <div style={{ position: "relative", height: "100%" }}>
        <div style={{ height: "100%", overflowY: "auto" }}>
          <div style={{ height: 1000 }} />
          <QueuedRunsControl {...baseProps} />
        </div>
      </div>
    </div>,
  );
  await expect.element(page.getByText("稍后", { exact: true })).toBeInTheDocument();
  const column = screen.getByTestId("column").element();
  expect(column.scrollHeight).toBe(column.clientHeight);
});

async function emulatePointer(options: {
  width: number;
  height: number;
  pointer: "coarse" | "fine";
}): Promise<AsyncDisposable> {
  const previous = { width: window.innerWidth, height: window.innerHeight };
  const session = cdp();
  const isTouch = options.pointer === "coarse";
  const cleanup = async () => {
    await session.send("Emulation.setEmulatedMedia", { features: [] });
    await session.send("Emulation.setTouchEmulationEnabled", { enabled: false });
    await session.send("Emulation.clearDeviceMetricsOverride");
    await page.viewport(prevWidthOrCurrent(previous.width), prevWidthOrCurrent(previous.height));
  };
  await page.viewport(options.width, options.height);
  await session.send("Emulation.setDeviceMetricsOverride", {
    width: options.width,
    height: options.height,
    deviceScaleFactor: isTouch ? 2 : 1,
    mobile: isTouch,
  });
  await session.send("Emulation.setTouchEmulationEnabled", {
    enabled: isTouch,
    ...(isTouch ? { maxTouchPoints: 5 } : {}),
  });
  await session.send("Emulation.setEmulatedMedia", {
    features: isTouch
      ? [
          { name: "pointer", value: "coarse" },
          { name: "hover", value: "none" },
        ]
      : [
          { name: "pointer", value: "fine" },
          { name: "hover", value: "hover" },
        ],
  });
  return { [Symbol.asyncDispose]: cleanup };
}

function prevWidthOrCurrent(value: number): number {
  return value > 0 ? value : 1280;
}

it("expands queued message action hit areas to >= 44px via ::after on coarse 390x844 without growing painted buttons", async () => {
  setup();
  const message = (id: string, fields: Record<string, unknown>) => ({
    id,
    role: "user",
    createdAt: DateTime.makeUnsafe("2026-10-27T12:00:00.000Z"),
    ...fields,
  });
  state.projection = { projection: { messages: [] } };
  state.workflow = {
    activeRun: { id: "run:active" },
    canPromoteToSteer: true,
    queuedRuns: [
      {
        run: { id: "run:regular", userMessageId: "message:regular" },
        text: "普通排队消息",
        attachments: [],
      },
      {
        run: { id: "run:editing", userMessageId: "message:editing" },
        text: "正在编辑的排队消息",
        attachments: [],
      },
      {
        run: { id: "run:agent", userMessageId: "message:agent" },
        text: "智能体排队消息",
        attachments: [],
        message: message("message:agent", {
          text: "智能体排队消息",
          createdBy: "agent",
          creationSource: "provider",
          senderThreadId: "thread:lead",
        }),
      },
      {
        run: { id: "run:automation", userMessageId: "message:automation" },
        text: "自动化排队消息",
        attachments: [],
        message: message("message:automation", {
          text: "自动化排队消息",
          createdBy: "agent",
          scheduledTaskId: "task:webhook",
        }),
      },
    ],
  };

  await using _pointer = await emulatePointer({ width: 390, height: 844, pointer: "coarse" });
  await using screen = await renderQueue({ editingRunId: "run:editing" as never });
  await vi.waitFor(() => expect(window.matchMedia("(pointer: coarse)").matches).toBe(true));

  const showAll = page.getByRole("button", { name: "显示全部 4 条排队消息" });
  await showAll.click();
  await expect.element(page.getByRole("link", { name: "打开自动化" })).toBeVisible();

  const regularRow = screen.container.querySelectorAll("li")[0]!;
  const regularButtons = [...regularRow.querySelectorAll<HTMLButtonElement>("button")];
  const steerBtn = regularButtons.find((btn) => btn.textContent?.includes("立即发送"))!;
  const editBtn = regularRow.querySelector<HTMLButtonElement>('button[aria-label="编辑排队消息"]')!;
  const withdrawBtn = regularRow.querySelector<HTMLButtonElement>(
    'button[aria-label="撤回排队消息"]',
  )!;
  const cancelEditBtn = screen.container.querySelector<HTMLButtonElement>(
    'button[aria-label="取消编辑排队消息"]',
  )!;
  const openThreadBtn = screen.getByRole("button", { name: "打开会话" }).element() as HTMLElement;
  const openAutomationLink = screen
    .getByRole("link", { name: "打开自动化" })
    .element() as HTMLElement;
  const collapseBtn = screen.getByRole("button", { name: "收起" }).element() as HTMLElement;

  for (const [label, el, maxPaintedHeight] of [
    ["立即发送", steerBtn, 24],
    ["编辑排队消息", editBtn, 24],
    ["撤回排队消息", withdrawBtn, 24],
    ["取消编辑排队消息", cancelEditBtn, 24],
    ["打开会话", openThreadBtn, 20],
    ["打开自动化", openAutomationLink, 20],
    ["收起", collapseBtn, 20],
  ] as const) {
    el.scrollIntoView({ block: "center", inline: "nearest" });
    const rect = el.getBoundingClientRect();
    const after = getComputedStyle(el, "::after");
    expect(Math.round(rect.height), `${label} painted height`).toBeLessThanOrEqual(
      maxPaintedHeight,
    );
    expect(Number.parseFloat(after.width), `${label} ::after width`).toBeGreaterThanOrEqual(44);
    expect(Number.parseFloat(after.height), `${label} ::after height`).toBeGreaterThanOrEqual(44);
    const cx = rect.left + rect.width / 2;
    expect(document.elementFromPoint(cx, rect.top - 6), `${label} top extended hit`).toBe(el);
    expect(document.elementFromPoint(cx, rect.bottom + 6), `${label} bottom extended hit`).toBe(el);
  }

  const editRect = editBtn.getBoundingClientRect();
  const editCy = editRect.top + editRect.height / 2;
  expect(document.elementFromPoint(editRect.left - 6, editCy), "edit left extended hit").toBe(
    editBtn,
  );
  expect(document.elementFromPoint(editRect.right + 6, editCy), "edit right extended hit").toBe(
    editBtn,
  );

  // Adjacent controls keep non-overlapping hit zones across the 20px coarse gap:
  // 24px edit button extends 10px on each side (44px total) without crossing onto wide neighbors.
  const steerRect = steerBtn.getBoundingClientRect();
  const withdrawRect = withdrawBtn.getBoundingClientRect();
  expect(document.elementFromPoint(steerRect.right - 2, editCy), "steer right edge").toBe(steerBtn);
  expect(
    document.elementFromPoint(steerRect.right + 2, editCy),
    "steer side does not steal for edit",
  ).not.toBe(editBtn);
  expect(document.elementFromPoint(editRect.left - 9, editCy), "edit extended left edge").toBe(
    editBtn,
  );
  expect(document.elementFromPoint(editRect.right + 9, editCy), "edit extended right edge").toBe(
    editBtn,
  );
  expect(
    document.elementFromPoint(withdrawRect.left - 2, editCy),
    "withdraw side does not steal for edit",
  ).not.toBe(editBtn);
  expect(document.elementFromPoint(withdrawRect.left + 2, editCy), "withdraw left edge").toBe(
    withdrawBtn,
  );
});

it("keeps ::after inactive on desktop fine pointer for queued message controls", async () => {
  setup();
  state.projection = { projection: { messages: [] } };
  state.workflow = {
    activeRun: { id: "run:active" },
    canPromoteToSteer: true,
    queuedRuns: [
      {
        run: { id: "run:agent", userMessageId: "message:agent" },
        text: "桌面测试",
        attachments: [],
        message: {
          id: "message:agent",
          role: "user",
          createdAt: DateTime.makeUnsafe("2026-10-27T12:00:00.000Z"),
          text: "桌面测试",
          createdBy: "agent",
          creationSource: "provider",
          senderThreadId: "thread:lead",
        },
      },
    ],
  };

  await using _pointer = await emulatePointer({ width: 1280, height: 800, pointer: "fine" });
  await using screen = await renderQueue();
  await vi.waitFor(() => expect(window.matchMedia("(pointer: coarse)").matches).toBe(false));

  const editBtn = screen.getByRole("button", { name: "编辑排队消息" }).element();
  const withdrawBtn = screen.getByRole("button", { name: "撤回排队消息" }).element();
  const openThreadBtn = screen.getByRole("button", { name: "打开会话" }).element();
  expect(getComputedStyle(editBtn, "::after").content).toBe("none");
  expect(getComputedStyle(withdrawBtn, "::after").content).toBe("none");
  expect(getComputedStyle(openThreadBtn, "::after").content).toBe("none");
});

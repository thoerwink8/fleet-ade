import { converter, modeOklch, modeRgb, useMode } from "culori/fn";
import { CircleAlertIcon } from "lucide-react";
import { useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { cdp, page, userEvent } from "vite-plus/test/browser";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ServerProvider,
} from "@t3tools/contracts";

import "~/index.css";

import { render } from "../../../test/render";
import type { FleetEngineFailure } from "../../state/fleetEngine";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { ChatBannerLane } from "./ChatBannerLane";
import {
  getProviderStatusBannerKey,
  getProviderStatusDismissalKey,
  isProviderStatusBannerDismissedForSession,
} from "./ProviderStatusBanner";
import { isThreadErrorBannerDismissedForSession } from "./ThreadErrorBanner";

const state = vi.hoisted(() => ({ refresh: vi.fn(async () => undefined) }));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => true }));
vi.mock("../../state/server", () => ({
  serverEnvironment: { refreshProviders: { permissionAtom: () => null } },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.refresh }));

useMode(modeRgb);
useMode(modeOklch);
const toRgb = converter("rgb");

function resolvedCssVariable(variable: string): string {
  const probe = document.createElement("div");
  probe.style.color = `var(${variable})`;
  document.body.append(probe);
  try {
    return getComputedStyle(probe).color;
  } finally {
    probe.remove();
  }
}

function expectSameColor(actual: string, expected: string, label: string) {
  const expectedRgb = toRgb(expected)!;
  const actualRgb = toRgb(actual)!;
  [expectedRgb.r, expectedRgb.g, expectedRgb.b].forEach((channel, index) => {
    expect(
      Math.abs(channel * 255 - [actualRgb.r, actualRgb.g, actualRgb.b][index]! * 255),
      `${label} channel ${index}`,
    ).toBeLessThan(1.5);
  });
}

function contrastRatio(first: string, second: string): number {
  const luminance = (value: string) => {
    const rgb = toRgb(value)!;
    return [rgb.r, rgb.g, rgb.b]
      .map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4))
      .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index]!, 0);
  };
  const firstL = luminance(first);
  const secondL = luminance(second);
  return (Math.max(firstL, secondL) + 0.05) / (Math.min(firstL, secondL) + 0.05);
}

const engineFailure: FleetEngineFailure = {
  kind: "unreachable",
  title: "连不上机群服务",
  description: "机群服务没有响应，请重试，或去 设置 → 连接 查看。",
};

function warningProvider(message = "连接在路由上"): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("codex-warning"),
    driver: ProviderDriverKind.make("codex"),
    displayName: "Codex",
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "warning",
    auth: { status: "authenticated" },
    checkedAt: "2026-11-24T00:00:00Z",
    message,
    models: [],
    skills: [],
    slashCommands: [],
  };
}

function LaneHarness({
  providerStatus = null,
  error = null,
  engine = null,
  fleetEngineRetrying = false,
}: {
  readonly providerStatus?: ServerProvider | null;
  readonly error?: string | null;
  readonly engine?: FleetEngineFailure | null;
  readonly fleetEngineRetrying?: boolean;
}) {
  const [threadError, setThreadError] = useState<string | null>(error);
  const [, setDismissTick] = useState(0);
  const environmentId = EnvironmentId.make("env-banner");
  return (
    <div>
      <div data-testid="timeline">messages</div>
      <ChatBannerLane
        environmentId={environmentId}
        fleetEngineFailure={engine}
        fleetEngineRetrying={fleetEngineRetrying}
        onRetryFleetEngine={() => undefined}
        onOpenFleetConnectionsSettings={() => undefined}
        onDismissFleetEngineFailure={() => undefined}
        providerStatus={providerStatus}
        providerStatusDismissalKey={getProviderStatusDismissalKey("env-banner", providerStatus)}
        onOpenProviderSetup={() => undefined}
        threadId={ThreadId.make("thread-banner")}
        threadError={threadError}
        threadErrorClass={null}
        threadErrorCode={null}
        threadErrorBannerKey={threadError === null ? null : `thread-banner\u0000${threadError}`}
        setThreadError={(_threadId, next) => setThreadError(next)}
        setThreadErrorBannerDismissTick={setDismissTick}
      />
      <div data-testid="composer">input</div>
    </div>
  );
}

describe("alert fleet styling", () => {
  it.each(["light", "dark"] as const)(
    "paints a neutral %s strip with only the icon carrying the danger colour",
    async (appearance) => {
      const root = document.documentElement;
      using _theme = {
        [Symbol.dispose]: () => {
          root.classList.remove("dark");
          delete root.dataset.theme;
        },
      };
      root.classList.toggle("dark", appearance === "dark");
      root.dataset.theme = appearance;
      await using screen = await render(
        <Alert variant="error" controlAlignment="first-line">
          <CircleAlertIcon />
          <AlertTitle>连不上机群服务</AlertTitle>
          <AlertDescription>机群服务没有响应，请重试，或去 设置 → 连接 查看。</AlertDescription>
        </Alert>,
      );

      const strip = screen.getByRole("alert").element();
      const style = getComputedStyle(strip);
      expectSameColor(style.backgroundColor, resolvedCssVariable("--fa-panel"), "strip surface");
      expect(style.borderRadius).toBe(
        getComputedStyle(document.documentElement).getPropertyValue("--fa-radius-md").trim(),
      );
      expect(style.minHeight).toBe(
        getComputedStyle(document.documentElement).getPropertyValue("--fa-ctrl-lg").trim(),
      );
      expect(style.position).toBe("static");

      const title = strip.querySelector<HTMLElement>('[data-slot="alert-title"]')!;
      const description = strip.querySelector<HTMLElement>('[data-slot="alert-description"]')!;
      const icon = strip.querySelector<SVGElement>("svg")!;
      expectSameColor(getComputedStyle(title).color, resolvedCssVariable("--fa-fg"), "title");
      expectSameColor(
        getComputedStyle(description).color,
        resolvedCssVariable("--fa-fg-muted"),
        "description",
      );
      expectSameColor(getComputedStyle(icon).color, resolvedCssVariable("--fa-danger"), "icon");
      expect(getComputedStyle(title).fontSize).toBe("14px");
      expect(getComputedStyle(title).fontWeight).toBe("500");
      expect(
        contrastRatio(getComputedStyle(description).color, style.backgroundColor),
        `${appearance} description contrast`,
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrastRatio(getComputedStyle(title).color, style.backgroundColor),
        `${appearance} title contrast`,
      ).toBeGreaterThanOrEqual(4.5);
    },
  );

  it.each([
    ["error", "--fa-danger"],
    ["warning", "--fa-warning"],
    ["info", "--fa-info"],
    ["success", "--fa-success"],
  ] as const)("gives an icon-less %s alert its own %s marker", async (variant, colorVariable) => {
    await using screen = await render(
      <Alert variant={variant}>
        <AlertDescription>没有自带图标的提示</AlertDescription>
      </Alert>,
    );
    const icon = screen.getByRole("alert").element().querySelector<SVGElement>("svg")!;
    expect(icon).not.toBeNull();
    expect(icon.getAttribute("aria-hidden")).toBe("true");
    expectSameColor(
      getComputedStyle(icon).color,
      resolvedCssVariable(colorVariable),
      "default marker",
    );
  });

  it("keeps the default variant neutral, with no semantic icon colour", async () => {
    await using screen = await render(
      <Alert variant="default">
        <CircleAlertIcon />
        <AlertDescription>普通提示</AlertDescription>
      </Alert>,
    );
    const strip = screen.getByRole("alert").element();
    expectSameColor(
      getComputedStyle(strip).backgroundColor,
      resolvedCssVariable("--fa-panel"),
      "default surface",
    );
    expectSameColor(
      getComputedStyle(strip.querySelector<SVGElement>("svg")!).color,
      resolvedCssVariable("--fa-fg-muted"),
      "default icon",
    );
  });
});

describe("chat banner lane", () => {
  it("sits in flow between the message list and the composer", async () => {
    await using screen = await render(<LaneHarness engine={engineFailure} />);
    const timeline = screen.getByTestId("timeline").element();
    const strip = screen.getByRole("alert").element();
    const composer = screen.getByTestId("composer").element();
    expect(timeline.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(strip.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(getComputedStyle(strip).position).toBe("static");
    expect(screen.container.textContent).toContain(
      "机群服务没有响应，请重试，或去 设置 → 连接 查看。",
    );
  });

  it("takes no space once every banner is dismissed", async () => {
    await using screen = await render(<LaneHarness error="这一轮失败了。" />);
    await expect.element(screen.getByRole("alert")).toBeVisible();
    expect(screen.getByRole("alert").element().textContent).toContain("智能体出错了");
    await userEvent.click(screen.getByRole("button", { name: "关闭错误" }));
    await expect.element(screen.getByTestId("timeline")).toBeVisible();
    expect(screen.container.querySelector('[data-slot="chat-banner-lane"]')).toBeNull();
    expect(isThreadErrorBannerDismissedForSession("thread-banner\u0000这一轮失败了。")).toBe(true);
  });

  it("shows the newest error first and folds the rest into a summary row", async () => {
    await using screen = await render(
      <LaneHarness
        engine={engineFailure}
        error="这一轮失败了。"
        providerStatus={warningProvider()}
      />,
    );

    const lane = screen.container.querySelector<HTMLElement>('[data-slot="chat-banner-lane"]')!;
    // Engine error appeared first, thread error second, so the thread error leads.
    expect(lane.querySelectorAll('[data-slot="alert"]')).toHaveLength(1);
    expect(lane.querySelector('[data-slot="alert"]')!.textContent).toContain("智能体出错了");
    const summary = screen.getByRole("button", { name: "还有 2 条" });
    await expect.element(summary).toBeVisible();

    await userEvent.click(summary);
    expect(lane.querySelectorAll('[data-slot="alert"]')).toHaveLength(3);
    const text = lane.textContent!;
    expect(text.indexOf("智能体出错了")).toBeLessThan(text.indexOf("连不上机群服务"));
    expect(text.indexOf("连不上机群服务")).toBeLessThan(text.indexOf("Codex 出错了"));
    expect(screen.getByRole("button", { name: "收起" })).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "收起" }));
    expect(lane.querySelectorAll('[data-slot="alert"]')).toHaveLength(1);
    await expect.element(screen.getByRole("button", { name: "还有 2 条" })).toBeVisible();
  });

  it("does not overflow a 390px viewport and keeps its buttons on screen", async () => {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    await page.viewport(390, 844);
    await using _viewport = {
      [Symbol.asyncDispose]: () => page.viewport(viewport.width, viewport.height),
    };
    await using screen = await render(
      <LaneHarness
        providerStatus={warningProvider(
          "这个智能体的模型列表还没有准备好，稍后刷新就会补上，若一直如此请打开智能体设置检查登录状态。",
        )}
      />,
    );

    const strip = screen.getByRole("alert").element();
    const close = screen.getByRole("button", { name: "关闭 Codex 提示（warning）" });
    await vi.waitFor(() => {
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
      expect(strip.getBoundingClientRect().width).toBeLessThanOrEqual(390);
      expect(close.element().getBoundingClientRect().right).toBeLessThanOrEqual(390);
    });
    expect(strip.scrollWidth).toBeLessThanOrEqual(strip.clientWidth + 1);
  });

  it("renders 28px banner action buttons with >=44px coarse hit targets and retrying feedback at 390px", async () => {
    const prev = { width: window.innerWidth, height: window.innerHeight };
    const session = cdp();
    await page.viewport(390, 844);
    await session.send("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: true,
    });
    await session.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    await session.send("Emulation.setEmulatedMedia", {
      features: [
        { name: "pointer", value: "coarse" },
        { name: "hover", value: "none" },
      ],
    });
    await using _pointer = {
      async [Symbol.asyncDispose]() {
        await session.send("Emulation.setEmulatedMedia", { features: [] });
        await session.send("Emulation.setTouchEmulationEnabled", { enabled: false });
        await session.send("Emulation.clearDeviceMetricsOverride");
        await page.viewport(prev.width, prev.height);
      },
    };

    await using screen = await render(<LaneHarness engine={engineFailure} />);
    await vi.waitFor(() => expect(window.matchMedia("(pointer: coarse)").matches).toBe(true));

    const strip = screen.getByRole("alert").element();
    const retryBtn = screen.getByRole("button", { name: "重试" }).element() as HTMLButtonElement;
    const settingsBtn = screen
      .getByRole("button", { name: "去 设置 → 连接 查看" })
      .element() as HTMLButtonElement;

    await vi.waitFor(() => {
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
      expect(strip.getBoundingClientRect().width).toBeLessThanOrEqual(390);
      expect(Math.round(retryBtn.getBoundingClientRect().height)).toBe(28);
      expect(Math.round(settingsBtn.getBoundingClientRect().height)).toBe(28);
    });
    expect(
      Number.parseFloat(getComputedStyle(retryBtn, "::after").minHeight),
    ).toBeGreaterThanOrEqual(44);
    expect(
      Number.parseFloat(getComputedStyle(settingsBtn, "::after").minHeight),
    ).toBeGreaterThanOrEqual(44);
    // The hit area reaches 20px above and below the 28px button, so a thumb that misses the
    // painted edge still lands on the button.
    for (const button of [retryBtn, settingsBtn]) {
      const rect = button.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      for (const dy of [-20, 20]) {
        const hit = document.elementFromPoint(x, rect.top + rect.height / 2 + dy);
        expect(hit === button || button.contains(hit)).toBe(true);
      }
    }

    await screen.rerender(<LaneHarness engine={engineFailure} fleetEngineRetrying />);
    const retryingBtn = screen
      .getByRole("button", { name: "正在重试…" })
      .element() as HTMLButtonElement;
    expect(retryingBtn.disabled).toBe(true);
    expect(Math.round(retryingBtn.getBoundingClientRect().height)).toBe(28);
  });

  it("keeps the provider warning's alert role and its dismissal key", async () => {
    const provider = warningProvider();
    await using screen = await render(<LaneHarness providerStatus={provider} />);
    const strip = screen.getByText("Codex 出错了").element().closest("[data-slot=alert]")!;
    expect(strip.getAttribute("role")).toBe("alert");
    expect(getProviderStatusBannerKey(provider)).not.toBeNull();
    expect(
      isProviderStatusBannerDismissedForSession(
        getProviderStatusDismissalKey("env-banner", provider),
      ),
    ).toBe(false);
  });
});

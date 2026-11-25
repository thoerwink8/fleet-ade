import "~/index.css";
import { page, userEvent } from "vite-plus/test/browser";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
import { FleetBoardPage } from "./FleetBoardPage";

const mocks = vi.hoisted(() => ({
  identities: [{ environmentId: "env-a", label: "这台机器" }],
  environments: [
    {
      environmentId: "env-a",
      connection: { phase: "connected", error: null as string | null },
      serverConfig: null,
    },
  ],
  readableIds: ["env-a"] as string[],
  sessionState: { data: {} as Record<string, unknown> | null, hasError: false, isPending: false },
  retrySummary: vi.fn(async () => {}),
  retrySession: vi.fn(),
  summary: {
    epoch: 0,
    status: "live",
    sourceId: "env-a",
    cursor: 1,
    rows: new Map([
      [
        "adhoc\nenv-a\nthread-1",
        {
          environmentId: "env-a",
          threadId: "thread-1",
          title: "修机群看板",
          phase: "working",
          reason: "",
          needsYou: false,
          lastProgress: "正在写页面",
          updatedAt: "2026-11-20T10:00:00.000Z",
          stale: false,
          revision: 1,
        },
      ],
    ]),
    pending: null,
    eventBuffer: [],
    error: null as string | null,
  },
}));

function setup(overrides?: {
  label?: string;
  phase?: string;
  error?: string | null;
  readableIds?: string[];
  sessionState?: { data: Record<string, unknown> | null; hasError: boolean; isPending: boolean };
  rows?: Map<string, unknown>;
  summaryStatus?: string;
}) {
  mocks.identities = [{ environmentId: "env-a", label: overrides?.label ?? "这台机器" }];
  mocks.environments = [
    {
      environmentId: "env-a",
      connection: {
        phase: overrides?.phase ?? "connected",
        error: overrides?.error ?? null,
      },
      serverConfig: null,
    },
  ];
  mocks.readableIds = overrides?.readableIds ?? ["env-a"];
  mocks.sessionState = overrides?.sessionState ?? { data: {}, hasError: false, isPending: false };
  mocks.summary.status = overrides?.summaryStatus ?? "live";
  mocks.summary.rows =
    (overrides?.rows as typeof mocks.summary.rows | undefined) ??
    new Map([
      [
        "adhoc\nenv-a\nthread-1",
        {
          environmentId: "env-a",
          threadId: "thread-1",
          title: "修机群看板",
          phase: "working",
          reason: "",
          needsYou: false,
          lastProgress: "正在写页面",
          updatedAt: "2026-11-20T10:00:00.000Z",
          stale: false,
          revision: 1,
        },
      ],
    ]);
  mocks.retrySummary.mockClear();
  mocks.retrySession.mockClear();
}

vi.mock("~/state/fleetSummary", () => ({
  useFleetSummary: () => mocks.summary as never,
  useFleetSummaryRetry: () => mocks.retrySummary,
}));

vi.mock("~/state/environments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/environments")>()),
  useEnvironmentIdentities: () => mocks.identities,
  useEnvironments: () => ({
    environments: mocks.environments,
  }),
  usePrimaryEnvironmentId: () => "env-a",
}));

vi.mock("~/state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/session")>()),
  useEnvironmentsWithScope: () => new Set(mocks.readableIds),
  useEnvironmentSessionState: () => mocks.sessionState,
  useEnvironmentSessionRetry: () => mocks.retrySession,
}));
vi.mock("~/state/peerLinks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/peerLinks")>()),
  useLinkedEnvironments: () => new Map(),
}));

vi.mock("~/state/entities", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/entities")>()),
  useServerConfigs: () => new Map(),
  useThreadShell: () => ({ branch: "main", linkedPullRequest: null, branchPullRequest: null }),
}));

vi.mock("~/hooks/useSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/hooks/useSettings")>()),
  useClientSettings: (selector: (settings: unknown) => unknown) => selector({}),
}));

it("syncs the row drawer with ?row and restores focus on back, Esc, and close button", async () => {
  await page.viewport(1280, 800);
  setup();
  await using screen = await render(<FleetBoardPage />, { router: "/fleet" });
  const router = screen.router;
  if (router === undefined) throw new Error("the test router is missing");

  const rowButton = page.getByRole("button", { name: /修机群看板/ });
  await rowButton.click();

  expect(router.latestLocation.search.row).toBe("adhoc\nenv-a\nthread-1");
  await expect.element(page.getByRole("dialog", { name: "修机群看板" })).toBeVisible();

  router.history.back();

  await expect.element(page.getByRole("dialog", { name: "修机群看板" })).not.toBeInTheDocument();
  expect(router.latestLocation.search.row).toBeUndefined();
  await expect.element(rowButton).toHaveFocus();

  await rowButton.click();
  await expect.element(page.getByRole("dialog", { name: "修机群看板" })).toBeVisible();

  await userEvent.keyboard("{Escape}");

  await expect.element(page.getByRole("dialog", { name: "修机群看板" })).not.toBeInTheDocument();
  expect(router.latestLocation.search.row).toBeUndefined();
  await expect.element(rowButton).toHaveFocus();

  await rowButton.click();
  const dialog = page.getByRole("dialog", { name: "修机群看板" });
  await expect.element(dialog).toBeVisible();

  await dialog.getByRole("button", { name: "关闭" }).click();

  await expect.element(dialog).not.toBeInTheDocument();
  expect(router.latestLocation.search.row).toBeUndefined();
  await expect.element(rowButton).toHaveFocus();
});

it("shows the missing-permission empty state when connection fails for orchestration:read", async () => {
  setup({
    phase: "error",
    error: "The authenticated token is missing required scope: orchestration:read.",
    readableIds: [],
    sessionState: { data: null, hasError: false, isPending: false },
    rows: new Map(),
    summaryStatus: "loading",
  });

  await using _screen = await render(<FleetBoardPage />, { router: "/fleet" });
  await expect.element(page.getByText("这个连接没有读取会话的权限，看不到机群汇总")).toBeVisible();
});

it("shows the disconnected source state instead of loading when offline and no rows", async () => {
  setup({
    label: "远端机",
    phase: "offline",
    readableIds: [],
    sessionState: { data: null, hasError: false, isPending: false },
    rows: new Map(),
    summaryStatus: "loading",
  });

  await using _screen = await render(<FleetBoardPage />, { router: "/fleet" });
  await expect.element(page.getByText("汇总电脑 远端机 连不上")).toBeVisible();
  await expect.element(page.getByText("连不上", { exact: true })).toBeVisible();
  await expect.element(page.getByRole("link", { name: "去连接" })).toBeVisible();
});

it("shows the read error retry state instead of missing-permission when session fetch fails", async () => {
  setup({
    phase: "connected",
    readableIds: [],
    sessionState: { data: null, hasError: true, isPending: false },
    rows: new Map(),
    summaryStatus: "loading",
  });

  await using _screen = await render(<FleetBoardPage />, { router: "/fleet" });
  await expect.element(page.getByText("读不到机群汇总")).toBeVisible();
  const retryButton = page.getByRole("button", { name: "重试" });
  await expect.element(retryButton).toBeVisible();
  await retryButton.click();
  expect(mocks.retrySession).toHaveBeenCalledTimes(1);
  expect(mocks.retrySummary).not.toHaveBeenCalled();
});

it("clears q alongside filters when clicking 清除筛选", async () => {
  await page.viewport(1280, 800);
  setup();
  await using screen = await render(<FleetBoardPage />, { router: "/fleet?q=不存在的词xyz999" });
  const router = screen.router;
  if (router === undefined) throw new Error("the test router is missing");

  await expect.element(page.getByText("没有符合筛选的")).toBeVisible();
  await page.getByRole("button", { name: "清除筛选" }).click();

  expect(router.latestLocation.search.q).toBeUndefined();
  await expect.element(page.getByRole("button", { name: /修机群看板/ })).toBeVisible();
});

it("hides the loading badge and search box on zero-environment, forbidden, and read-error empty states", async () => {
  setup({ readableIds: [], rows: new Map(), summaryStatus: "loading" });
  mocks.environments = [];
  await using screenZero = await render(<FleetBoardPage />, { router: "/fleet" });
  await expect.element(page.getByText("还没有连上的电脑")).toBeVisible();
  await expect.element(page.getByText("正在读取")).not.toBeInTheDocument();
  await expect
    .element(page.getByRole("searchbox", { name: "搜索机群任务" }))
    .not.toBeInTheDocument();
  await screenZero[Symbol.asyncDispose]();

  setup({
    phase: "error",
    error: "The authenticated token is missing required scope: orchestration:read.",
    readableIds: [],
    sessionState: { data: null, hasError: false, isPending: false },
    rows: new Map(),
    summaryStatus: "loading",
  });
  await using screenForbidden = await render(<FleetBoardPage />, { router: "/fleet" });
  await expect.element(page.getByText("这个连接没有读取会话的权限，看不到机群汇总")).toBeVisible();
  await expect.element(page.getByText("正在读取")).not.toBeInTheDocument();
  await expect
    .element(page.getByRole("searchbox", { name: "搜索机群任务" }))
    .not.toBeInTheDocument();
  await screenForbidden[Symbol.asyncDispose]();

  setup({
    phase: "connected",
    readableIds: [],
    sessionState: { data: null, hasError: true, isPending: false },
    rows: new Map(),
    summaryStatus: "loading",
  });
  await using _screenError = await render(<FleetBoardPage />, { router: "/fleet" });
  await expect.element(page.getByText("读不到机群汇总")).toBeVisible();
  await expect.element(page.getByText("正在读取")).not.toBeInTheDocument();
  await expect
    .element(page.getByRole("searchbox", { name: "搜索机群任务" }))
    .not.toBeInTheDocument();
});

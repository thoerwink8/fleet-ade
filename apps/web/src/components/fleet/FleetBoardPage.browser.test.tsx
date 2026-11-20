import { page, userEvent } from "vite-plus/test/browser";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { FleetBoardPage } from "./FleetBoardPage";

const mocks = vi.hoisted(() => ({
  environments: [
    {
      environmentId: "env-a",
      connection: { phase: "connected", error: null as string | null },
      serverConfig: null,
    },
  ],
  readableIds: ["env-a"] as string[],
  sessionState: { data: {} as Record<string, unknown> | null, hasError: false, isPending: false },
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

vi.mock("~/state/fleetSummary", () => ({
  useFleetSummary: () => mocks.summary as never,
  useFleetSummaryRetry: () => async () => {},
}));

vi.mock("~/state/environments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/environments")>()),
  useEnvironmentIdentities: () => [{ environmentId: "env-a", label: "这台机器" }],
  useEnvironments: () => ({
    environments: mocks.environments,
  }),
  usePrimaryEnvironmentId: () => "env-a",
}));

vi.mock("~/state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/session")>()),
  useEnvironmentsWithScope: () => new Set(mocks.readableIds),
  useEnvironmentSessionState: () => mocks.sessionState,
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

it("syncs the row drawer with ?row and restores focus on back and Esc", async () => {
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
});

it("shows the missing-permission empty state when connection fails for orchestration:read", async () => {
  const prevEnvironments = mocks.environments;
  const prevReadableIds = mocks.readableIds;
  const prevSessionState = mocks.sessionState;
  const prevRows = mocks.summary.rows;
  const prevStatus = mocks.summary.status;
  try {
    mocks.environments = [
      {
        environmentId: "env-a",
        connection: {
          phase: "error",
          error: "The authenticated token is missing required scope: orchestration:read.",
        },
        serverConfig: null,
      },
    ];
    mocks.readableIds = [];
    mocks.sessionState = { data: null, hasError: false, isPending: false };
    mocks.summary.rows = new Map();
    mocks.summary.status = "loading";

    await using _screen = await render(<FleetBoardPage />, { router: "/fleet" });
    await expect
      .element(page.getByText("这个连接没有读取会话的权限，看不到机群汇总"))
      .toBeVisible();
  } finally {
    mocks.environments = prevEnvironments;
    mocks.readableIds = prevReadableIds;
    mocks.sessionState = prevSessionState;
    mocks.summary.rows = prevRows;
    mocks.summary.status = prevStatus;
  }
});

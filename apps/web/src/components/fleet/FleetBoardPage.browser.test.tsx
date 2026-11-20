import { page } from "vite-plus/test/browser";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { FleetBoardPage } from "./FleetBoardPage";

const mocks = vi.hoisted(() => ({
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
    error: null,
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
    environments: [
      {
        environmentId: "env-a",
        connection: { phase: "connected" },
        serverConfig: null,
      },
    ],
  }),
  usePrimaryEnvironmentId: () => "env-a",
}));

vi.mock("~/state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/session")>()),
  useEnvironmentsWithScope: () => new Set(["env-a"]),
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

it("syncs the row drawer with ?row and browser back", async () => {
  await using screen = await render(<FleetBoardPage />, { router: "/fleet" });
  const router = screen.router;
  if (router === undefined) throw new Error("the test router is missing");

  await page.getByRole("button", { name: /修机群看板/ }).click();

  expect(router.latestLocation.search.row).toBe("adhoc\nenv-a\nthread-1");
  await expect.element(page.getByRole("dialog", { name: "修机群看板" })).toBeVisible();

  router.history.back();

  await expect.element(page.getByRole("dialog", { name: "修机群看板" })).not.toBeInTheDocument();
  expect(router.latestLocation.search.row).toBeUndefined();
});

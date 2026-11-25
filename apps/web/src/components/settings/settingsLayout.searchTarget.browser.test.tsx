import "~/index.css";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { SettingsPageContainer, SettingsSearchTarget } from "./settingsLayout";

it("keeps the other search params when it clears a handled target hash", async () => {
  const rootRoute = createRootRoute();
  const providersRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "settings/providers",
    component: () => (
      <SettingsPageContainer>
        <SettingsSearchTarget id="provider-instance-claudeAgent-status">状态</SettingsSearchTarget>
      </SettingsPageContainer>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([providersRoute]),
    history: createMemoryHistory({
      initialEntries: [
        "/settings/providers?environmentId=env-1&instanceId=claudeAgent#provider-instance-claudeAgent-status",
      ],
    }),
    disableGlobalCatchBoundary: true,
  });
  await using _screen = await render(<RouterProvider router={router} />, { router: false });

  await vi.waitFor(() => expect(router.state.location.hash).toBe(""));
  expect(router.state.location.search).toEqual({
    environmentId: "env-1",
    instanceId: "claudeAgent",
  });
});

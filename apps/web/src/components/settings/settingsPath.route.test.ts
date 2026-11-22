import { createMemoryHistory, createRouter } from "@tanstack/react-router";
import { describe, expect, it } from "vite-plus/test";

import { routeTree } from "../../routeTree.gen";

function matchedRouteIds(pathname: string) {
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [pathname] }),
  });
  return router.getMatchedRoutes(pathname).matchedRoutes.map((route) => route.id);
}

describe("settings path routing", () => {
  it("gives a one-segment unknown settings path to the settings catch-all", () => {
    expect(matchedRouteIds("/settings/commander")).toEqual([
      "__root__",
      "/_chat",
      "/_chat/settings",
      "/_chat/settings/$section",
    ]);
  });

  it("keeps renamed paths that have no page file on the settings catch-all", () => {
    expect(matchedRouteIds("/settings/integrations")).toEqual([
      "__root__",
      "/_chat",
      "/_chat/settings",
      "/_chat/settings/$section",
    ]);
  });

  it("keeps real and renamed page files on their own routes", () => {
    expect(matchedRouteIds("/settings/general")).toEqual([
      "__root__",
      "/_chat",
      "/_chat/settings",
      "/_chat/settings/general",
    ]);
    expect(matchedRouteIds("/settings/about")).toEqual([
      "__root__",
      "/_chat",
      "/_chat/settings",
      "/_chat/settings/about",
    ]);
    expect(matchedRouteIds("/settings/providers")).toEqual([
      "__root__",
      "/_chat",
      "/_chat/settings",
      "/_chat/settings/providers",
    ]);
    expect(matchedRouteIds("/settings/open-source-licenses")).toEqual([
      "__root__",
      "/_chat",
      "/_chat/settings",
      "/_chat/settings/open-source-licenses",
    ]);
  });
});

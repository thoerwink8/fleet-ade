import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { describe, expect, it } from "vite-plus/test";

import { Route as FleetRoute } from "../../routes/_chat.fleet";

function matchedSearch(url: string) {
  const root = createRootRoute();
  const chat = createRoute({ getParentRoute: () => root, id: "_chat" });
  const fleet = createRoute({
    getParentRoute: () => chat,
    path: "fleet",
    validateSearch: FleetRoute.options.validateSearch,
  });
  const router = createRouter({
    routeTree: root.addChildren([chat.addChildren([fleet])]),
    history: createMemoryHistory({ initialEntries: [url] }),
  });
  // useSearch reads matched-route search, which can differ from URL search.
  return router.matchRoutes(router.latestLocation).at(-1)?.search as
    | Record<string, unknown>
    | undefined;
}

describe("fleet route search", () => {
  it("drops a q the URL parser turned into a number", () => {
    expect(matchedSearch("/fleet?q=4089")?.q).toBeUndefined();
    expect(matchedSearch("/fleet?q=true")?.q).toBeUndefined();
  });

  it("keeps a q that is text, including a # issue lookup", () => {
    expect(matchedSearch("/fleet?q=%234089")?.q).toBe("#4089");
    expect(matchedSearch("/fleet?q=fix")?.q).toBe("fix");
  });

  it("keeps only known statuses", () => {
    expect(matchedSearch("/fleet?statuses=needsYou&statuses=bogus")?.statuses).toEqual([
      "needsYou",
    ]);
    expect(matchedSearch("/fleet?statuses=needsYou")?.statuses).toEqual(["needsYou"]);
  });

  it("drops non-string machine, source, and row values", () => {
    expect(matchedSearch("/fleet?machine=5")?.machine).toBeUndefined();
    expect(matchedSearch("/fleet?source=5")?.source).toBeUndefined();
    expect(matchedSearch("/fleet?row=5")?.row).toBeUndefined();
    expect(matchedSearch("/fleet?machine=machine-a&row=adhoc%0Amachine-a%0At1")).toEqual(
      expect.objectContaining({ machine: "machine-a", row: "adhoc\nmachine-a\nt1" }),
    );
  });
});

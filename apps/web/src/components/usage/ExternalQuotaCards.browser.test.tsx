import { describe, expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { ExternalQuotaCards } from "./ExternalQuotaCards";

describe("ExternalQuotaCards", () => {
  it("shows remaining quota and a read failure instead of a full bar", async () => {
    await using screen = await render(
      <ExternalQuotaCards
        pending={false}
        onRefresh={() => undefined}
        localLines={["Claude：12万 token"]}
        agy={{
          ok: true,
          groups: [
            {
              name: "Gemini",
              windows: [
                { label: "周额度", remainingPercent: 42, resetsAt: "2026-11-21T14:52:07Z" },
                { label: "5 小时额度", remainingPercent: 80, resetsAt: "2026-11-15T10:52:07Z" },
              ],
            },
          ],
        }}
        magpieQuotas={{ ok: false, message: "magpie 未运行" }}
        magpieUsage={{
          ok: true,
          agents: [{ name: "omp", calls: 2, tokens: 30_000, costUsd: 0.5 }],
          models: [],
        }}
      />,
    );

    await expect.element(screen.getByText(/周额度 剩余 42%/)).toBeVisible();
    await expect.element(screen.getByText(/5 小时额度 剩余 80%/)).toBeVisible();
    await expect.element(screen.getByText("magpie 未运行")).toBeVisible();
    await expect.element(screen.getByText("omp：调用 2，3万 token，花费 0.50 美元")).toBeVisible();
    await expect.element(screen.getByText("Claude：12万 token")).toBeVisible();
  });
});

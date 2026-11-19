import { describe, expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { ContextThresholdNotice } from "./ContextThresholdNotice";

describe("ContextThresholdNotice", () => {
  it("stays quiet below the threshold and shows used context once past it", async () => {
    await using below = await render(
      <ContextThresholdNotice
        usedTokens={40_000}
        maxTokens={200_000}
        autoCompactThreshold={null}
        config={{ contextThresholdPercent: "50" }}
        driver="claudeAgent"
      />,
    );
    await expect.element(below.getByText(/上下文 已用/)).not.toBeInTheDocument();
    await using past = await render(
      <ContextThresholdNotice
        usedTokens={120_000}
        maxTokens={200_000}
        autoCompactThreshold={null}
        config={{ contextThresholdPercent: "50" }}
        driver="claudeAgent"
      />,
    );
    await expect.element(past.getByText("上下文 已用 12万 / 阈值 10万")).toBeVisible();
  });

  it("asks to compact when Antigravity is past the threshold", async () => {
    await using screen = await render(
      <ContextThresholdNotice
        usedTokens={160_000}
        maxTokens={200_000}
        autoCompactThreshold={null}
        config={{}}
        driver="antigravity"
      />,
    );
    await expect
      .element(screen.getByText("上下文 已用 16万 / 阈值 10万。已超过阈值，建议压缩或新开一轮。"))
      .toBeVisible();
  });
});

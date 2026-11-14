import { describe, expect, it } from "vite-plus/test";

import { formatCompactDiffCount } from "./DiffStatLabel";

describe("formatCompactDiffCount", () => {
  it("promotes counts when rounding reaches the next suffix", () => {
    expect(formatCompactDiffCount(999_499)).toBe("999k");
    expect(formatCompactDiffCount(999_500)).toBe("1 分钟");
    expect(formatCompactDiffCount(999_499_999)).toBe("999 分钟");
    expect(formatCompactDiffCount(999_500_000)).toBe("1b");
  });
});

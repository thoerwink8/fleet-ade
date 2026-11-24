import { describe, expect, it } from "vite-plus/test";

const sources = import.meta.glob("./**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const productionSources = Object.entries(sources).filter(
  ([path]) => !/\.test\.tsx?$/.test(path) && !path.endsWith("confirmCopy.guard.test.ts"),
);

describe("confirmation copy", () => {
  it("never falls back to a generic title or a bare 确认 button", () => {
    expect(productionSources.length).toBeGreaterThan(100);
    const offenders = productionSources.flatMap(([path, text]) =>
      [/title:s*"确认操作"/, /confirmLabel:\s*"(确认|确定|好的|是)"/].flatMap((pattern) =>
        pattern.test(text) ? [`${path}: ${pattern}`] : [],
      ),
    );
    expect(offenders).toEqual([]);
  });
});

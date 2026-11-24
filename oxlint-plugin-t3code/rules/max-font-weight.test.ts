import { describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("t3code/max-font-weight", {
  filename: "apps/web/src/components/Example.tsx",
});

describe("t3code/max-font-weight", () => {
  rule.valid(
    "allows font weights at or below 500 and unrelated font utilities",
    `
      const el = (
        <div className="font-sans font-mono font-normal font-medium font-[400] font-[500] font-[normal] [font-weight:500] font-(family-name:--font-composer,var(--font-sans))">
          <span style={{ fontWeight: 400 }} />
          <span style={{ fontWeight: 500 }} />
          <span style={{ fontWeight: "normal" }} />
          <svg><text fontWeight="500">A</text></svg>
        </div>
      );
      node.style.cssText = "font-weight: 500;";
      node.style.fontWeight = "500";
    `,
  );

  rule.valid(
    "allows reasoned per-line exceptions",
    `
      const tokenStyle = {
        // oxlint-disable-next-line t3code/max-font-weight -- Shiki syntax highlighting bold token renders user/agent code content.
        fontWeight: 700,
      };
      // oxlint-disable-next-line t3code/max-font-weight -- Test fixture asserts the scanner catches heavy classes.
      const fixture = "font-semibold";
    `,
  );

  rule.invalid(
    "reports Tailwind named weight classes above 500",
    `<div className="font-semibold" />;`,
  );

  rule.invalid("reports font-bold", `<div className="font-bold" />;`);

  rule.invalid(
    "reports font-extrabold and font-black",
    `<div className="font-extrabold font-black" />;`,
  );

  rule.invalid(
    "reports variant-prefixed and important weight classes",
    `<div className="data-[active=true]:font-semibold *:[span]:font-semibold sm:font-bold !font-bold font-bold!" />;`,
  );

  rule.invalid(
    "reports arbitrary Tailwind font weight values above 500",
    `<div className="font-[600] font-[700] font-[weight:600] font-[bold] [font-weight:700]" />;`,
  );

  rule.invalid(
    "reports inline style objects with fontWeight above 500",
    `
      const a = <span style={{ fontWeight: 700 }} />;
      const b = <span style={{ fontWeight: "600" }} />;
      const c = <span style={{ fontWeight: "bold" }} />;
      const d = <span style={{ fontWeight: active ? 600 : 400 }} />;
    `,
  );

  rule.invalid(
    "reports SVG or JSX fontWeight attributes above 500",
    `const svg = <text fontWeight="700">A</text>;`,
  );

  rule.invalid(
    "reports inline CSS strings and style property writes above 500",
    `
      node.style.cssText = "font-weight: 600;";
      node.style.fontWeight = "bold";
      node.style.setProperty("font-weight", "700");
    `,
  );
});

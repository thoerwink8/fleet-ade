import { describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("t3code/no-text-13px", {
  filename: "apps/web/src/components/Example.tsx",
});

describe("t3code/no-text-13px", () => {
  rule.valid(
    "allows type scale sizes and other arbitrary pixel values",
    `
      const el = (
        <div className="text-2xs text-xs text-sm text-base text-[12px] text-[12.5px] text-[13.5px] text-[14px]">
          <span />
        </div>
      );
    `,
  );

  rule.valid(
    "allows reasoned per-line exceptions",
    `
      // oxlint-disable-next-line t3code/no-text-13px -- Test fixture asserts the scanner catches arbitrary 13px classes.
      const fixture = "text-[13px]";
    `,
  );

  rule.invalid("reports text-[13px]", `<div className="text-[13px]" />;`);

  rule.invalid(
    "reports variant-prefixed and important text-[13px]",
    `<div className="data-[active=true]:text-[13px] sm:text-[13px] !text-[13px] text-[13px]!" />;`,
  );

  rule.invalid(
    "reports text-[13px] inside conditional classes and template strings",
    `
      const a = <div className={active ? "text-[13px]" : "text-sm"} />;
      const b = <div className={\`grid text-sm \${active ? "md:hover:text-[13px]" : ""}\`} />;
    `,
  );
});

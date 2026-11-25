// @effect-diagnostics nodeBuiltinImport:off - scans real CSS stylesheets on disk.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, expect, it } from "@effect/vitest";

import { findCss13pxFontSizes } from "./no-text-13px.ts";
import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("t3code/no-text-13px", {
  filename: "apps/web/src/components/Example.tsx",
});

function countRuleReports(output: string): number {
  return output.match(/t3code\(no-text-13px\)/gu)?.length ?? 0;
}

function collectCssFiles(dir: string, out: string[]): void {
  for (const entry of NodeFS.readdirSync(dir, { withFileTypes: true })) {
    const full = NodePath.join(dir, entry.name);
    if (entry.isDirectory()) collectCssFiles(full, out);
    else if (entry.name.endsWith(".css")) out.push(full);
  }
}

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

  rule.valid(
    "allows same-name custom properties assigned standard sizes and 13px on non-font-size properties",
    `
      const cssOk = \`
        :root {
          --font-size-ui: 0.875rem;
          --text-ui: 14px;
          --line-height-ui: 0.8125rem;
          --my-gap: 13px;
          --my-width: 0.8125rem;
        }
        @theme inline {
          --text-ui: var(--font-size-ui);
          --text-ui--line-height: 13px;
        }
        /* :root { --font-size-ui: 0.8125rem; } .ignored { font-size: 13px; } */
        .ok {
          font-size: var(--font-size-ui);
          font: 400 12px/13px sans-serif;
          gap: 13px;
          width: 0.8125rem;
          padding: 13px;
        }
      \`;
      const twOk = (
        <div className="gap-[13px] w-[0.8125rem] [--my-gap:13px] [--font-size-ui:0.875rem] [font:400_12px/13px_sans-serif] text-(--icon-light)" />
      );
      const styleOk = (
        <div
          style={
            {
              "--font-size-ui": "0.875rem",
              "--my-gap": "13px",
              gap: "13px",
              width: "13px",
            } as React.CSSProperties
          }
        />
      );
      const canvasConfig = { fontSize: 13, lineHeight: 17 };
      node.style.setProperty("--font-size-ui", "0.875rem");
      node.style.setProperty("--my-gap", "13px");
      node.style.gap = "13px";
    `,
  );

  rule.invalid(
    "reports other spellings of 13px: line-height suffix, rem and length hint",
    `<div className="text-[13px]/5 text-[0.8125rem] text-[.8125rem] text-[length:13px] text-[13.0px]" />;`,
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

  rule.invalid(
    "reports Tailwind arbitrary CSS font-size, font shorthand, and font-size custom properties",
    `
      const a = <div className="[font-size:13px]" />;
      const b = <div className="[font-size:0.8125rem]" />;
      const c = <div className="[font:400_13px/20px_sans-serif]" />;
      const d = <div className="[--font-size-ui:0.8125rem]" />;
    `,
    (output) => {
      expect(countRuleReports(output)).toBe(4);
    },
  );

  rule.invalid(
    "reports inline CSS, font-size custom properties, and @theme text definitions at 13px",
    `
      const a = "font-size: 13px;";
      const b = "font: 400 0.8125rem/1.25rem sans-serif;";
      const c = ":root { --font-size-ui: 0.8125rem; }";
      const d = "@theme inline { --text-ui: 13px; }";
      const e = \`<div style="font-size: 0.8125rem">x</div>\`;
    `,
    (output) => {
      expect(countRuleReports(output)).toBe(5);
    },
  );

  rule.invalid(
    "reports inline React style objects, JSX fontSize attributes, and DOM style assignments at 13px",
    `
      const a = <div style={{ fontSize: "13px" }} />;
      const b = <div style={{ fontSize: 13 }} />;
      const c = <div style={{ font: "400 0.8125rem/20px sans-serif" }} />;
      const d = <div style={{ "--font-size-ui": "0.8125rem" } as React.CSSProperties} />;
      const e = <svg><text fontSize="13px">A</text></svg>;
      node.style.fontSize = "13px";
      node.style.setProperty("font-size", "0.8125rem");
      node.style.setProperty("--font-size-ui", "0.8125rem");
    `,
    (output) => {
      expect(countRuleReports(output)).toBe(8);
    },
  );
});

describe("CSS 13px font-size guard", () => {
  it("reports px, rem, font shorthand, and font/text/size custom properties at 13px while ignoring other properties", () => {
    const css = [
      ":root {",
      "  --font-size-ui: 0.8125rem;",
      "  --text-ui: 13px;",
      "  --item-size: .8125rem;",
      "  --font-size-ok: 0.875rem;",
      "  --line-height-ui: 0.8125rem;",
      "  --gap-13: 13px;",
      "}",
      "@theme inline {",
      "  --text-ui--line-height: 13px;",
      "  --text-row: var(--font-size-ok);",
      "}",
      "/* .ignored { font-size: 13px; --font-size-ui: 0.8125rem; } */",
      ".direct-px { font-size: 13px; }",
      ".direct-rem { font-size: .8125rem !important; }",
      ".shorthand-rem { font: italic 500 0.8125rem/1.25rem var(--fa-font-sans); }",
      ".ok-size { font-size: var(--font-size-ok); }",
      ".ok-shorthand-lh { font: 400 12px/13px var(--fa-font-sans); }",
      ".ok-non-font { gap: 13px; width: 0.8125rem; padding: 13px; }",
    ].join("\n");

    expect(findCss13pxFontSizes(css)).toEqual([
      { line: 2, declaration: "--font-size-ui: 0.8125rem" },
      { line: 3, declaration: "--text-ui: 13px" },
      { line: 4, declaration: "--item-size: .8125rem" },
      { line: 14, declaration: "font-size: 13px" },
      { line: 15, declaration: "font-size: .8125rem !important" },
      {
        line: 16,
        declaration: "font: italic 500 0.8125rem/1.25rem var(--fa-font-sans)",
      },
    ]);
  });

  it("enforces no 13px font sizes or font/text/size custom properties across all apps/web/src stylesheets", () => {
    const webSrcDir = NodeURL.fileURLToPath(new URL("../../apps/web/src", import.meta.url));
    const cssFiles: string[] = [];
    collectCssFiles(webSrcDir, cssFiles);
    cssFiles.sort();

    const violations = cssFiles.flatMap((file) => {
      const relative = NodePath.relative(webSrcDir, file).replaceAll("\\", "/");
      return findCss13pxFontSizes(NodeFS.readFileSync(file, "utf8")).map(
        (violation) => `${relative}:${violation.line} ${violation.declaration}`,
      );
    });

    expect(violations).toEqual([]);
  });
});

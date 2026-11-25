// @effect-diagnostics nodeBuiltinImport:off - scans real CSS stylesheets on disk.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, expect, it } from "@effect/vitest";

import {
  findCss13pxFontSizes,
  findCss13pxFontSizesInFiles,
  findCss13pxVariablesInFiles,
} from "./no-text-13px.ts";
import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("t3code/no-text-13px", {
  filename: "apps/web/src/components/Example.tsx",
});

function countRuleReports(output: string): number {
  return output.match(/t3code\(no-text-13px\)/gu)?.length ?? 0;
}

function collectFilesByExtension(dir: string, extension: string, out: string[]): void {
  for (const entry of NodeFS.readdirSync(dir, { withFileTypes: true })) {
    const full = NodePath.join(dir, entry.name);
    if (entry.isDirectory()) collectFilesByExtension(full, extension, out);
    else if (entry.name.endsWith(extension)) out.push(full);
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
          --my-gap: 13px;
          --my-width: 0.8125rem;
        }
        @theme inline {
          --text-ui: var(--font-size-ui);
          --text-ui--line-height: 13px;
        }
        /* :root { --font-size-ui: 0.8125rem; } .ignored { font-size: var(--font-size-ui); } */
        .ok {
          font-size: var(--font-size-ui);
          font: 400 12px/13px sans-serif;
          gap: var(--my-gap);
          width: var(--my-width);
          padding: 13px;
        }
      \`;
      const twOk = (
        <div className="gap-[13px] w-[0.8125rem] [--my-gap:13px] gap-(--my-gap) [--font-size-ui:0.875rem] text-(length:--font-size-ui) [font:400_12px/13px_sans-serif] text-(--icon-light)" />
      );
      const styleOk = (
        <div
          style={
            {
              "--font-size-ui": "0.875rem",
              "--my-gap": "13px",
              fontSize: "var(--font-size-ui)",
              gap: "var(--my-gap)",
              width: "13px",
            } as React.CSSProperties
          }
        />
      );
      const canvasConfig = { fontSize: 13, lineHeight: 17 };
      node.style.setProperty("--my-gap", "13px");
      node.style.gap = "var(--my-gap)";
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
    "reports Tailwind arbitrary CSS font-size, font shorthand, and custom-property text utilities",
    `
      const a = <div className="[font-size:13px]" />;
      const b = <div className="[font-size:0.8125rem]" />;
      const c = <div className="[font:400_13px/20px_sans-serif]" />;
      const d = <div className="[--sz:0.8125rem] text-(length:--sz)" />;
      const e = <div className={cn("[--sz:13px]", active && "text-(length:--sz)")} />;
    `,
    (output) => {
      expect(countRuleReports(output)).toBe(5);
    },
  );

  rule.invalid(
    "reports inline CSS, custom-property var() chains, and @theme text definitions at 13px",
    `
      const a = "font-size: 13px;";
      const b = "font: 400 0.8125rem/1.25rem sans-serif;";
      const c = \`
        :root { --font-size-ui: 0.8125rem; }
        .chat-command-text { font-size: var(--font-size-ui); }
      \`;
      const d = \`
        :root { --font-size-ui: 13px; }
        @theme inline { --text-ui: var(--font-size-ui); }
      \`;
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
      const d = <div style={{ "--font-size-ui": "0.8125rem", fontSize: "var(--font-size-ui)" } as React.CSSProperties} />;
      const e = <svg><text fontSize="13px">A</text></svg>;
      node.style.fontSize = "13px";
      node.style.setProperty("font-size", "0.8125rem");
      node.style.setProperty("--sz", "13px");
      node.style.fontSize = "var(--sz)";
    `,
    (output) => {
      expect(countRuleReports(output)).toBe(8);
    },
  );
});

describe("CSS 13px font-size guard", () => {
  it("reports px, rem, font shorthand, var() chains, fallbacks, and @theme text tokens resolving to 13px", () => {
    const css = [
      ":root {",
      "  --font-size-ui: 0.8125rem;",
      "  --alias-ui: var(--font-size-ui);",
      "  --font-size-ok: 0.875rem;",
      "  --gap-13: 13px;",
      "}",
      "@theme inline {",
      "  --text-ui: var(--font-size-ui);",
      "  --text-ui--line-height: 13px;",
      "  --text-row: var(--font-size-ok);",
      "}",
      "/* .ignored { font-size: 13px; } */",
      ".direct-px { font-size: 13px; }",
      ".direct-rem { font-size: .8125rem !important; }",
      ".shorthand-rem { font: italic 500 0.8125rem/1.25rem var(--fa-font-sans); }",
      ".var-chain { font-size: var(--alias-ui); }",
      ".fallback-13 { font-size: var(--missing-size, 13.0px); }",
      ".ok-size { font-size: var(--font-size-ok); }",
      ".ok-shorthand-lh { font: 400 12px/13px var(--fa-font-sans); }",
      ".ok-non-font { gap: var(--gap-13); width: 13px; padding: 0.8125rem; }",
    ].join("\n");

    expect(findCss13pxFontSizes(css)).toEqual([
      {
        line: 8,
        declaration: "--text-ui: var(--font-size-ui)",
        resolvedFrom: "--font-size-ui: 0.8125rem",
      },
      { line: 13, declaration: "font-size: 13px" },
      { line: 14, declaration: "font-size: .8125rem !important" },
      {
        line: 15,
        declaration: "font: italic 500 0.8125rem/1.25rem var(--fa-font-sans)",
      },
      {
        line: 16,
        declaration: "font-size: var(--alias-ui)",
        resolvedFrom: "--alias-ui -> --font-size-ui: 0.8125rem",
      },
      {
        line: 17,
        declaration: "font-size: var(--missing-size, 13.0px)",
        resolvedFrom: "13.0px",
      },
    ]);
  });

  it("tracks custom properties across CSS files and terminates on var() cycles", () => {
    const violations = findCss13pxFontSizesInFiles([
      {
        file: "tokens.css",
        css: ":root { --custom-ui: 0.8125rem; --cycle-a: var(--cycle-b); --cycle-b: var(--cycle-a); }",
      },
      {
        file: "component.css",
        css: ".row { font-size: var(--custom-ui); }\n.cycle { font-size: var(--cycle-a); }",
      },
    ]);

    expect(violations).toEqual([
      {
        file: "component.css",
        line: 1,
        declaration: "font-size: var(--custom-ui)",
        resolvedFrom: "--custom-ui: 0.8125rem",
      },
    ]);
  });

  it("enforces no 13px font sizes across all apps/web/src stylesheets and CSS custom properties", () => {
    const webSrcDir = NodeURL.fileURLToPath(new URL("../../apps/web/src", import.meta.url));
    const cssFiles: string[] = [];
    collectFilesByExtension(webSrcDir, ".css", cssFiles);
    cssFiles.sort();

    const loadedCss = cssFiles.map((file) => ({
      file: NodePath.relative(webSrcDir, file).replaceAll("\\", "/"),
      css: NodeFS.readFileSync(file, "utf8"),
    }));

    const violations = findCss13pxFontSizesInFiles(loadedCss).map((violation) =>
      violation.resolvedFrom
        ? `${violation.file}:${violation.line} ${violation.declaration} (${violation.resolvedFrom})`
        : `${violation.file}:${violation.line} ${violation.declaration}`,
    );

    const vars13px = findCss13pxVariablesInFiles(loadedCss);
    if (vars13px.size > 0) {
      const tsxFiles: string[] = [];
      collectFilesByExtension(webSrcDir, ".ts", tsxFiles);
      collectFilesByExtension(webSrcDir, ".tsx", tsxFiles);
      tsxFiles.sort();
      for (const file of tsxFiles) {
        const relative = NodePath.relative(webSrcDir, file).replaceAll("\\", "/");
        const lines = NodeFS.readFileSync(file, "utf8").split(/\r?\n/u);
        for (const [varName, resolved] of vars13px) {
          const escaped = varName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
          const sinkPattern = new RegExp(
            `(?:text-\\(length:${escaped}(?:\\s*,[^)]+)?\\)|text-\\[(?:length:)?var\\(${escaped}(?:\\s*,[^)]+)?\\)\\]|\\[font(?:-size)?:[^\\]]*var\\(${escaped}\\)|font-size\\s*:\\s*var\\(${escaped}|fontSize\\s*:\\s*["'\`]var\\(${escaped})`,
            "u",
          );
          for (const [index, line] of lines.entries()) {
            if (sinkPattern.test(line)) {
              violations.push(`${relative}:${index + 1} uses ${varName} (${resolved})`);
            }
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });
});

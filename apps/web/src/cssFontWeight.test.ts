// @effect-diagnostics nodeBuiltinImport:off - scans real CSS stylesheets on disk.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vite-plus/test";

export interface CssFontWeightViolation {
  readonly line: number;
  readonly declaration: string;
}

const HEAVY_VALUE = /^(?:bold|bolder|([1-9]\d{2,3}))$/iu;
const ALLOW_COMMENT = /^font-weight-allow:\s*(.+)$/isu;

export function findHeavyCssFontWeights(css: string): ReadonlyArray<CssFontWeightViolation> {
  const commentSpans: Array<{ readonly start: number; readonly end: number }> = [];
  const allowLines = new Set<number>();

  let line = 1;
  let index = 0;
  while (index < css.length) {
    const ch = css[index];
    if (ch === "\n") {
      line++;
      index++;
      continue;
    }
    if (ch === "/" && css[index + 1] === "*") {
      const start = index;
      const closeIndex = css.indexOf("*/", index + 2);
      const end = closeIndex === -1 ? css.length : closeIndex + 2;
      const body = css.slice(index + 2, closeIndex === -1 ? css.length : closeIndex);
      for (const char of css.slice(start, end)) {
        if (char === "\n") line++;
      }
      commentSpans.push({ start, end });
      const allowMatch = ALLOW_COMMENT.exec(body.trim());
      if (allowMatch && allowMatch[1]?.trim()) {
        allowLines.add(line);
      }
      index = end;
      continue;
    }
    index++;
  }

  let masked = "";
  let cursor = 0;
  for (const span of commentSpans) {
    masked += css.slice(cursor, span.start);
    masked += css.slice(span.start, span.end).replace(/[^\n]/gu, " ");
    cursor = span.end;
  }
  masked += css.slice(cursor);

  const violations: CssFontWeightViolation[] = [];
  const declarationPattern = /font-weight\s*:\s*([^;{}]+)/giu;
  for (
    let match = declarationPattern.exec(masked);
    match !== null;
    match = declarationPattern.exec(masked)
  ) {
    const rawValue = match[1]?.replace(/!\s*important\b/iu, "").trim() ?? "";
    const parsed = HEAVY_VALUE.exec(rawValue);
    if (!parsed) continue;
    if (parsed[1] !== undefined && Number(parsed[1]) <= 500) continue;

    let declarationLine = 1;
    for (let pos = 0; pos < match.index; pos++) {
      if (masked[pos] === "\n") declarationLine++;
    }
    if (allowLines.has(declarationLine) || allowLines.has(declarationLine - 1)) continue;
    violations.push({
      line: declarationLine,
      declaration: match[0].trim(),
    });
  }
  return violations;
}

function collectCssFiles(dir: string, out: string[]) {
  for (const entry of NodeFS.readdirSync(dir, { withFileTypes: true })) {
    const full = NodePath.join(dir, entry.name);
    if (entry.isDirectory()) collectCssFiles(full, out);
    else if (entry.name.endsWith(".css")) out.push(full);
  }
}

describe("CSS max font-weight guard", () => {
  it("reports CSS font-weight values above 500 and bold keywords", () => {
    const css = [
      ".ok { font-weight: 400; }",
      ".ok-medium { font-weight: 500; }",
      ".ok-normal { font-weight: normal; }",
      // oxlint-disable-next-line t3code/max-font-weight -- Test fixture verifies CSS comments are ignored.
      "/* .ignored { font-weight: 700; } */",
      // oxlint-disable-next-line t3code/max-font-weight -- Test fixture verifies the CSS scanner flags heavy weights.
      ".bad-600 { font-weight: 600; }",
      // oxlint-disable-next-line t3code/max-font-weight -- Test fixture verifies the CSS scanner flags bold keyword.
      ".bad-bold { font-weight: bold !important; }",
      // oxlint-disable-next-line t3code/max-font-weight -- Test fixture verifies the CSS scanner flags bolder keyword.
      ".bad-bolder { font-weight: bolder; }",
    ].join("\n");

    expect(findHeavyCssFontWeights(css)).toEqual([
      // oxlint-disable-next-line t3code/max-font-weight -- Expected output asserts CSS scanner catches 600.
      { line: 5, declaration: "font-weight: 600" },
      // oxlint-disable-next-line t3code/max-font-weight -- Expected output asserts CSS scanner catches bold.
      { line: 6, declaration: "font-weight: bold !important" },
      // oxlint-disable-next-line t3code/max-font-weight -- Expected output asserts CSS scanner catches bolder.
      { line: 7, declaration: "font-weight: bolder" },
    ]);
  });

  it("allows a declaration with a reasoned font-weight-allow comment and rejects empty reasons", () => {
    const css = [
      ".prose strong {",
      "  /* font-weight-allow: user and agent Markdown bold emphasis */",
      // oxlint-disable-next-line t3code/max-font-weight -- Test fixture verifies reasoned allow comment passes.
      "  font-weight: 600;",
      "}",
      ".unreasoned {",
      "  /* font-weight-allow:   */",
      // oxlint-disable-next-line t3code/max-font-weight -- Test fixture verifies empty reason is rejected.
      "  font-weight: 600;",
      "}",
    ].join("\n");

    // oxlint-disable-next-line t3code/max-font-weight -- Expected output asserts unreasoned 600 is reported.
    expect(findHeavyCssFontWeights(css)).toEqual([{ line: 7, declaration: "font-weight: 600" }]);
  });

  it("enforces max font-weight 500 across all apps/web/src stylesheets", () => {
    const webSrcDir = NodeURL.fileURLToPath(new URL(".", import.meta.url));
    const cssFiles: string[] = [];
    collectCssFiles(webSrcDir, cssFiles);
    cssFiles.sort();

    const violations = cssFiles.flatMap((file) => {
      const relative = NodePath.relative(webSrcDir, file).replaceAll("\\", "/");
      return findHeavyCssFontWeights(NodeFS.readFileSync(file, "utf8")).map(
        (violation) => `${relative}:${violation.line} ${violation.declaration}`,
      );
    });

    expect(violations).toEqual([]);
  });
});

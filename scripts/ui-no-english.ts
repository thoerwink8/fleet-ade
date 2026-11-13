// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
// Fails when user-visible interface copy still contains English outside the
// allowlist. Scope is the web UI, the desktop menu, server errors shown to
// users, and the modules that put sign-in or provider status text on screen. Logs,
// comments, developer CLI text, font names, and code identifiers are out of
// scope. Each allowlist line keeps one string; the comment above it is the
// reason. JSX text and UI string attributes are read from the syntax tree, so
// a phrase on its own line is not skipped.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import ts from "typescript-legacy";

const scriptDir = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const ROOT = process.argv[2] ?? process.cwd();
const ALLOWLIST_PATH = NodePath.join(scriptDir, "ui-english-allowlist.txt");
const ROOTS = [
  "apps/web/src",
  "apps/desktop/src/window",
  "apps/server/src/orchestration-v2/UserFacingErrors.ts",
  "apps/server/src/provider/AntigravityAuth.ts",
  "apps/server/src/provider/CodexChatGptAuth.ts",
  "apps/server/src/provider/CodexAuthCallbackPage.ts",
  "packages/shared/src/codexAuthCallback.ts",
  "packages/provider-core/src/server/providerAuthFlow.ts",
  "packages/provider-cursor/src/server/auth.ts",
  "packages/provider-cursor/src/server/status.ts",
  "packages/provider-cursor/src/server/textGeneration.ts",
  "packages/provider-acp-registry/src/server/auth.ts",
  "apps/server/src/provider/Drivers/CodexManagedProvider.ts",
];
const UI_NAMES = new Set([
  "title",
  "label",
  "placeholder",
  "aria-label",
  "aria-description",
  "aria-placeholder",
  "alt",
  "description",
  "tooltip",
  "heading",
  "emptyText",
  "hint",
  "caption",
  "subtitle",
  "detail",
  "helperText",
  "actionLabel",
  "buttonLabel",
  "confirmTitle",
  "confirmLabel",
  "dialogTitle",
  "dialogDescription",
  "searchPlaceholder",
  "statusText",
  "errorText",
  "empty",
  "footerActionLabel",
]);

interface AllowEntry {
  readonly phrase: string;
  readonly reason: string;
}

function loadAllowlist(file: string): ReadonlyArray<AllowEntry> {
  const lines = NodeFS.readFileSync(file, "utf8").split(/\r?\n/);
  const entries: AllowEntry[] = [];
  let reason: string | undefined;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (trimmed.startsWith("#")) {
      reason = trimmed.slice(1).trim();
      continue;
    }
    if (reason === undefined || reason === "") {
      throw new Error(`Allowlist entry without a reason comment: ${trimmed}`);
    }
    entries.push({ phrase: trimmed, reason });
    reason = undefined;
  }
  return entries.toSorted((left, right) => right.phrase.length - left.phrase.length);
}

function englishLeft(text: string, allowlist: ReadonlyArray<AllowEntry>): boolean {
  let rest = text;
  for (const entry of allowlist) {
    const pattern = new RegExp(entry.phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    rest = rest.replace(pattern, " ");
  }
  return /[A-Za-z]{3,}/.test(rest);
}

function isUserCopy(text: string, allowlist: ReadonlyArray<AllowEntry>): boolean {
  const plain = text
    .replace(/\$\{[^}]*\}/g, " ")
    .replace(/&(?:apos|rsquo|lsquo|quot);/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  if (plain.length < 3 || plain.length > 500) return false;
  if (
    /&&|\|\||=>|Readonly|Props|VariantProps|Promise|Atom\.|querySelector|Number\.|Date\.now|ComponentProps|:\s*string|Effect\.|byteLength/.test(
      plain,
    )
  ) {
    return false;
  }
  if (/^[()[\]|&,]/.test(plain) || /\bnew (?:Map|Set)\b|\bAtom\b|\bKeyboardEvent\b/.test(plain)) {
    return false;
  }
  if (!englishLeft(plain, allowlist)) return false;
  if (/^[a-z0-9_.:/\- ]+$/.test(plain)) return false;
  if (
    /^(?:oklch|rgba|rgb|hsla?)\(|var\(--|system-ui|ui-monospace|sans-serif|video\/|codecs=/.test(
      plain,
    )
  ) {
    return false;
  }
  if (
    /\b(?:flex|grid|absolute|relative|fixed|sticky|hidden|inline-|items-|justify-|px-|py-|gap-|border-|bg-|text-|sm:|lg:|max-sm:|min-w-|max-w-|overflow-|z-\d)/.test(
      plain,
    )
  ) {
    return false;
  }
  if (!/[A-Z\u4e00-\u9fff]/.test(plain)) return false;
  return / [A-Za-z]{3,}/.test(plain) || /[A-Za-z][.?!…]$/.test(plain);
}

function walk(dir: string, out: string[]): void {
  if (!NodeFS.existsSync(dir)) return;
  for (const entry of NodeFS.readdirSync(dir, { withFileTypes: true })) {
    const full = NodePath.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "i18n") continue;
      walk(full, out);
    } else out.push(full);
  }
}

function included(file: string): boolean {
  const rel = file.replaceAll("\\", "/");
  if (!/\.tsx?$/.test(rel) || rel.endsWith(".d.ts")) return false;
  if (/\.(?:test|browser\.test|stories)\./.test(rel)) return false;
  if (rel.endsWith(".gen.ts") || rel.includes("/_generated/")) return false;
  if (rel.endsWith("/appearanceFonts.ts") || rel.endsWith("/composer-code-languages.ts"))
    return false;
  return true;
}

function isLogCall(node: ts.CallExpression): boolean {
  if (!ts.isPropertyAccessExpression(node.expression)) return false;
  return /^log(?:Warning|Info|Error|Debug|Trace|Fatal)?$/.test(node.expression.name.text);
}

function literalText(node: ts.Expression): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isParenthesizedExpression(node)
  ) {
    return literalText(node.expression);
  }
  return undefined;
}

function propertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return undefined;
}

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

const allowlist = loadAllowlist(ALLOWLIST_PATH);
const files: string[] = [];
for (const root of ROOTS) {
  const full = NodePath.join(ROOT, root);
  if (root.endsWith(".ts")) {
    if (NodeFS.existsSync(full)) files.push(full);
  } else walk(full, files);
}

const findings: string[] = [];
for (const file of files.filter(included)) {
  const sourceText = NodeFS.readFileSync(file, "utf8");
  const source = ts.createSourceFile(
    file,
    sourceText,
    ts.ScriptTarget.Latest,
    false,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const rel = file.replaceAll("\\", "/");
  // These modules publish the sentence a person reads while signing in or out.
  // Their strings are not all object fields, so every literal is a candidate.
  const serverCopy =
    rel.endsWith("/UserFacingErrors.ts") ||
    rel.endsWith("/providerAuthFlow.ts") ||
    rel.endsWith("/provider-cursor/src/server/auth.ts") ||
    rel.endsWith("/provider-cursor/src/server/status.ts") ||
    rel.endsWith("/provider-cursor/src/server/textGeneration.ts") ||
    rel.endsWith("/provider-acp-registry/src/server/auth.ts") ||
    rel.endsWith("/CodexManagedProvider.ts") ||
    rel.endsWith("/CodexAuthCallbackPage.ts") ||
    rel.endsWith("/codexAuthCallback.ts") ||
    /\/provider\/[^/]*Auth\.ts$/.test(rel);
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    // Log calls are out of scope even when they sit in a sign-in module.
    if (ts.isCallExpression(node) && isLogCall(node)) return;
    const texts: string[] = [];
    if (serverCopy) {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        texts.push(node.text);
      }
    } else if (ts.isJsxText(node)) {
      texts.push(node.text);
    } else if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(source);
      const initializer = node.initializer;
      if (UI_NAMES.has(name) && initializer) {
        if (ts.isStringLiteral(initializer)) texts.push(initializer.text);
        else if (ts.isJsxExpression(initializer) && initializer.expression) {
          const text = literalText(initializer.expression);
          if (text !== undefined) texts.push(text);
        }
      }
    } else if (ts.isPropertyAssignment(node)) {
      const name = propertyName(node.name);
      if (name !== undefined && UI_NAMES.has(name)) {
        const text = literalText(node.initializer);
        if (text !== undefined) texts.push(text);
      }
    }
    for (const text of texts) {
      if (!isUserCopy(text, allowlist)) continue;
      findings.push(`${file}:${String(lineOf(source, node))}  ${text.trim()}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

const report = [`COUNT ${String(findings.length)}`, ...findings].join("\n");
const outPath = process.argv[3];
if (outPath) NodeFS.writeFileSync(outPath, report, "utf8");
console.log(`COUNT ${String(findings.length)}`);
if (findings.length > 0) {
  if (!outPath) {
    for (const finding of findings) console.log(finding);
  }
  process.exitCode = 1;
}

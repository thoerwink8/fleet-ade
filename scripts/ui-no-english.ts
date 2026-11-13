// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
// Fails when user-visible interface copy still contains English outside the
// allowlist. Scope is the web UI, the desktop menu, and server errors shown
// to users. Logs, comments, developer CLI text, font names, and code
// identifiers are out of scope. Each allowlist line keeps one string; the
// comment above it is the reason.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const scriptDir = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const ROOT = process.argv[2] ?? process.cwd();
const ALLOWLIST_PATH = NodePath.join(scriptDir, "ui-english-allowlist.txt");
const ROOTS = [
  "apps/web/src",
  "apps/desktop/src/window",
  "apps/server/src/orchestration-v2/UserFacingErrors.ts",
];
const LITERAL = /(["'`])((?:(?!\1)[^\\\n]|\\.)*)\1/g;
const UI_ATTR =
  /\b(?:title|label|placeholder|aria-label|aria-description|aria-placeholder|alt|description|tooltip|heading|emptyText|hint|caption|subtitle)="([^"]+)"/g;
const UI_PROP =
  /\b(?:title|label|placeholder|description|tooltip|heading|emptyText|hint|caption|subtitle|alt|detail|helperText|actionLabel|buttonLabel|confirmTitle|confirmLabel|dialogTitle|dialogDescription|searchPlaceholder|statusText|errorText|empty|footerActionLabel)\s*:\s*(["'`])([^"'`\n]+)\1/g;
const JSX_TEXT = />([^<>{}\n]*[A-Za-z][^<>{}\n]*)</g;
const SKIPPED_LINE =
  /^\s*(?:\/\/|\*|\/\*|import\b|export\s+(?:\*|type|\{))|\bclassName=|\bclassName:|https?:\/\/|console\.\w+\(|\.(?:log|debug|trace|logInfo|logWarning|logError|logDebug)\(/;

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

function unescapeLiteral(text: string): string {
  return text
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\(['"`\\])/g, "$1");
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
  const lines = NodeFS.readFileSync(file, "utf8").split(/\r?\n/);
  lines.forEach((line, index) => {
    if (SKIPPED_LINE.test(line)) return;
    const texts: string[] = [];
    const serverErrors = file.replaceAll("\\", "/").endsWith("/UserFacingErrors.ts");
    if (serverErrors) {
      for (const match of line.matchAll(LITERAL)) texts.push(unescapeLiteral(match[2] ?? ""));
    } else {
      for (const match of line.matchAll(UI_ATTR)) texts.push(match[1] ?? "");
      for (const match of line.matchAll(UI_PROP)) texts.push(match[2] ?? "");
      if (file.endsWith(".tsx")) {
        for (const match of line.matchAll(JSX_TEXT)) texts.push((match[1] ?? "").trim());
      }
    }
    for (const text of texts) {
      if (!isUserCopy(text, allowlist)) continue;
      findings.push(`${file}:${String(index + 1)}  ${text.trim()}`);
    }
  });
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

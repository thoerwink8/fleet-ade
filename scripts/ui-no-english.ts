// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
// Fails when user-visible interface copy still contains English outside the
// allowlist. Scope is the web UI, the desktop menu, server errors shown to
// users, the modules that put sign-in or provider status text on screen, and
// the functions that format a duration a person reads. Logs, comments,
// developer CLI text, font names, and code identifiers are out of scope. Each
// allowlist line keeps one string; the comment above it is the reason. JSX
// text, string literals inside JSX, and UI string attributes are read from the
// syntax tree, so a phrase on its own line is not skipped.
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
  "packages/shared/src/t3McpToolPresentation.ts",
  "packages/shared/src/toolActivity.ts",
  "packages/client-runtime/src/work-log/presentation.ts",
  "packages/client-runtime/src/t3ToolSummary.ts",
  "packages/client-runtime/src/state/subagentDisplay.ts",
  "packages/client-runtime/src/state/threadExecution.ts",
  "packages/provider-core/src/server/providerAuthFlow.ts",
  "packages/provider-acp-registry/src/server/auth.ts",
  "apps/server/src/provider/Drivers/CodexManagedProvider.ts",
  "apps/server/src/provider/CodexProvider.ts",
  "packages/shared/src/orchestrationTiming.ts",
  "packages/shared/src/compactionTitle.ts",
  "packages/provider-acp/src/server/sessionConfig.ts",
  "apps/server/src/provider/AntigravityProvider.ts",
  "apps/server/src/provider/antigravityAuthSupport.ts",
  "apps/server/src/provider/antigravityUsageLimits.ts",
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
  "actionLabel",
  "buttonLabel",
  "confirmTitle",
  "confirmLabel",
  "dialogTitle",
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

function leftoverEnglishWords(text: string, allowlist: ReadonlyArray<AllowEntry>): string[] {
  let rest = text;
  for (const entry of allowlist) {
    const pattern = new RegExp(entry.phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    rest = rest.replace(pattern, " ");
  }
  rest = rest
    .replace(/\b--?[A-Za-z][\w.-]*\b/g, " ")
    .replace(/\b[A-Z][A-Z0-9_]{2,}\b/g, " ")
    .replace(/\b[A-Za-z]+(?:[/_-][A-Za-z0-9]+)+\b/g, " ");
  return rest.match(/\b[A-Za-z]{3,}\b/g) ?? [];
}

// Short function words such as a lone ` in` bypass the 3-letter word check in
// isUserCopy, so JSX text that is exactly one of them is still user copy.
const SHORT_FUNCTION_WORDS =
  /^(?:a|an|and|as|at|be|by|do|for|from|go|if|in|is|it|no|of|on|or|so|the|to|up|we|with)$/i;

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
  const words = leftoverEnglishWords(plain, allowlist);
  if (words.length === 0) return false;
  // A Chinese sentence that only borrows one name or token is already translated.
  if (/[\u4e00-\u9fff]/.test(plain) && words.length < 2) return false;
  if (
    /^(?:oklch|rgba|rgb|hsla?)\(|var\(--|system-ui|ui-monospace|sans-serif|video\/|codecs=/.test(
      plain,
    )
  ) {
    return false;
  }
  if (
    /\b(?:flex|grid|absolute|relative|fixed|sticky|hidden|inline-|items-|justify-|px-|py-|gap-|border-|bg-|text-|sm:|lg:|max-sm:|min-w-|max-w-|overflow-|z-\d)|color-mix\(|\bfill-\[|currentColor|xMinYMin slice/.test(
      plain,
    )
  ) {
    return false;
  }
  if (/(?:^and |, and\b)|\b\d+ other\b|\b(?:is|are|was|were|has|have) [a-z]{3,}\b/.test(plain)) {
    return true;
  }
  if (/^[a-z0-9_.:/\- ]+$/.test(plain)) return false;
  if (!/[A-Z\u4e00-\u9fff]/.test(plain)) return false;
  return (
    / [A-Za-z]{3,}/.test(plain) ||
    /\b[A-Z][a-z]{2,} \d/.test(plain) ||
    /[A-Za-z][.?!…]$/.test(plain)
  );
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
  const name = node.expression.name.text;
  if (/^log(?:Warning|Info|Error|Debug|Trace|Fatal)?$/.test(name)) return true;
  // console.error in a click handler is a log, not the sentence on screen.
  return (
    (name === "error" ||
      name === "warn" ||
      name === "info" ||
      name === "debug" ||
      name === "log") &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "console"
  );
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

function templateSpans(node: ts.TemplateLiteral): string[] {
  if (ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)];
}

function expressionSampleText(node: ts.Expression): string | undefined {
  const direct = literalText(node);
  if (direct !== undefined) return direct;
  if (ts.isConditionalExpression(node)) {
    return expressionSampleText(node.whenTrue) ?? expressionSampleText(node.whenFalse);
  }
  if (ts.isBinaryExpression(node)) {
    return expressionSampleText(node.left) ?? expressionSampleText(node.right);
  }
  if (ts.isTemplateExpression(node)) {
    return reconstructTemplateSample(node);
  }
  return undefined;
}

// Reconstructs interpolated templates such as `Changed ${count} ${count === 1 ? "file" : "files"}`
// or `Tasks ${done}/${total}` into `"Changed 1 file"` / `"Tasks 1/1"` so plural templates and
// capitalized prefixes before numbers are checked as complete user-facing phrases.
function reconstructTemplateSample(node: ts.TemplateExpression): string {
  let out = node.head.text;
  for (const span of node.templateSpans) {
    const sample = expressionSampleText(span.expression);
    out += (sample !== undefined && sample.trim() !== "" ? sample : "1") + span.literal.text;
  }
  return out;
}

function expressionCandidateTexts(node: ts.Expression): string[] {
  const direct = literalText(node);
  if (direct !== undefined) return [direct];
  if (ts.isTemplateExpression(node)) {
    return [reconstructTemplateSample(node), ...templateSpans(node)];
  }
  if (ts.isConditionalExpression(node)) {
    return [
      ...expressionCandidateTexts(node.whenTrue),
      ...expressionCandidateTexts(node.whenFalse),
    ];
  }
  if (
    ts.isBinaryExpression(node) &&
    (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      node.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    return [...expressionCandidateTexts(node.left), ...expressionCandidateTexts(node.right)];
  }
  if (
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isParenthesizedExpression(node)
  ) {
    return expressionCandidateTexts(node.expression);
  }
  return [];
}

// Substituted templates such as `${minutes}m` never appear as one literal, so
// the sentence check cannot see a single-letter unit. These files are the
// formatters that print a duration on screen.
function isDurationFormatter(rel: string): boolean {
  return (
    rel.endsWith("/orchestrationTiming.ts") ||
    rel.endsWith("/TimelineWorkGroupRows.logic.ts") ||
    rel.endsWith("/AgentElapsed.tsx")
  );
}

function isLatinDurationUnit(text: string): boolean {
  const plain = text.trim();
  return /(?:^|\s)\d*(?:\.\d+)?(?:ms|h|m|s)$/.test(plain);
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
    rel.endsWith("/provider-acp-registry/src/server/auth.ts") ||
    rel.endsWith("/CodexManagedProvider.ts") ||
    rel.endsWith("/CodexAuthCallbackPage.ts") ||
    rel.endsWith("/codexAuthCallback.ts") ||
    rel.endsWith("/t3McpToolPresentation.ts") ||
    rel.endsWith("/toolActivity.ts") ||
    rel.endsWith("/work-log/presentation.ts") ||
    rel.endsWith("/t3ToolSummary.ts") ||
    rel.endsWith("/subagentDisplay.ts") ||
    rel.endsWith("/threadExecution.ts") ||
    rel.endsWith("/compactionTitle.ts") ||
    rel.endsWith("/sessionConfig.ts") ||
    rel.endsWith("/AntigravityProvider.ts") ||
    rel.endsWith("/antigravityAuthSupport.ts") ||
    rel.endsWith("/antigravityUsageLimits.ts") ||
    /\/provider\/[^/]*Auth\.ts$/.test(rel);
  const templateCopy =
    rel.endsWith("/AntigravityProvider.ts") ||
    rel.endsWith("/UserFacingErrors.ts") ||
    rel.endsWith("/t3McpToolPresentation.ts") ||
    rel.endsWith("/toolActivity.ts") ||
    rel.endsWith("/work-log/presentation.ts") ||
    rel.endsWith("/t3ToolSummary.ts") ||
    rel.endsWith("/subagentDisplay.ts") ||
    rel.endsWith("/threadExecution.ts");
  const durationFile = isDurationFormatter(rel);
  const opensJsx = (node: ts.Node) =>
    ts.isJsxElement(node) ||
    ts.isJsxFragment(node) ||
    ts.isJsxSelfClosingElement(node) ||
    ts.isJsxAttribute(node) ||
    ts.isJsxExpression(node);
  const visit = (node: ts.Node, inJsx: boolean): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    // Log calls and error-substring matchers are out of scope even when they sit in a sign-in module.
    if (ts.isCallExpression(node)) {
      if (isLogCall(node)) return;
      if (
        serverCopy &&
        ts.isPropertyAccessExpression(node.expression) &&
        /^(?:includes|startsWith|endsWith|indexOf)$/.test(node.expression.name.text)
      ) {
        return;
      }
    }
    const texts: string[] = [];
    if (serverCopy) {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        texts.push(node.text);
      } else if (ts.isTemplateExpression(node) && templateCopy) {
        // Interpolated status, tool summary, and launch sentences are still the words a person reads.
        texts.push(reconstructTemplateSample(node), ...templateSpans(node));
      }
    } else if (ts.isJsxText(node)) {
      if (SHORT_FUNCTION_WORDS.test(node.text.trim())) {
        findings.push(`${file}:${String(lineOf(source, node))}  ${node.text.trim()}`);
      }
      texts.push(node.text);
    } else if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(source);
      const initializer = node.initializer;
      if (UI_NAMES.has(name) && initializer) {
        if (ts.isStringLiteral(initializer)) texts.push(initializer.text);
        else if (ts.isJsxExpression(initializer) && initializer.expression) {
          texts.push(...expressionCandidateTexts(initializer.expression));
        }
      }
    } else if (ts.isPropertyAssignment(node)) {
      const name = propertyName(node.name);
      if (name !== undefined && UI_NAMES.has(name)) {
        texts.push(...expressionCandidateTexts(node.initializer));
      }
    }
    // `value={"No project"}` is a literal inside JSX, not a named UI attribute,
    // and a ternary keeps each branch as its own literal.
    if (
      !serverCopy &&
      inJsx &&
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ) {
      texts.push(node.text);
    }
    if (!serverCopy && inJsx && ts.isTemplateExpression(node)) {
      texts.push(reconstructTemplateSample(node), ...templateSpans(node));
    }
    if (durationFile && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) {
      texts.push(node.text);
    }
    if (durationFile && ts.isTemplateExpression(node)) {
      texts.push(...templateSpans(node));
    }
    for (const text of texts) {
      const hit = durationFile
        ? isLatinDurationUnit(text) || isUserCopy(text, allowlist)
        : isUserCopy(text, allowlist);
      if (!hit) continue;
      findings.push(`${file}:${String(lineOf(source, node))}  ${text.trim()}`);
    }
    const childJsx = inJsx || opensJsx(node);
    ts.forEachChild(node, (child) => visit(child, childJsx));
  };
  visit(source, false);
}

const uniqueFindings = [...new Set(findings)];
const outPath = process.argv[3];
if (outPath) {
  const report = [`COUNT ${String(uniqueFindings.length)}`, ...uniqueFindings].join("\n");
  NodeFS.writeFileSync(outPath, report, "utf8");
}
if (uniqueFindings.length > 0) {
  if (!outPath) {
    for (const finding of uniqueFindings) console.log(finding);
  }
  process.exitCode = 1;
}

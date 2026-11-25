// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
// Fails when user-visible interface copy still contains English outside the
// allowlist. Scope is the web UI, the desktop menu, server errors shown to
// users, the modules that put sign-in or provider status text on screen, and
// the functions that format a duration a person reads. Logs, comments,
// developer CLI text, font names, and code identifiers are out of scope. Each
// allowlist line keeps one string; the comment above it is the reason.
//
// Every string literal and template in the scanned files passes the strict
// phrase check: a whole English sentence is suspicious wherever it sits, since
// copy is composed in hooks and helpers before it reaches JSX. The strict
// check only fires on sentence-shaped text, so identifiers, keys, paths, and
// single words stay quiet. On top of that, three weaker detectors look for
// fragments a phrase check cannot see:
//
// - JSX attribute/property names known to carry copy (title, label, …) get a
//   relaxed check that drops the capitalization and lowercase guards, so
//   `title: `${name} fork`` and `label="more options"` are caught; a bare
//   single word is still skipped because it is usually an identifier value.
// - Files that already render Chinese copy flag English JSX text and literals
//   that a JSX expression renders, plus literals returned from components and
//   copy-named helpers. A leftover English word inside a translated component
//   is what `saving 2 图片s…` and `5 more` looked like.
// - A ternary or object literal that mixes Chinese and English text means one
//   branch was translated and the other was not (`"文件"` vs `"attachment"`,
//   `failed: "Failed"` next to `unchecked: "尚未检查"`); the English side is
//   flagged.
//
// What it still cannot see: a whole-English sentence assembled entirely from
// variables (`${behavior}` whose value is an English enum) and strings that
// only ever travel through identifiers.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import ts from "typescript-legacy";

import {
  COPY_NAME,
  NON_COPY_PROPS_BASE,
  UI_NAMES,
  expressionCandidateTexts,
  included,
  isEqualityOrCaseClause,
  isInternalTextCall,
  isLogCall,
  lineOf,
  propertyName,
  qualifiesAsCopyScope,
  reconstructTemplateSample,
  templateSpans,
  walk,
} from "./lib/ui-copy-scan.ts";

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
  "apps/server/src/provider/providerCompatibility.ts",
  "apps/server/src/project/ManagedProjectFolders.ts",
  "apps/server/src/orchestration-v2/Orchestrator.ts",
  "packages/shared/src/usageLimits.ts",
  "apps/server/src/provider/CodexManagedErrors.ts",
  "packages/shared/src/model.ts",
  "packages/shared/src/paletteSearch.ts",
  "packages/client-runtime/src/operations/threadTitle.ts",
];

const CJK = /[一-鿿]/;

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
    const escaped = entry.phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = /^\w+$/.test(entry.phrase)
      ? new RegExp(`\\b${escaped}\\b`, "gi")
      : new RegExp(escaped, "gi");
    rest = rest.replace(pattern, " ");
  }
  rest = rest
    .replace(/\b--?[A-Za-z][\w.-]*\b/g, " ")
    .replace(/\b[A-Z][A-Z0-9_]{2,}\b/g, " ")
    .replace(/\b[A-Z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*\b/g, " ")
    .replace(/\b[a-z]+(?:[A-Z][a-zA-Z0-9]*)+\b/g, " ")
    .replace(/\b[A-Za-z]+(?:[/_-][A-Za-z0-9]+)+\b/g, " ");
  return rest.match(/\b[A-Za-z]{3,}\b/g) ?? [];
}

// Short function words such as a lone ` in` bypass the 3-letter word check in
// isUserCopy, so JSX text that is exactly one of them is still user copy.
const SHORT_FUNCTION_WORDS =
  /^(?:a|an|and|as|at|be|by|do|for|from|go|if|in|is|it|no|of|on|or|so|the|to|up|we|with)$/i;

// "strict" is the sentence-shaped test used everywhere. "loose" drops the
// capitalization and lowercase guards but still skips a bare single word
// (usually an identifier value). "loose-bare" accepts bare words too; it only
// runs where context already proves the text renders.
type CheckMode = "strict" | "loose" | "loose-bare";

function isUserCopy(
  text: string,
  allowlist: ReadonlyArray<AllowEntry>,
  mode: CheckMode = "strict",
): boolean {
  const plain = text
    .replace(/\$\{[^}]*\}/g, " ")
    .replace(/\{\{[^}]*\}\}/g, " ")
    .replace(/--[A-Za-z][\w.-]*/g, " ")
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
  // A leading bracket or comma is a code fragment in generic positions; in
  // copy positions "(empty)" is exactly what a person reads.
  if (
    mode === "strict" &&
    (/^[()[\]|&,]/.test(plain) || /\bnew (?:Map|Set)\b|\bAtom\b|\bKeyboardEvent\b/.test(plain))
  ) {
    return false;
  }
  const words = leftoverEnglishWords(plain, allowlist);
  if (words.length === 0) return false;
  // A font-family value is a comma-separated list of font tokens, not a sentence.
  if (/^(?:"[^"]+"|'[^']+'|[\w-]+)(?:\s*,\s*(?:"[^"]+"|'[^']+'|[\w-]+))+\s*,?\s*$/.test(plain)) {
    return false;
  }
  // A Chinese sentence that only borrows one name or token is already translated.
  if (CJK.test(plain) && words.length < 2) return false;
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
  // A count followed by a lowercase noun (`1 file`, `3 clients`) is a plural template
  // whose capital letter is missing, so the sentence guards below would skip it.
  if (
    /^\d[\d,.+]*\s+[a-z]{3,}(?:\s+[a-z]{3,})*$/.test(plain) &&
    !/^\d[\d,.+]*\s+(?:millis|milliseconds?|seconds?|minutes?|hours?|days?)$/.test(plain)
  ) {
    return true;
  }
  if (mode === "loose-bare") return true;
  // A lone identifier-shaped word is a value like "auto", not copy.
  if (/^[a-z][A-Za-z0-9_-]*$/.test(plain)) return false;
  if (mode === "loose") return true;
  if (/^[a-z0-9_.:/\- ]+$/.test(plain)) return false;
  if (!/[A-Z一-鿿]/.test(plain)) return false;
  return (
    / [A-Za-z]{3,}/.test(plain) ||
    /\b[A-Z][a-z]{2,} \d/.test(plain) ||
    /[A-Za-z][.?!…]$/.test(plain)
  );
}

// Flags English alternatives next to a Chinese one: a ternary or an object
// literal where one side was translated and the other was not. A bare word is
// kept (`"文件" : "attachment"` leaks a lowercase word); non-phrase text
// (ids, mime types, urls) is not.
function mixedLanguageTexts(texts: ReadonlyArray<string>): string[] {
  if (!texts.some((text) => CJK.test(text))) return [];
  return texts.filter(
    (text) =>
      !CJK.test(text) &&
      leftoverEnglishWords(text, allowlist).length > 0 &&
      !/[:/\\{}]|--/.test(text.trim()),
  );
}

// Object properties that carry values for the machine, not for the reader:
// `label: "scheduled task upsert"` is a telemetry tag even though it sits next
// to translated copy.
const NON_COPY_PROPS: Record<string, true> = {
  label: true,
  ...NON_COPY_PROPS_BASE,
};

// Substituted templates such as `${minutes}m` never appear as one literal, so
// the sentence check cannot see a single-letter unit. These files are the
// formatters that print a duration on screen.
function isDurationFormatter(rel: string): boolean {
  return (
    rel.endsWith("/orchestrationTiming.ts") ||
    rel.endsWith("/TimelineWorkGroupRows.logic.ts") ||
    rel.endsWith("/GitActionsControl.logic.ts") ||
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

// These modules publish the sentence a person reads while signing in or out.
// Their strings are not all object fields, so every literal is a candidate.
const SERVER_COPY = [
  "/UserFacingErrors.ts",
  "/providerAuthFlow.ts",
  "/provider-acp-registry/src/server/auth.ts",
  "/CodexManagedProvider.ts",
  "/CodexAuthCallbackPage.ts",
  "/codexAuthCallback.ts",
  "/t3McpToolPresentation.ts",
  "/toolActivity.ts",
  "/work-log/presentation.ts",
  "/t3ToolSummary.ts",
  "/subagentDisplay.ts",
  "/threadExecution.ts",
  "/compactionTitle.ts",
  "/sessionConfig.ts",
  "/AntigravityProvider.ts",
  "/antigravityAuthSupport.ts",
  "/antigravityUsageLimits.ts",
  "/CodexManagedErrors.ts",
  "/model.ts",
  "/paletteSearch.ts",
  "/threadTitle.ts",
];

function isServerCopyFile(rel: string): boolean {
  return (
    SERVER_COPY.some((suffix) => rel.endsWith(suffix)) || /\/provider\/[^/]*Auth\.ts$/.test(rel)
  );
}

function isUiSurfaceFile(rel: string): boolean {
  const path = rel.replace(/^\.\//, "").replace(/^.*?apps\//, "apps/");
  return path.startsWith("apps/web/src/") || path.startsWith("apps/desktop/src/window/");
}

// Substituted templates in these modules are also the words a person reads;
// elsewhere a reconstructed template is checked only in UI-surface files.
const TEMPLATE_COPY = [
  "/AntigravityProvider.ts",
  "/UserFacingErrors.ts",
  "/t3McpToolPresentation.ts",
  "/toolActivity.ts",
  "/work-log/presentation.ts",
  "/t3ToolSummary.ts",
  "/subagentDisplay.ts",
  "/threadExecution.ts",
];

const findings: string[] = [];
for (const file of files.filter(included)) {
  const sourceText = NodeFS.readFileSync(file, "utf8");
  const source = ts.createSourceFile(
    file,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const rel = file.replaceAll("\\", "/");
  // A file already rendering Chinese text is a translated surface; leftover
  // English words in its JSX and component returns are leaks, not prose.
  const fileHasCjk = CJK.test(sourceText);
  const durationFile = isDurationFormatter(rel);
  const serverCopy = isServerCopyFile(rel);
  const templateCopy = TEMPLATE_COPY.some((suffix) => rel.endsWith(suffix));
  // Full literal scanning applies where the file is a UI surface or a module
  // that publishes user-facing text; other scanned roots keep positional checks.
  const everyLiteral = isUiSurfaceFile(rel) || serverCopy;
  const uiSurface = isUiSurfaceFile(rel);
  const opensJsx = (node: ts.Node) =>
    ts.isJsxElement(node) ||
    ts.isJsxFragment(node) ||
    ts.isJsxSelfClosingElement(node) ||
    ts.isJsxAttribute(node) ||
    ts.isJsxExpression(node);

  const debug = process.env.UI_NO_ENGLISH_DEBUG === "1";
  const flagged = new Set<string>();
  const report = (node: ts.Node, text: string, mode: CheckMode, rule = "?"): void => {
    const trimmed = text.trim();
    const hit = isUserCopy(trimmed, allowlist, mode);
    if (!hit) return;
    flagged.add(`${file}:${String(lineOf(source, node))}  ${debug ? `[${rule}] ` : ""}${trimmed}`);
  };

  const visit = (
    node: ts.Node,
    inJsx: boolean,
    jsxChild: boolean,
    copyScope: "none" | "copy" | "component",
  ): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    // Type-position literals and enum members are values, not sentences.
    if (ts.isLiteralTypeNode(node) || ts.isEnumMember(node)) return;
    // `toastManager.add({ … })` shares a method name with Set.add; an object argument is copy.
    if (
      ts.isCallExpression(node) &&
      isInternalTextCall(node) &&
      (isLogCall(node) ||
        !node.arguments.some((argument) => ts.isObjectLiteralExpression(argument)))
    ) {
      return;
    }
    // Operands of an equality are compared keys; case labels likewise.
    if (isEqualityOrCaseClause(node)) {
      return;
    }

    if (ts.isJsxText(node)) {
      if (SHORT_FUNCTION_WORDS.test(node.text.trim())) {
        flagged.add(`${file}:${String(lineOf(source, node))}  ${node.text.trim()}`);
      }
      report(node, node.text, "strict", "jsxtext");
      if (uiSurface && fileHasCjk) report(node, node.text, "loose-bare", "jsxtext");
    } else if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(source);
      const initializer = node.initializer;
      if (UI_NAMES[name] === true && initializer) {
        if (ts.isStringLiteral(initializer)) {
          report(initializer, initializer.text, "strict", "uiattr");
          if (uiSurface) report(initializer, initializer.text, "loose", "uiattr");
        } else if (ts.isJsxExpression(initializer) && initializer.expression) {
          for (const text of expressionCandidateTexts(initializer.expression)) {
            report(initializer, text, "strict", "uiattr");
            if (uiSurface) report(initializer, text, "loose", "uiattr");
          }
        }
      }
    } else if (ts.isPropertyAssignment(node)) {
      const name = propertyName(node.name);
      if (name !== undefined && UI_NAMES[name] === true && name !== "label") {
        for (const text of expressionCandidateTexts(node.initializer)) {
          report(node.initializer, text, "strict", "uiprop");
          if (uiSurface) report(node.initializer, text, "loose", "uiprop");
        }
      }
      // `children: "Retry"` or `generated: "Generated"`: one capitalized English
      // word as a property value is a label unless the property carries a machine tag.
      // `?? "Environment"` fallbacks count too; curated copy modules also check `label:`.
      if (
        (uiSurface || serverCopy) &&
        name !== undefined &&
        (serverCopy ? NON_COPY_PROPS_BASE[name] !== true : NON_COPY_PROPS[name] !== true)
      ) {
        for (const text of expressionCandidateTexts(node.initializer)) {
          if (/^[A-Z][a-z]{2,}$/.test(text) && leftoverEnglishWords(text, allowlist).length > 0) {
            flagged.add(`${file}:${String(lineOf(source, node))}  ${text}`);
          }
        }
      }
    }

    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (everyLiteral) report(node, node.text, "strict", "lit");
      // A literal a JSX expression renders in a translated file is a leftover
      // word like `saving` or `dropped`, even with no phrase around it.
      if (uiSurface && jsxChild && fileHasCjk) report(node, node.text, "loose-bare", "jsxlit");
    } else if (ts.isTemplateExpression(node)) {
      if (everyLiteral || templateCopy)
        report(node, reconstructTemplateSample(node), "strict", "lit");
      if (uiSurface && jsxChild && fileHasCjk)
        report(node, reconstructTemplateSample(node), "loose-bare", "jsxlit");
    }

    // `return "(empty)"` in a helper named for copy, or "retrying" returned by
    // a component, in a file that is otherwise translated.
    if (
      ts.isReturnStatement(node) &&
      node.expression !== undefined &&
      copyScope !== "none" &&
      ((uiSurface && fileHasCjk) || rel.endsWith("/model.ts"))
    ) {
      for (const text of expressionCandidateTexts(node.expression)) {
        const mode = copyScope === "component" || serverCopy ? "loose-bare" : "loose";
        report(node.expression, text, mode, "ret");
      }
    }

    // `const installationStatusMessage = condition ? "Downloading …" : "…"`.
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer !== undefined &&
      ts.isIdentifier(node.name) &&
      COPY_NAME.test(node.name.text)
    ) {
      for (const text of expressionCandidateTexts(node.initializer)) {
        report(node.initializer, text, "strict", "var");
        if (uiSurface) report(node.initializer, text, "loose", "var");
      }
    }

    if (ts.isConditionalExpression(node)) {
      const texts = [
        ...expressionCandidateTexts(node.whenTrue),
        ...expressionCandidateTexts(node.whenFalse),
      ];
      for (const text of mixedLanguageTexts(texts)) {
        if (uiSurface) report(node, text, "loose-bare", "mixcond");
      }
    }
    if (
      ts.isArrayLiteralExpression(node) &&
      !(
        ts.isPropertyAssignment(node.parent) &&
        propertyName(node.parent.name) !== undefined &&
        NON_COPY_PROPS[propertyName(node.parent.name)!]
      )
    ) {
      const texts = node.elements.flatMap((element) => expressionCandidateTexts(element));
      for (const text of mixedLanguageTexts(texts)) {
        if (uiSurface) report(node, text, "loose", "mixarr");
      }
    }
    if (ts.isObjectLiteralExpression(node)) {
      const texts = node.properties.flatMap((property) =>
        ts.isPropertyAssignment(property) &&
        !(propertyName(property.name) !== undefined && NON_COPY_PROPS[propertyName(property.name)!])
          ? expressionCandidateTexts(property.initializer)
          : [],
      );
      for (const text of mixedLanguageTexts(texts)) {
        if (uiSurface) report(node, text, "loose", "mixobj");
      }
    }

    if (durationFile && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) {
      const trimmed = node.text.trim();
      if (isLatinDurationUnit(trimmed) || isUserCopy(trimmed, allowlist)) {
        flagged.add(`${file}:${String(lineOf(source, node))}  ${trimmed}`);
      }
    }
    if (durationFile && ts.isTemplateExpression(node)) {
      for (const text of templateSpans(node)) {
        if (isLatinDurationUnit(text.trim())) {
          flagged.add(`${file}:${String(lineOf(source, node))}  ${text.trim()}`);
        }
      }
    }

    // Descend. JSX element/fragment children render text (jsxChild); attribute
    // initializers do not; a JSX expression keeps whatever position it sits in.
    const nextInJsx = inJsx || opensJsx(node);
    const nextJsxChild =
      ts.isJsxElement(node) || ts.isJsxFragment(node)
        ? true
        : ts.isJsxAttribute(node) || ts.isJsxSelfClosingElement(node)
          ? false
          : ts.isJsxExpression(node)
            ? jsxChild
            : jsxChild &&
              (ts.isConditionalExpression(node) ||
                ts.isParenthesizedExpression(node) ||
                (ts.isBinaryExpression(node) &&
                  (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
                    node.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
                    node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)));

    // copyScope marks functions whose returns are copy by name: components and
    // copy-named helpers. It is not inherited — a callback inside a component
    // usually returns state, not text.
    const functionLike =
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node) ||
      ts.isArrowFunction(node);
    const nextScope = functionLike
      ? "name" in node &&
        node.name !== undefined &&
        ts.isIdentifier(node.name as ts.Node) &&
        qualifiesAsCopyScope((node.name as ts.Identifier).text)
        ? /^[A-Z]/.test((node.name as ts.Identifier).text)
          ? "component"
          : "copy"
        : "none"
      : copyScope;

    // A function initializer bound to a copy-named variable or property
    // qualifies on its own.
    if (
      (ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node)) &&
      node.initializer !== undefined &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      const declaredName = ts.isVariableDeclaration(node)
        ? ts.isIdentifier(node.name)
          ? node.name.text
          : undefined
        : propertyName(node.name);
      const initScope =
        declaredName !== undefined && /^[A-Z]/.test(declaredName)
          ? "component"
          : declaredName !== undefined && qualifiesAsCopyScope(declaredName)
            ? "copy"
            : "none";
      ts.forEachChild(node, (child) =>
        visit(child, nextInJsx, nextJsxChild, child === node.initializer ? initScope : nextScope),
      );
      return;
    }

    ts.forEachChild(node, (child) => visit(child, nextInJsx, nextJsxChild, nextScope));
  };
  visit(source, false, false, "none");

  for (const finding of flagged) findings.push(finding);
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

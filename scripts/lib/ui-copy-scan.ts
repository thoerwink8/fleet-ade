// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import ts from "typescript-legacy";

export const UI_NAMES: Record<string, true> = {
  title: true,
  label: true,
  placeholder: true,
  "aria-label": true,
  "aria-description": true,
  "aria-placeholder": true,
  alt: true,
  description: true,
  tooltip: true,
  heading: true,
  emptyText: true,
  hint: true,
  caption: true,
  subtitle: true,
  detail: true,
  actionLabel: true,
  buttonLabel: true,
  confirmTitle: true,
  confirmLabel: true,
  dialogTitle: true,
  searchPlaceholder: true,
  statusText: true,
  errorText: true,
  empty: true,
  footerActionLabel: true,
};

// Variable and function names that conventionally hold the words on screen.
// A literal in `errorMessage = "…"` or `return "…"` inside `statusLabel()` is
// copy even though it never touches JSX syntax.
export const COPY_NAME =
  /(?:label|title|message|notice|text|copy|status|hint|tooltip|summary|headline|placeholder|caption|subtitle|snippet)s?$/i;

// Object properties that carry values for the machine, not for the reader.
// `label` is kept out of this base map because `ui-no-english` skips object
// `label:` tags selectively while UI old-term scanning checks `label:` copy.
export const NON_COPY_PROPS_BASE: Record<string, true> = {
  _tag: true,
  id: true,
  key: true,
  type: true,
  kind: true,
  name: true,
  value: true,
  command: true,
  icon: true,
  role: true,
  status: true,
  state: true,
  mode: true,
  method: true,
  action: true,
  operation: true,
  target: true,
  source: true,
  format: true,
  language: true,
  version: true,
  slug: true,
  accelerator: true,
  hotkey: true,
  shortcut: true,
  testId: true,
  "data-testid": true,
  mimeType: true,
  searchTerms: true,
  shortcutCommand: true,
};

export const NON_COPY_JSX_ATTRS: Record<string, true> = {
  id: true,
  key: true,
  name: true,
  type: true,
  value: true,
  role: true,
  className: true,
  style: true,
  variant: true,
  size: true,
  side: true,
  align: true,
  orientation: true,
  href: true,
  src: true,
  htmlFor: true,
  slot: true,
  testId: true,
  shortcut: true,
  shortcutCommand: true,
  status: true,
  state: true,
  mode: true,
  kind: true,
  command: true,
  icon: true,
  target: true,
  action: true,
  operation: true,
  marker: true,
  theme: true,
};

export function walk(dir: string, out: string[]): void {
  if (!NodeFS.existsSync(dir)) return;
  for (const entry of NodeFS.readdirSync(dir, { withFileTypes: true })) {
    const full = NodePath.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "i18n") continue;
      walk(full, out);
    } else out.push(full);
  }
}

export function included(file: string): boolean {
  const rel = file.replaceAll("\\", "/");
  if (!/\.tsx?$/.test(rel) || rel.endsWith(".d.ts")) return false;
  if (/\.(?:test|browser\.test|stories)\./.test(rel)) return false;
  if (rel.endsWith(".gen.ts") || rel.includes("/_generated/")) return false;
  // Font-name lists hold machine strings, not interface copy.
  if (rel.endsWith("/appearanceFonts.ts") || rel.endsWith("/composer-code-languages.ts")) {
    return false;
  }
  return true;
}

export function isLogCall(node: ts.CallExpression): boolean {
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

// Calls whose arguments are compared or parsed, never shown: error-substring
// matchers, regex/string operations, and constructors for internal values.
export function isInternalTextCall(node: ts.CallExpression): boolean {
  if (isLogCall(node)) return true;
  if (ts.isIdentifier(node.expression)) {
    return /^(?:RegExp|Set|Map|URL|Boolean|Number|BigInt)$/.test(node.expression.text);
  }
  if (!ts.isPropertyAccessExpression(node.expression)) return false;
  return /^(?:includes|startsWith|endsWith|indexOf|lastIndexOf|test|match|matchAll|replace|replaceAll|split|search|localeCompare|normalize|at|charAt|charCodeAt|codePointAt|getAttribute|hasAttribute|setAttribute|querySelector|querySelectorAll|closest|matches|getElementById|getItem|setItem|removeItem|add|delete|has|set|get|join|concat|slice|substring|substr|trim|toLowerCase|toUpperCase|encodeURI|encodeURIComponent|decodeURIComponent|parse|parseInt|parseFloat|stringify|exec)$/.test(
    node.expression.name.text,
  );
}

export function isIgnoredInternalCall(node: ts.CallExpression): boolean {
  if (
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "Effect" &&
    /^(?:fn|fnUntraced|withSpan|annotateLogs|log(?:Warning|Info|Error|Debug|Trace|Fatal)?)$/.test(
      node.expression.name.text,
    )
  ) {
    return true;
  }
  return (
    isInternalTextCall(node) &&
    (isLogCall(node) || !node.arguments.some((argument) => ts.isObjectLiteralExpression(argument)))
  );
}

export function isEqualityOrCaseClause(node: ts.Node): boolean {
  return (
    (ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
        node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken ||
        node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken)) ||
    ts.isCaseClause(node)
  );
}

export function literalText(node: ts.Expression): string | undefined {
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

export function propertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return undefined;
}

export function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

export function templateSpans(node: ts.TemplateLiteral): string[] {
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
export function reconstructTemplateSample(node: ts.TemplateExpression): string {
  let out = node.head.text;
  for (const span of node.templateSpans) {
    const sample = expressionSampleText(span.expression);
    out += (sample !== undefined && sample.trim() !== "" ? sample : "1") + span.literal.text;
  }
  return out;
}

export function expressionCandidateTexts(node: ts.Expression): string[] {
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

export const qualifiesAsCopyScope = (name: string | undefined): boolean =>
  name !== undefined && (/^[A-Z]/.test(name) || COPY_NAME.test(name));

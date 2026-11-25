import { defineRule, type ESTree } from "@oxlint/plugins";
import * as Option from "effect/Option";

import { getPropertyName, unwrapExpression } from "../utils.ts";

export interface CssFontSize13pxViolation {
  readonly line: number;
  readonly declaration: string;
  readonly resolvedFrom?: string;
}

export interface CssFontSize13pxFileViolation extends CssFontSize13pxViolation {
  readonly file: string;
}

interface ParsedCssDeclaration {
  readonly line: number;
  readonly property: string;
  readonly value: string;
  readonly declaration: string;
  readonly inThemeBlock: boolean;
}

const LENGTH_13PX = /^(?:13(?:\.0+)?px|0*\.81250*rem)$/iu;
const TEXT_13PX = /^text-\[(?:length:)?(?:13(?:\.0+)?px|0*\.81250*rem)\](?:\/.+)?$/iu;
const ARBITRARY_FONT_SIZE_CLASS = /^\[font-size:(.+)\]$/iu;
const ARBITRARY_FONT_CLASS = /^\[font:(.+)\]$/iu;
const TAILWIND_VAR_DEF_CLASS = /^\[(--[\w-]+):(.+)\]$/u;
const TEXT_LEN_VAR_PAREN = /^text-\(length:(--[\w-]+(?:\s*,[^)]+)?)\)(?:\/.+)?$/u;
const TEXT_VAR_BRACKET = /^text-\[(?:length:)?(var\(--[^)]+\))\](?:\/.+)?$/u;
const FONT_SHORTHAND_SIZE_TOKEN =
  /^(?:(?:\d+(?:\.\d+)?|\.\d+)(?:px|rem|em|%|pt|ch|ex|vw|vh|vmin|vmax|cm|mm|in|pc|q|lh|rlh|dvh|svh|lvh|cqw|cqh|cqi|cqb)|(?:calc|clamp|min|max|var)\(|(?:xxx?-small|xxx?-large|xx?-small|xx?-large|small|medium|large|smaller|larger))(?:\/|$)/iu;
const SYSTEM_OR_GLOBAL_FONT_KEYWORD =
  /^(?:caption|icon|menu|message-box|small-caption|status-bar|inherit|initial|unset|revert|revert-layer)$/iu;
const CSS_PROP_NAME = /^(?:--[\w-]+|[a-z][a-z0-9-]*)$/iu;
const THEME_BLOCK_PRELUDE = /^\s*@theme(?:\s|$)/iu;
const HTML_STYLE_ATTR = /\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/giu;
const CLASS_COMPOSERS = new Set(["cn", "clsx", "classNames", "cva", "twMerge"]);

function stripVariants(token: string): string {
  let depth = 0;
  let start = 0;
  for (let index = 0; index < token.length; index++) {
    const character = token[index];
    if (character === "[" || character === "(") depth++;
    else if ((character === "]" || character === ")") && depth > 0) depth--;
    else if (character === ":" && depth === 0) start = index + 1;
  }
  return token.slice(start).replace(/^!|!$/gu, "");
}

function maskCssComments(css: string): string {
  let out = "";
  let quote: string | null = null;
  let escaped = false;
  for (let index = 0; index < css.length; index++) {
    const ch = css[index]!;
    if (quote !== null) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === "/" && css[index + 1] === "*") {
      const closeIndex = css.indexOf("*/", index + 2);
      const end = closeIndex === -1 ? css.length : closeIndex + 2;
      out += css.slice(index, end).replace(/[^\n]/gu, " ");
      index = end - 1;
      continue;
    }
    out += ch;
  }
  return out;
}

function findTopLevelColon(statement: string): number {
  let quote: string | null = null;
  let escaped = false;
  let parenDepth = 0;
  for (let index = 0; index < statement.length; index++) {
    const ch = statement[index]!;
    if (quote !== null) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === "(") {
      parenDepth++;
    } else if (ch === ")" && parenDepth > 0) {
      parenDepth--;
    } else if (ch === ":" && parenDepth === 0) {
      return index;
    }
  }
  return -1;
}

function extractDeclaration(
  rawStatement: string,
  line: number,
  inThemeBlock: boolean,
): ParsedCssDeclaration | null {
  const colonIndex = findTopLevelColon(rawStatement);
  if (colonIndex === -1) return null;
  const rawProp = rawStatement.slice(0, colonIndex).trim();
  if (!CSS_PROP_NAME.test(rawProp)) return null;
  const rawValue = rawStatement.slice(colonIndex + 1).trim();
  const value = rawValue.replace(/\s*!\s*important\s*$/iu, "").trim();
  return {
    line,
    property: rawProp.startsWith("--") ? rawProp : rawProp.toLowerCase(),
    value,
    declaration: `${rawProp}: ${rawValue}`,
    inThemeBlock,
  };
}

function parseCssDeclarations(css: string): ParsedCssDeclaration[] {
  const masked = maskCssComments(css);
  const declarations: ParsedCssDeclaration[] = [];
  const blockStack: Array<{ readonly isTheme: boolean }> = [];

  let line = 1;
  let parenDepth = 0;
  let quote: string | null = null;
  let escaped = false;
  let statementStartIndex = 0;
  let statementStartLine = 1;
  let firstNonSpaceLine: number | null = null;

  const flushStatement = (endIndex: number) => {
    const raw = masked.slice(statementStartIndex, endIndex);
    const decl = extractDeclaration(
      raw,
      firstNonSpaceLine ?? statementStartLine,
      blockStack.at(-1)?.isTheme === true,
    );
    if (decl) declarations.push(decl);
  };

  for (let index = 0; index < masked.length; index++) {
    const ch = masked[index]!;
    if (ch === "\n") {
      line++;
      if (quote !== null && escaped) escaped = false;
      continue;
    }
    if (quote !== null) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (firstNonSpaceLine === null && !/\s/u.test(ch) && ch !== ";" && ch !== "}" && ch !== "{") {
      firstNonSpaceLine = line;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === "(") {
      parenDepth++;
    } else if (ch === ")" && parenDepth > 0) {
      parenDepth--;
    } else if (parenDepth === 0 && ch === "{") {
      const prelude = masked.slice(statementStartIndex, index);
      blockStack.push({ isTheme: THEME_BLOCK_PRELUDE.test(prelude) });
      statementStartIndex = index + 1;
      statementStartLine = line;
      firstNonSpaceLine = null;
    } else if (parenDepth === 0 && (ch === ";" || ch === "}")) {
      flushStatement(index);
      if (ch === "}") blockStack.pop();
      statementStartIndex = index + 1;
      statementStartLine = line;
      firstNonSpaceLine = null;
    }
  }
  if (statementStartIndex < masked.length) {
    flushStatement(masked.length);
  }
  return declarations;
}

function splitCssTokens(value: string): string[] {
  const tokens: string[] = [];
  let quote: string | null = null;
  let escaped = false;
  let parenDepth = 0;
  let tokenStart = -1;

  for (let index = 0; index < value.length; index++) {
    const ch = value[index]!;
    if (quote !== null) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      if (tokenStart === -1) tokenStart = index;
      quote = ch;
    } else if (ch === "(") {
      if (tokenStart === -1) tokenStart = index;
      parenDepth++;
    } else if (ch === ")" && parenDepth > 0) {
      parenDepth--;
    } else if (parenDepth === 0 && /\s/u.test(ch)) {
      if (tokenStart !== -1) {
        tokens.push(value.slice(tokenStart, index));
        tokenStart = -1;
      }
    } else if (tokenStart === -1) {
      tokenStart = index;
    }
  }
  if (tokenStart !== -1) tokens.push(value.slice(tokenStart));
  return tokens;
}

function splitAtTopLevelSlash(token: string): string {
  let parenDepth = 0;
  for (let index = 0; index < token.length; index++) {
    const ch = token[index]!;
    if (ch === "(") parenDepth++;
    else if (ch === ")" && parenDepth > 0) parenDepth--;
    else if (ch === "/" && parenDepth === 0) return token.slice(0, index);
  }
  return token;
}

function extractFontShorthandSize(rawValue: string): string | null {
  const cleaned = rawValue.replace(/\s*!\s*important\s*$/iu, "").trim();
  if (!cleaned || SYSTEM_OR_GLOBAL_FONT_KEYWORD.test(cleaned)) return null;
  for (const token of splitCssTokens(cleaned)) {
    const sizePart = splitAtTopLevelSlash(token);
    if (FONT_SHORTHAND_SIZE_TOKEN.test(sizePart)) {
      return sizePart;
    }
  }
  return null;
}

function parseVarExpression(
  expr: string,
): { readonly name: string; readonly fallback: string | undefined } | null {
  const trimmed = expr.trim();
  if (!/^var\(/iu.test(trimmed) || !trimmed.endsWith(")")) return null;
  let quote: string | null = null;
  let escaped = false;
  let parenDepth = 0;
  let commaIndex = -1;
  for (let index = 3; index < trimmed.length; index++) {
    const ch = trimmed[index]!;
    if (quote !== null) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === "(") {
      parenDepth++;
    } else if (ch === ")") {
      parenDepth--;
      if (parenDepth === 0) {
        if (index !== trimmed.length - 1) return null;
        break;
      }
    } else if (ch === "," && parenDepth === 1 && commaIndex === -1) {
      commaIndex = index;
    }
  }
  if (parenDepth !== 0) return null;
  const inner = trimmed.slice(4, -1);
  const adjustedComma = commaIndex === -1 ? -1 : commaIndex - 4;
  const name = (adjustedComma === -1 ? inner : inner.slice(0, adjustedComma)).trim();
  if (!name.startsWith("--") || !CSS_PROP_NAME.test(name)) return null;
  const fallback = adjustedComma === -1 ? undefined : inner.slice(adjustedComma + 1).trim();
  return { name, fallback };
}

function resolve13pxValue(
  expr: string,
  customProps: ReadonlyMap<string, ReadonlyArray<string>>,
  visited: ReadonlySet<string> = new Set(),
): string | null {
  const trimmed = expr.trim();
  if (LENGTH_13PX.test(trimmed)) return trimmed;
  const parsed = parseVarExpression(trimmed);
  if (!parsed) return null;

  if (!visited.has(parsed.name)) {
    const nextVisited = new Set(visited);
    nextVisited.add(parsed.name);
    for (const candidate of customProps.get(parsed.name) ?? []) {
      const resolved = resolve13pxValue(candidate, customProps, nextVisited);
      if (resolved !== null) {
        const separator = LENGTH_13PX.test(candidate.trim()) ? ": " : " -> ";
        return `${parsed.name}${separator}${resolved}`;
      }
    }
  }

  if (parsed.fallback !== undefined) {
    return resolve13pxValue(parsed.fallback, customProps, visited);
  }
  return null;
}

function isTailwindThemeTextSizeProp(property: string): boolean {
  return property.startsWith("--text-") && !property.includes("--", 2);
}

function addCustomProp(map: Map<string, string[]>, name: string, value: string): void {
  const list = map.get(name);
  if (list) list.push(value);
  else map.set(name, [value]);
}

function collectCustomPropsFromDeclarations(
  declarations: ReadonlyArray<ParsedCssDeclaration>,
  target: Map<string, string[]>,
): void {
  for (const decl of declarations) {
    if (decl.property.startsWith("--")) {
      addCustomProp(target, decl.property, decl.value);
    }
  }
}

function find13pxInDeclarations(
  declarations: ReadonlyArray<ParsedCssDeclaration>,
  customProps: ReadonlyMap<string, ReadonlyArray<string>>,
): CssFontSize13pxViolation[] {
  const violations: CssFontSize13pxViolation[] = [];
  for (const decl of declarations) {
    let sizeExpr: string | null = null;
    if (decl.property === "font-size") {
      sizeExpr = decl.value;
    } else if (decl.property === "font") {
      sizeExpr = extractFontShorthandSize(decl.value);
    } else if (decl.inThemeBlock && isTailwindThemeTextSizeProp(decl.property)) {
      sizeExpr = decl.value;
    }
    if (sizeExpr === null) continue;

    let resolved = resolve13pxValue(sizeExpr, customProps);
    if (resolved === null && decl.property === "font") {
      const parsed = parseVarExpression(sizeExpr);
      if (parsed) {
        for (const candidate of customProps.get(parsed.name) ?? []) {
          const shorthandSize = extractFontShorthandSize(candidate);
          if (shorthandSize !== null) {
            const innerResolved = resolve13pxValue(
              shorthandSize,
              customProps,
              new Set([parsed.name]),
            );
            if (innerResolved !== null) {
              resolved = `${parsed.name} -> ${innerResolved}`;
              break;
            }
          }
        }
      }
    }
    if (resolved === null) continue;

    violations.push(
      resolved === sizeExpr.trim()
        ? { line: decl.line, declaration: decl.declaration }
        : { line: decl.line, declaration: decl.declaration, resolvedFrom: resolved },
    );
  }
  return violations;
}

export function findCss13pxFontSizesInFiles(
  files: ReadonlyArray<{ readonly file: string; readonly css: string }>,
): ReadonlyArray<CssFontSize13pxFileViolation> {
  const parsedFiles = files.map(({ file, css }) => ({
    file,
    declarations: parseCssDeclarations(css),
  }));
  const customProps = new Map<string, string[]>();
  for (const entry of parsedFiles) {
    collectCustomPropsFromDeclarations(entry.declarations, customProps);
  }

  const violations: CssFontSize13pxFileViolation[] = [];
  for (const entry of parsedFiles) {
    for (const violation of find13pxInDeclarations(entry.declarations, customProps)) {
      violations.push({ file: entry.file, ...violation });
    }
  }
  return violations;
}

export function findCss13pxFontSizes(css: string): ReadonlyArray<CssFontSize13pxViolation> {
  return findCss13pxFontSizesInFiles([{ file: "<inline>", css }]).map(
    ({ file: _file, ...rest }) => rest,
  );
}

export function findCss13pxVariablesInFiles(
  files: ReadonlyArray<{ readonly file: string; readonly css: string }>,
): ReadonlyMap<string, string> {
  const customProps = new Map<string, string[]>();
  for (const entry of files) {
    collectCustomPropsFromDeclarations(parseCssDeclarations(entry.css), customProps);
  }
  const resolved = new Map<string, string>();
  for (const name of customProps.keys()) {
    const target = resolve13pxValue(`var(${name})`, customProps);
    if (target !== null) resolved.set(name, target);
  }
  return resolved;
}

function normalizeTailwindArbitraryValue(raw: string): string {
  return raw.replace(/--[\w-]+|_/gu, (match) => (match === "_" ? " " : match)).trim();
}

function collectTailwindVarTokens(text: string, target: Map<string, string[]>): void {
  for (const token of text.split(/\s+/u)) {
    if (!token) continue;
    const utility = stripVariants(token);
    const varDef = TAILWIND_VAR_DEF_CLASS.exec(utility);
    if (varDef && varDef[1] !== undefined && varDef[2] !== undefined) {
      addCustomProp(target, varDef[1], normalizeTailwindArbitraryValue(varDef[2]));
    }
  }
}

const isClassComposerCall = (node: ESTree.Node): node is ESTree.CallExpression =>
  node.type === "CallExpression" &&
  node.callee.type === "Identifier" &&
  CLASS_COMPOSERS.has(node.callee.name);

function collectStringsFromNode(node: unknown, target: string[]): void {
  if (Array.isArray(node)) {
    for (const item of node) collectStringsFromNode(item, target);
    return;
  }
  if (typeof node !== "object" || node === null || !("type" in node)) return;
  const current = node as ESTree.Node;
  if (/^(?:Conditional|Logical|Object)Expression$/u.test(current.type)) return;
  if (current.type === "CallExpression" && !isClassComposerCall(current)) return;
  if (current.type === "Literal" && typeof current.value === "string") {
    target.push(current.value);
    return;
  }
  if (current.type === "TemplateLiteral") {
    target.push(current.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw).join(" "));
    for (const expr of current.expressions) collectStringsFromNode(expr, target);
    return;
  }
  for (const [key, value] of Object.entries(current)) {
    if (key !== "parent") collectStringsFromNode(value, target);
  }
}

function scopeTailwindVars(node: ESTree.Node, ownText: string): Map<string, string[]> {
  const vars = new Map<string, string[]>();
  collectTailwindVarTokens(ownText, vars);
  const strings: string[] = [];
  let current: ESTree.Node | undefined = node;
  while (current.parent) {
    const parent: ESTree.Node = current.parent;
    if (/Statement$|Declaration$|^JSX(?:Attribute|Element)$/u.test(parent.type)) break;
    if (isClassComposerCall(parent) || parent.type === "ArrayExpression") {
      collectStringsFromNode(parent, strings);
    }
    current = parent;
  }
  for (const str of strings) {
    collectTailwindVarTokens(str, vars);
  }
  return vars;
}

function textOffenders(text: string, tailwindVars: ReadonlyMap<string, string[]>): string[] {
  const found: string[] = [];
  for (const token of text.split(/\s+/u)) {
    if (!token) continue;
    const utility = stripVariants(token);
    if (TEXT_13PX.test(utility)) {
      found.push(token);
      continue;
    }
    const arbFontSize = ARBITRARY_FONT_SIZE_CLASS.exec(utility);
    if (arbFontSize && arbFontSize[1] !== undefined) {
      const value = normalizeTailwindArbitraryValue(arbFontSize[1]);
      if (resolve13pxValue(value, tailwindVars) !== null) {
        found.push(token);
      }
      continue;
    }
    const arbFont = ARBITRARY_FONT_CLASS.exec(utility);
    if (arbFont && arbFont[1] !== undefined) {
      const sizeExpr = extractFontShorthandSize(normalizeTailwindArbitraryValue(arbFont[1]));
      if (sizeExpr !== null && resolve13pxValue(sizeExpr, tailwindVars) !== null) {
        found.push(token);
      }
      continue;
    }
    const lenVar = TEXT_LEN_VAR_PAREN.exec(utility);
    if (lenVar && lenVar[1] !== undefined) {
      if (resolve13pxValue(`var(${lenVar[1]})`, tailwindVars) !== null) {
        found.push(token);
      }
      continue;
    }
    const bracketVar = TEXT_VAR_BRACKET.exec(utility);
    if (bracketVar && bracketVar[1] !== undefined) {
      if (resolve13pxValue(bracketVar[1], tailwindVars) !== null) {
        found.push(token);
      }
    }
  }

  const declarations = parseCssDeclarations(text);
  const inlineVars = new Map<string, string[]>();
  collectCustomPropsFromDeclarations(declarations, inlineVars);
  for (const violation of find13pxInDeclarations(declarations, inlineVars)) {
    found.push(
      violation.resolvedFrom
        ? `${violation.declaration} (${violation.resolvedFrom})`
        : violation.declaration,
    );
  }

  HTML_STYLE_ATTR.lastIndex = 0;
  for (
    let attrMatch = HTML_STYLE_ATTR.exec(text);
    attrMatch !== null;
    attrMatch = HTML_STYLE_ATTR.exec(text)
  ) {
    const attrValue = attrMatch[1] ?? attrMatch[2] ?? "";
    const attrDecls = parseCssDeclarations(attrValue);
    const mergedVars = new Map(inlineVars);
    collectCustomPropsFromDeclarations(attrDecls, mergedVars);
    for (const violation of find13pxInDeclarations(attrDecls, mergedVars)) {
      found.push(
        violation.resolvedFrom
          ? `${violation.declaration} (${violation.resolvedFrom})`
          : violation.declaration,
      );
    }
  }

  return found;
}

function getStaticStringValue(node: ESTree.Node): string | undefined {
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? node.quasis[0]?.value.raw;
  }
  return undefined;
}

function isInsideJsxStyleAttribute(node: ESTree.Node): boolean {
  let current: ESTree.Node | null = node.parent;
  while (current) {
    if (current.type === "JSXExpressionContainer") {
      const attr = current.parent;
      return (
        attr !== null &&
        attr.type === "JSXAttribute" &&
        attr.name.type === "JSXIdentifier" &&
        attr.name.name === "style"
      );
    }
    if (
      current.type === "ConditionalExpression" ||
      current.type === "LogicalExpression" ||
      current.type === "ParenthesizedExpression" ||
      current.type === "TSAsExpression" ||
      current.type === "TSTypeAssertion" ||
      current.type === "TSNonNullExpression"
    ) {
      current = current.parent;
      continue;
    }
    return false;
  }
  return false;
}

const formatMessage = (offender: string) =>
  `${offender} is not on the UI type scale (12, 14, 15, 18, 20px). Use the scale instead: text-2xs (12px) for hints, 14px for clickable text, 15px for body text.`;

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Forbid 13px interface text; the UI type scale is 12, 14, 15, 18, or 20px.",
    },
  },
  create(context) {
    const fileCustomProps = new Map<string, string[]>();
    const deferredChecks: Array<() => void> = [];

    const checkText = (node: ESTree.Node, text: string | null | undefined) => {
      if (!text) return;
      const tailwindVars = scopeTailwindVars(node, text);
      for (const offender of textOffenders(text, tailwindVars)) {
        context.report({ node, message: formatMessage(offender) });
      }
    };

    const inspectSizeExpression = (
      node: unknown,
      mode: "fontSize" | "font",
      allowNumeric13: boolean,
      localVars?: ReadonlyMap<string, ReadonlyArray<string>>,
    ) => {
      const unwrapped = unwrapExpression(node);
      if (Option.isNone(unwrapped)) return;
      const value = unwrapped.value;
      if (value.type === "ConditionalExpression") {
        inspectSizeExpression(value.consequent, mode, allowNumeric13, localVars);
        inspectSizeExpression(value.alternate, mode, allowNumeric13, localVars);
        return;
      }
      if (value.type === "LogicalExpression") {
        inspectSizeExpression(value.left, mode, allowNumeric13, localVars);
        inspectSizeExpression(value.right, mode, allowNumeric13, localVars);
        return;
      }
      if (
        allowNumeric13 &&
        mode === "fontSize" &&
        value.type === "Literal" &&
        typeof value.value === "number" &&
        value.value === 13
      ) {
        context.report({ node: value, message: formatMessage("fontSize: 13") });
        return;
      }
      const strValue = getStaticStringValue(value);
      if (strValue === undefined) return;
      const sizeExpr = mode === "font" ? extractFontShorthandSize(strValue) : strValue.trim();
      if (sizeExpr === null) return;

      const labelPrefix = mode === "font" ? "font" : "fontSize";
      if (LENGTH_13PX.test(sizeExpr)) {
        context.report({ node: value, message: formatMessage(`${labelPrefix}: "${strValue}"`) });
        return;
      }

      if (parseVarExpression(sizeExpr) !== null) {
        const snapshotLocal = localVars ? new Map(localVars) : undefined;
        deferredChecks.push(() => {
          const merged = new Map<string, ReadonlyArray<string>>(fileCustomProps);
          if (snapshotLocal) {
            for (const [key, vals] of snapshotLocal) merged.set(key, vals);
          }
          const resolved = resolve13pxValue(sizeExpr, merged);
          if (resolved !== null) {
            context.report({
              node: value,
              message: formatMessage(`${labelPrefix}: "${strValue}" (${resolved})`),
            });
          }
        });
      }
    };

    return {
      Literal(node) {
        if (typeof node.value !== "string") return;
        const parentType = node.parent.type;
        if (
          parentType === "ImportDeclaration" ||
          parentType === "ExportNamedDeclaration" ||
          parentType === "ExportAllDeclaration"
        ) {
          return;
        }
        checkText(node, node.value);
      },
      TemplateLiteral(node) {
        checkText(
          node,
          node.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw).join(" "),
        );
      },
      ObjectExpression(node) {
        const localVars = new Map<string, string[]>();
        for (const prop of node.properties) {
          if (prop.type !== "Property" || prop.computed) continue;
          const name = Option.getOrUndefined(getPropertyName(prop.key));
          if (!name || !name.startsWith("--")) continue;
          const valNode = unwrapExpression(prop.value);
          if (Option.isNone(valNode)) continue;
          const valStr = getStaticStringValue(valNode.value);
          if (valStr !== undefined) addCustomProp(localVars, name, valStr);
        }

        const allowNumeric13 = isInsideJsxStyleAttribute(node);
        for (const prop of node.properties) {
          if (prop.type !== "Property" || prop.computed) continue;
          const name = Option.getOrUndefined(getPropertyName(prop.key));
          if (name === "fontSize" || name === "font-size") {
            inspectSizeExpression(prop.value, "fontSize", allowNumeric13, localVars);
          } else if (name === "font") {
            inspectSizeExpression(prop.value, "font", false, localVars);
          }
        }
      },
      JSXAttribute(node) {
        if (node.name.type !== "JSXIdentifier") return;
        if (node.name.name !== "fontSize" && node.name.name !== "font-size") return;
        if (!node.value) return;
        if (node.value.type === "Literal") {
          inspectSizeExpression(node.value, "fontSize", false);
        } else if (
          node.value.type === "JSXExpressionContainer" &&
          node.value.expression.type !== "JSXEmptyExpression"
        ) {
          inspectSizeExpression(node.value.expression, "fontSize", false);
        }
      },
      AssignmentExpression(node) {
        if (node.left.type !== "MemberExpression" || node.left.computed) return;
        const propName = Option.getOrUndefined(getPropertyName(node.left.property));
        if (propName === "fontSize") {
          inspectSizeExpression(node.right, "fontSize", false);
        } else if (propName === "font") {
          inspectSizeExpression(node.right, "font", false);
        }
      },
      CallExpression(node) {
        if (
          node.callee.type !== "MemberExpression" ||
          node.callee.computed ||
          Option.getOrUndefined(getPropertyName(node.callee.property)) !== "setProperty" ||
          node.arguments.length < 2
        ) {
          return;
        }
        const propArg = unwrapExpression(node.arguments[0]);
        if (Option.isNone(propArg)) return;
        const propName = getStaticStringValue(propArg.value);
        if (propName === undefined) return;
        if (propName.startsWith("--")) {
          const valArg = unwrapExpression(node.arguments[1]);
          if (Option.isSome(valArg)) {
            const valStr = getStaticStringValue(valArg.value);
            if (valStr !== undefined) addCustomProp(fileCustomProps, propName, valStr);
          }
          return;
        }
        const normalizedProp = propName.toLowerCase();
        if (normalizedProp === "font-size") {
          inspectSizeExpression(node.arguments[1], "fontSize", false);
        } else if (normalizedProp === "font") {
          inspectSizeExpression(node.arguments[1], "font", false);
        }
      },
      "Program:exit"() {
        for (const runCheck of deferredChecks) runCheck();
      },
    };
  },
});

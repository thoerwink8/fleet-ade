import { defineRule, type ESTree } from "@oxlint/plugins";
import * as Option from "effect/Option";

import { getPropertyName, unwrapExpression } from "../utils.ts";

const VALUE_13PX = /^(?:13(?:\.0+)?px|0*\.81250*rem)$/iu;
const TEXT_13PX = /^text-\[(?:length:)?(?:13(?:\.0+)?px|0?\.8125rem)\](?:\/.+)?$/u;
const FONT_SHORTHAND_SIZE_TOKEN =
  /^(?:(?:\d+(?:\.\d+)?|\.\d+)(?:px|rem|em|%|pt|ch|ex|vw|vh|vmin|vmax|cm|mm|in|pc|q|lh|rlh|dvh|svh|lvh|cqw|cqh|cqi|cqb)|(?:calc|clamp|min|max|var)\(|(?:xxx?-small|xxx?-large|xx?-small|xx?-large|small|medium|large|smaller|larger))(?:\/|$)/iu;
const CSS_DECLARATION = /(?<![-\w])(font(?:-size)?|--[\w-]+)\s*:\s*([^;{}"'`\n]+)/giu;

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

const isFontSizeVarName = (name: string) =>
  name.startsWith("--") && /font|text|size/iu.test(name) && !/line-height|leading/iu.test(name);

function has13pxFontShorthand(rawValue: string): boolean {
  const cleaned = rawValue.replace(/\s*!\s*important\b/iu, "").trim();
  for (const token of cleaned.split(/\s+/u)) {
    if (token && FONT_SHORTHAND_SIZE_TOKEN.test(token)) {
      return VALUE_13PX.test(token.split("/", 1)[0] ?? "");
    }
  }
  return false;
}

function is13pxCssDeclaration(property: string, rawValue: string): boolean {
  if (rawValue.includes("]")) return false;
  const cleaned = rawValue.replace(/\s*!\s*important\b/iu, "").trim();
  const lower = property.toLowerCase();
  if (lower === "font-size" || isFontSizeVarName(property)) return VALUE_13PX.test(cleaned);
  return lower === "font" && has13pxFontShorthand(cleaned);
}

export function findCss13pxFontSizes(
  css: string,
): Array<{ readonly line: number; readonly declaration: string }> {
  const masked = css.replace(/\/\*[\s\S]*?\*\//gu, (comment) => comment.replace(/[^\n]/gu, " "));
  const out: Array<{ readonly line: number; readonly declaration: string }> = [];
  for (const m of masked.matchAll(CSS_DECLARATION)) {
    if (m[1] && m[2] && is13pxCssDeclaration(m[1], m[2])) {
      out.push({ line: masked.slice(0, m.index).split("\n").length, declaration: m[0].trim() });
    }
  }
  return out;
}

function offenders(text: string): string[] {
  const found: string[] = [];
  for (const token of text.split(/\s+/u)) {
    if (!token) continue;
    const u = stripVariants(token);
    const arb = /^\[([^:\]]+):(.+)\]$/u.exec(u);
    const arbHit = arb?.[1] && arb[2] && is13pxCssDeclaration(arb[1], arb[2].replaceAll("_", " "));
    if (TEXT_13PX.test(u) || arbHit) found.push(token);
  }
  for (const violation of findCss13pxFontSizes(text)) found.push(violation.declaration);
  return found;
}

function getStaticString(node: ESTree.Node): string | undefined {
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? node.quasis[0]?.value.raw;
  }
  return undefined;
}

function isJsxStyleObject(node: ESTree.Node): boolean {
  for (let cur: ESTree.Node | null = node.parent; cur; cur = cur.parent) {
    if (cur.type === "JSXExpressionContainer") {
      const a = cur.parent;
      return (
        a?.type === "JSXAttribute" && a.name.type === "JSXIdentifier" && a.name.name === "style"
      );
    }
    if (
      !/^(?:Conditional|Logical|Parenthesized)Expression$|^TS(?:As|TypeAssertion|NonNull)Expression$/u.test(
        cur.type,
      )
    ) {
      break;
    }
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
    const checkText = (node: ESTree.Node, text: string | null | undefined) => {
      if (!text) return;
      for (const offender of offenders(text)) {
        context.report({ node, message: formatMessage(offender) });
      }
    };

    const inspectSize = (node: unknown, label: string, shorthand: boolean, allowNum: boolean) => {
      const unwrapped = unwrapExpression(node);
      if (Option.isNone(unwrapped)) return;
      const val = unwrapped.value;
      if (val.type === "ConditionalExpression" || val.type === "LogicalExpression") {
        const isCond = val.type === "ConditionalExpression";
        inspectSize(isCond ? val.consequent : val.left, label, shorthand, allowNum);
        inspectSize(isCond ? val.alternate : val.right, label, shorthand, allowNum);
        return;
      }
      if (allowNum && val.type === "Literal" && val.value === 13) {
        context.report({ node: val, message: formatMessage(`${label}: 13`) });
        return;
      }
      const str = getStaticString(val);
      if (
        str !== undefined &&
        (shorthand ? has13pxFontShorthand(str) : VALUE_13PX.test(str.trim()))
      ) {
        context.report({ node: val, message: formatMessage(`${label}: "${str}"`) });
      }
    };

    const checkProp = (name: string, target: unknown, allowNum = false) => {
      const lower = name.toLowerCase();
      if (lower === "fontsize" || lower === "font-size" || isFontSizeVarName(name)) {
        inspectSize(target, name, false, allowNum && !name.startsWith("--"));
      } else if (lower === "font") {
        inspectSize(target, "font", true, false);
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
      TemplateElement(node) {
        checkText(node, node.value.cooked ?? node.value.raw);
      },
      Property(node) {
        if (node.computed || node.parent?.type !== "ObjectExpression") return;
        const name = Option.getOrUndefined(getPropertyName(node.key));
        if (name) checkProp(name, node.value, isJsxStyleObject(node.parent));
      },
      JSXAttribute(node) {
        if (node.name.type !== "JSXIdentifier" || !node.value) return;
        if (node.name.name !== "fontSize" && node.name.name !== "font-size") return;
        const target =
          node.value.type === "JSXExpressionContainer" ? node.value.expression : node.value;
        inspectSize(target, node.name.name, false, false);
      },
      AssignmentExpression(node) {
        if (node.left.type !== "MemberExpression" || node.left.computed) return;
        const name = Option.getOrUndefined(getPropertyName(node.left.property));
        if (name === "fontSize" || name === "font") checkProp(name, node.right);
      },
      CallExpression(node) {
        if (node.callee.type !== "MemberExpression" || node.callee.computed) return;
        if (Option.getOrUndefined(getPropertyName(node.callee.property)) !== "setProperty") return;
        const propArg = unwrapExpression(node.arguments[0]);
        const propName = Option.isSome(propArg) ? getStaticString(propArg.value) : undefined;
        if (propName && node.arguments[1] !== undefined) checkProp(propName, node.arguments[1]);
      },
    };
  },
});

import { defineRule, type ESTree } from "@oxlint/plugins";
import * as Option from "effect/Option";

import { getPropertyName, unwrapExpression } from "../utils.ts";

const NAMED_HEAVY_WEIGHT = /^font-(?:semibold|bold|extrabold|black)$/u;
const ARBITRARY_FONT_WEIGHT = /^font-\[(?:(?:weight|number):)?(bold|bolder|([1-9]\d{2,3}))\]$/iu;
const ARBITRARY_CSS_FONT_WEIGHT = /^\[font-weight:(bold|bolder|([1-9]\d{2,3}))\]$/iu;
const INLINE_CSS_WEIGHT =
  /font-weight\s*:\s*(bold|bolder|([1-9]\d{2,3}))(?=\s*(?:!important)?\s*(?:[;}"'`]|$))/giu;
const STYLE_STRING_VALUE = /^\s*(bold|bolder|([1-9]\d{2,3}))\s*$/iu;

const formatMessage = (offender: string) =>
  `${offender} sets font weight above 500. UI font weight is capped at 500 (font-medium); distinguish hierarchy with size and color instead.`;

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

function isHeavyNumericOrKeyword(keywordOrNumber: string | undefined, digits: string | undefined) {
  if (digits !== undefined) return Number(digits) > 500;
  return keywordOrNumber !== undefined;
}

function heavyTextOffenders(text: string): string[] {
  const found: string[] = [];
  for (const token of text.split(/\s+/u)) {
    if (!token) continue;
    const utility = stripVariants(token);
    if (NAMED_HEAVY_WEIGHT.test(utility)) {
      found.push(token);
      continue;
    }
    const arbitrary =
      ARBITRARY_FONT_WEIGHT.exec(utility) ?? ARBITRARY_CSS_FONT_WEIGHT.exec(utility);
    if (arbitrary && isHeavyNumericOrKeyword(arbitrary[1], arbitrary[2])) {
      found.push(token);
    }
  }
  INLINE_CSS_WEIGHT.lastIndex = 0;
  for (
    let match = INLINE_CSS_WEIGHT.exec(text);
    match !== null;
    match = INLINE_CSS_WEIGHT.exec(text)
  ) {
    if (isHeavyNumericOrKeyword(match[1], match[2])) {
      found.push(match[0].trim());
    }
  }
  return found;
}

function inspectWeightValue(node: unknown): Array<{ node: ESTree.Node; label: string }> {
  const unwrapped = unwrapExpression(node);
  if (Option.isNone(unwrapped)) return [];
  const value = unwrapped.value;
  if (value.type === "Literal") {
    if (typeof value.value === "number" && value.value > 500) {
      return [{ node: value, label: `fontWeight: ${value.value}` }];
    }
    if (typeof value.value === "string") {
      const match = STYLE_STRING_VALUE.exec(value.value);
      if (match && isHeavyNumericOrKeyword(match[1], match[2])) {
        return [{ node: value, label: `fontWeight: "${value.value}"` }];
      }
    }
    return [];
  }
  if (value.type === "ConditionalExpression") {
    return [...inspectWeightValue(value.consequent), ...inspectWeightValue(value.alternate)];
  }
  if (value.type === "LogicalExpression") {
    return [...inspectWeightValue(value.left), ...inspectWeightValue(value.right)];
  }
  return [];
}

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Cap UI font weights at 500 (font-medium); distinguish hierarchy with size and color instead.",
    },
  },
  create(context) {
    const reportWeightValue = (node: unknown) => {
      for (const finding of inspectWeightValue(node)) {
        context.report({ node: finding.node, message: formatMessage(finding.label) });
      }
    };

    const checkText = (node: ESTree.Node, text: string | null | undefined) => {
      if (!text) return;
      for (const offender of heavyTextOffenders(text)) {
        context.report({ node, message: formatMessage(offender) });
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
        if (Option.getOrUndefined(getPropertyName(node.key)) !== "fontWeight") return;
        reportWeightValue(node.value);
      },
      JSXAttribute(node) {
        if (node.name.type !== "JSXIdentifier") return;
        if (node.name.name !== "fontWeight" && node.name.name !== "font-weight") return;
        if (!node.value) return;
        if (node.value.type === "Literal") {
          reportWeightValue(node.value);
        } else if (
          node.value.type === "JSXExpressionContainer" &&
          node.value.expression.type !== "JSXEmptyExpression"
        ) {
          reportWeightValue(node.value.expression);
        }
      },
      AssignmentExpression(node) {
        if (
          node.left.type === "MemberExpression" &&
          !node.left.computed &&
          Option.getOrUndefined(getPropertyName(node.left.property)) === "fontWeight"
        ) {
          reportWeightValue(node.right);
        }
      },
      CallExpression(node) {
        if (
          node.callee.type === "MemberExpression" &&
          !node.callee.computed &&
          Option.getOrUndefined(getPropertyName(node.callee.property)) === "setProperty" &&
          node.arguments.length >= 2
        ) {
          const propertyArg = unwrapExpression(node.arguments[0]);
          if (
            Option.isSome(propertyArg) &&
            propertyArg.value.type === "Literal" &&
            propertyArg.value.value === "font-weight"
          ) {
            reportWeightValue(node.arguments[1]);
          }
        }
      },
    };
  },
});

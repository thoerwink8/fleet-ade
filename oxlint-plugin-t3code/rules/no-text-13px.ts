import { defineRule, type ESTree } from "@oxlint/plugins";

const TEXT_13PX = /^text-\[(?:length:)?(?:13(?:\.0+)?px|0?\.8125rem)\](?:\/.+)?$/u;

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

function offenders(text: string): string[] {
  const found: string[] = [];
  for (const token of text.split(/\s+/u)) {
    if (!token) continue;
    if (TEXT_13PX.test(stripVariants(token))) found.push(token);
  }
  return found;
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
    };
  },
});

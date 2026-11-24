// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
// Fails when cleaned UI directories/files reintroduce deprecated Chinese/English UI terms.
// Reuses the AST copy-position helpers from `scripts/lib/ui-copy-scan.ts` so comments,
// logs, equality comparisons, internal status/type/kind/data-* fields, and searchTerms stay ignored.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import ts from "typescript-legacy";

import {
  NON_COPY_JSX_ATTRS,
  NON_COPY_PROPS_BASE,
  included,
  isEqualityOrCaseClause,
  isIgnoredInternalCall,
  lineOf,
  literalText,
  propertyName,
  templateSpans,
  walk,
} from "./lib/ui-copy-scan.ts";

interface HardBannedRule {
  readonly label: string;
  readonly pattern: RegExp;
}

const HARD_BANNED_TERMS: ReadonlyArray<HardBannedRule> = [
  { label: "工作区", pattern: /工作区/ },
  { label: "工作副本", pattern: /工作副本/ },
  { label: "独立副本", pattern: /独立副本/ },
  { label: "提供方", pattern: /提供方/ },
  { label: "提供商", pattern: /提供商/ },
  { label: "拉取请求", pattern: /拉取请求/ },
  { label: "合并请求", pattern: /合并请求/ },
  { label: "pull request", pattern: /\bpull request\b/i },
  { label: "检查点", pattern: /检查点/ },
  { label: "从这里编辑", pattern: /从这里编辑/ },
  { label: "收尾", pattern: /收尾/ },
  { label: "保持唤醒", pattern: /保持唤醒/ },
  { label: "收件箱", pattern: /收件箱/ },
  { label: "停止生成", pattern: /停止生成/ },
  { label: "聊天记录", pattern: /聊天记录/ },
  { label: "对话历史", pattern: /对话历史/ },
  { label: "引导当前执行", pattern: /引导当前执行/ },
  { label: "加入队列", pattern: /加入队列/ },
  { label: "追加消息", pattern: /追加消息/ },
  { label: "做完再发", pattern: /做完再发/ },
  { label: "插话", pattern: /插话/ },
  { label: "引导凭据", pattern: /引导凭据/ },
  { label: "配对 URL", pattern: /配对\s*URL/i },
  { label: "默认引用", pattern: /默认引用/ },
  { label: "各不相同", pattern: /各不相同/ },
  { label: "待批准", pattern: /(?<!等)待批准/ },
  { label: "待输入", pattern: /待输入/ },
  { label: "forget", pattern: /\bforget\b/i },
];

// Cleaned directories covered by this guard (`apps/web/src`, `packages/client-runtime/src`, `packages/shared/src`).
const CLEANED_DIRS = [
  "apps/web/src",
  "packages/client-runtime/src",
  "packages/shared/src",
] as const;

// Exact sentences that stay in cleaned paths, keyed by file. A new old term in the same file is still reported.
const EXEMPT_TEXTS: Readonly<Record<string, ReadonlyArray<string>>> = {
  // Matching constant for the server's historical command input (`Orchestrator.ts`).
  "packages/client-runtime/src/state/turnItemPresentation.ts": ["正在准备工作区"],
  // Server-generated background task summary asserted by server tests.
  "packages/shared/src/orchestrationV2PendingBackgroundWork.ts": ["Watching pull request #"],
};

function normalizeRel(filePath: string, rootDir?: string): string {
  const relative = rootDir ? NodePath.relative(rootDir, filePath) : filePath;
  return relative.replaceAll("\\", "/");
}

function collectCleanedFiles(rootDir: string): string[] {
  const files: string[] = [];
  for (const dir of CLEANED_DIRS) {
    walk(NodePath.join(rootDir, dir), files);
  }
  return [...new Set(files)].filter(included).toSorted();
}

export interface OldTermFinding {
  readonly file: string;
  readonly line: number;
  readonly term: string;
  readonly text: string;
}

export function scanSourceTextForOldTerms(
  filePath: string,
  sourceText: string,
): ReadonlyArray<OldTermFinding> {
  const source = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const findings: OldTermFinding[] = [];
  const seen = new Set<string>();

  const checkText = (node: ts.Node, rawText: string): void => {
    const text = rawText.replace(/\s+/g, " ").trim();
    if (text.length === 0) return;
    for (const rule of HARD_BANNED_TERMS) {
      if (!rule.pattern.test(text)) continue;
      const line = lineOf(source, node);
      const dedupeKey = `${String(line)}:${rule.label}:${text}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      findings.push({ file: filePath, line, term: rule.label, text });
    }
  };

  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) ||
      ts.isExportDeclaration(node) ||
      ts.isLiteralTypeNode(node) ||
      ts.isEnumMember(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isInterfaceDeclaration(node)
    ) {
      return;
    }
    if (isEqualityOrCaseClause(node)) return;
    if (ts.isCallExpression(node) && isIgnoredInternalCall(node)) return;

    if (ts.isJsxText(node)) {
      checkText(node, node.text);
      return;
    }

    if (ts.isJsxAttribute(node)) {
      const attrName = node.name.getText(source);
      if (attrName.startsWith("data-") || NON_COPY_JSX_ATTRS[attrName] === true) {
        return;
      }
      if (node.initializer) {
        visit(node.initializer);
      }
      return;
    }

    if (ts.isPropertyAssignment(node)) {
      const prop = propertyName(node.name);
      if (prop === "searchTerms" || prop === "cause") return;
      if (prop !== undefined && NON_COPY_PROPS_BASE[prop] === true) {
        // Container properties such as `action: { label: "…" }` still carry UI copy inside
        // nested objects or JSX, whereas primitive/string-array machine tags do not.
        if (prop === "action" && literalText(node.initializer) === undefined) {
          visit(node.initializer);
        }
        return;
      }
    }

    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      checkText(node, node.text);
      return;
    }

    if (ts.isTemplateExpression(node)) {
      for (const spanText of templateSpans(node)) {
        checkText(node, spanText);
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(source);
  return findings;
}

export function scanCleanedPaths(rootDir: string): ReadonlyArray<OldTermFinding> {
  const findings: OldTermFinding[] = [];
  for (const file of collectCleanedFiles(rootDir)) {
    const text = NodeFS.readFileSync(file, "utf8");
    const rel = normalizeRel(file, rootDir);
    const exempt = EXEMPT_TEXTS[rel] ?? [];
    findings.push(
      ...scanSourceTextForOldTerms(rel, text).filter((finding) => !exempt.includes(finding.text)),
    );
  }
  return findings;
}

if (process.argv[1] && NodeURL.pathToFileURL(process.argv[1]).href === import.meta.url) {
  const rootDir = process.argv[2] ?? process.cwd();
  const findings = scanCleanedPaths(rootDir);
  if (findings.length > 0) {
    for (const finding of findings) {
      console.log(`${finding.file}:${String(finding.line)}  [${finding.term}]  ${finding.text}`);
    }
    process.exitCode = 1;
  }
}

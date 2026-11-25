// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
// Checks that relative links in README.md and docs/**/*.md, plus repo docs links
// in apps/web/src and packages/*/src, point to existing files and headings.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import ts from "typescript-legacy";

export interface DocLinkFinding {
  readonly file: string;
  readonly line: number;
  readonly kind: "missing-file" | "missing-anchor";
  readonly link: string;
  readonly target: string;
  readonly anchor?: string;
}

export interface ExtractedMarkdownLink {
  readonly line: number;
  readonly target: string;
}

export interface SourceDocLink {
  readonly line: number;
  readonly link: string;
  readonly target: string;
  readonly anchor?: string;
}

const SOURCE_FILE_PATTERN = /\.(?:[cm]?[jt]sx?)$/;
const IGNORED_SOURCE_PATTERN = /\.(?:test|browser\.test|spec|stories)\./;
const URI_SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const REPO_DOC_URL_PATTERN =
  /https?:\/\/(?:github\.com\/(?:thoerwink8\/fleet-ade|pingdotgg\/t3code)\/(?:blob|tree)|raw\.githubusercontent\.com\/(?:thoerwink8\/fleet-ade|pingdotgg\/t3code))\/[^/\s#?]+\/(docs\/[^\s#?'"`()<>]+|README\.md)(?:\?[^\s#'"`()<>]*)?(?:#([^\s'"`()<>]+))?/g;
const RELATIVE_DOC_LINK_PATTERN =
  /(?:^|[\s("'`[])(?:\.?\/)?(docs\/[^\s"'`<>#?()[\]]+\.md)(?:#([^\s"'`<>()[\]]+))?/g;
const ANY_HTTP_URL_PATTERN = /https?:\/\/[^\s"'`<>()[\]]+/g;

// GitHub PR template filenames probed in target repositories, not links into this repo's docs.
const SOURCE_EXEMPT_TARGETS: Readonly<Record<string, ReadonlyArray<string>>> = {
  "packages/source-control-github/src/server/gitHubChangeRequestTemplate.ts": [
    "docs/pull_request_template.md",
    "docs/PULL_REQUEST_TEMPLATE.md",
  ],
};

function normalizeRel(filePath: string, rootDir?: string): string {
  const relative = rootDir ? NodePath.relative(rootDir, filePath) : filePath;
  return relative.replaceAll("\\", "/");
}

function walkFiles(dir: string, out: string[]): void {
  if (!NodeFS.existsSync(dir)) return;
  for (const entry of NodeFS.readdirSync(dir, { withFileTypes: true })) {
    const full = NodePath.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      walkFiles(full, out);
    } else {
      out.push(full);
    }
  }
}

function isIncludedSourceFile(filePath: string): boolean {
  const rel = filePath.replaceAll("\\", "/");
  if (!SOURCE_FILE_PATTERN.test(rel) || rel.endsWith(".d.ts")) return false;
  if (IGNORED_SOURCE_PATTERN.test(rel)) return false;
  if (rel.endsWith(".gen.ts") || rel.includes("/_generated/")) return false;
  return true;
}

function isEscaped(text: string, index: number): boolean {
  let backslashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function maskSpanPreservingNewlines(text: string): string {
  return text.replace(/[^\n]/g, " ");
}

function maskFencedCodeBlocks(markdownText: string): string {
  const lines = markdownText.split("\n");
  let fence: { readonly char: string; readonly length: number } | undefined;
  const masked: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const match = /^[ ]{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (match) {
      const marker = match[1]!;
      const rest = match[2] ?? "";
      const char = marker[0]!;
      if (!fence) {
        if (char !== "`" || !rest.includes("`")) {
          fence = { char, length: marker.length };
          masked.push(" ".repeat(rawLine.length));
          continue;
        }
      } else if (char === fence.char && marker.length >= fence.length && /^[ \t]*$/.test(rest)) {
        fence = undefined;
        masked.push(" ".repeat(rawLine.length));
        continue;
      }
    }

    masked.push(fence ? " ".repeat(rawLine.length) : rawLine);
  }

  return masked.join("\n");
}

function findInlineCodeSpanEnd(text: string, contentStart: number, tickLength: number): number {
  let index = contentStart;
  while (index < text.length) {
    if (text[index] === "\n") {
      const rest = text.slice(index + 1);
      if (/^[ \t]*\r?\n/.test(rest)) return -1;
      index += 1;
      continue;
    }
    if (text[index] === "`") {
      let end = index;
      while (end < text.length && text[end] === "`") end += 1;
      if (end - index === tickLength) return index;
      index = end;
      continue;
    }
    index += 1;
  }
  return -1;
}

function maskInlineCodeSpans(text: string): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    if (text[index] === "`" && !isEscaped(text, index)) {
      let tickEnd = index;
      while (tickEnd < text.length && text[tickEnd] === "`") tickEnd += 1;
      const tickLength = tickEnd - index;
      const closeIndex = findInlineCodeSpanEnd(text, tickEnd, tickLength);
      if (closeIndex !== -1) {
        const spanEnd = closeIndex + tickLength;
        out += maskSpanPreservingNewlines(text.slice(index, spanEnd));
        index = spanEnd;
        continue;
      }
      out += text.slice(index, tickEnd);
      index = tickEnd;
      continue;
    }
    out += text[index];
    index += 1;
  }
  return out;
}

function maskMarkdownCodeAndComments(markdownText: string): string {
  const withoutFences = maskFencedCodeBlocks(markdownText);
  const withoutInlineCode = maskInlineCodeSpans(withoutFences);
  return withoutInlineCode.replace(/<!--[\s\S]*?-->/g, maskSpanPreservingNewlines);
}

function lineAtOffset(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

function extractInlineCodeTokens(text: string): {
  readonly masked: string;
  readonly tokens: ReadonlyArray<string>;
} {
  const tokens: string[] = [];
  let out = "";
  let index = 0;
  while (index < text.length) {
    if (text[index] === "`" && !isEscaped(text, index)) {
      let tickEnd = index;
      while (tickEnd < text.length && text[tickEnd] === "`") tickEnd += 1;
      const tickLength = tickEnd - index;
      const closeIndex = findInlineCodeSpanEnd(text, tickEnd, tickLength);
      if (closeIndex !== -1) {
        let inner = text.slice(tickEnd, closeIndex);
        if (
          inner.length >= 2 &&
          inner.startsWith(" ") &&
          inner.endsWith(" ") &&
          /[^ ]/.test(inner)
        ) {
          inner = inner.slice(1, -1);
        }
        const tokenIndex = tokens.length;
        tokens.push(inner);
        out += `\uE000${String(tokenIndex)}\uE001`;
        index = closeIndex + tickLength;
        continue;
      }
      out += text.slice(index, tickEnd);
      index = tickEnd;
      continue;
    }
    out += text[index];
    index += 1;
  }
  return { masked: out, tokens };
}

function stripMarkdownInline(text: string): string {
  const { masked, tokens } = extractInlineCodeTokens(text);
  let plain = masked;
  plain = plain.replace(/<[^>]+>/g, "");
  plain = plain.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  plain = plain.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  plain = plain.replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1");
  plain = plain.replace(/(\*\*|__|~~)(.+?)\1/g, "$2");
  plain = plain.replace(/(?<!\w)(\*|_)(.+?)\1(?!\w)/g, "$2");
  plain = plain.replace(/\\([\\`*_{}[\]()#+\-.!~|<>])/g, "$1");
  return plain.replace(/\uE000(\d+)\uE001/g, (_, idx) => tokens[Number(idx)] ?? "");
}

// Matches GitHub's heading anchor generation (lowercase, strip non-word punctuation, spaces to `-`).
export function slugifyHeading(rawHeading: string): string {
  return stripMarkdownInline(rawHeading)
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}_ -]/gu, "")
    .replace(/ /g, "-");
}

export function extractMarkdownAnchors(markdownText: string): ReadonlySet<string> {
  const withoutFences = maskFencedCodeBlocks(markdownText);
  const anchors = new Set<string>();

  for (const line of withoutFences.split("\n")) {
    const cleanLine = line.endsWith("\r") ? line.slice(0, -1) : line;
    for (const match of cleanLine.matchAll(
      /<(?:a|h[1-6]|div|span|section)\b[^>]*\b(?:id|name)=["']([^"']+)["']/gi,
    )) {
      if (match[1]) anchors.add(match[1]);
    }
    const headingMatch = /^[ ]{0,3}#{1,6}[ \t]+(.+?)(?:[ \t]+#+[ \t]*)?$/.exec(cleanLine);
    if (!headingMatch) continue;
    const base = slugifyHeading(headingMatch[1]!);
    let slug = base;
    if (anchors.has(slug)) {
      let suffix = 1;
      while (anchors.has(`${base}-${String(suffix)}`)) suffix += 1;
      slug = `${base}-${String(suffix)}`;
    }
    anchors.add(slug);
  }

  return anchors;
}

function findMatchingClosingBracket(text: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "\\" && i + 1 < text.length) {
      i += 1;
      continue;
    }
    if (ch === "\n" && /^[ \t]*\r?\n/.test(text.slice(i + 1))) {
      return -1;
    }
    if (ch === "[") {
      depth += 1;
    } else if (ch === "]") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function parseInlineLinkDestination(
  text: string,
  openParenIndex: number,
): { readonly target: string; readonly endIndex: number } | undefined {
  let index = openParenIndex + 1;
  while (index < text.length && /[ \t\r\n]/.test(text[index]!)) index += 1;
  if (index >= text.length) return undefined;

  let target = "";
  if (text[index] === "<") {
    index += 1;
    const start = index;
    while (index < text.length && text[index] !== ">") {
      if (text[index] === "\n" || text[index] === "\r") return undefined;
      if (text[index] === "\\" && index + 1 < text.length) index += 1;
      index += 1;
    }
    if (index >= text.length || text[index] !== ">") return undefined;
    target = text.slice(start, index);
    index += 1;
  } else {
    const start = index;
    let parenDepth = 0;
    while (index < text.length) {
      const ch = text[index]!;
      if (ch === "\\" && index + 1 < text.length) {
        index += 2;
        continue;
      }
      if (/[ \t\r\n]/.test(ch)) break;
      if (ch === "(") {
        parenDepth += 1;
      } else if (ch === ")") {
        if (parenDepth === 0) break;
        parenDepth -= 1;
      }
      index += 1;
    }
    if (parenDepth !== 0) return undefined;
    target = text.slice(start, index);
  }

  while (index < text.length && /[ \t\r\n]/.test(text[index]!)) index += 1;
  if (index < text.length && (text[index] === '"' || text[index] === "'" || text[index] === "(")) {
    const closeQuote = text[index] === "(" ? ")" : text[index]!;
    index += 1;
    while (index < text.length && text[index] !== closeQuote) {
      if (text[index] === "\\" && index + 1 < text.length) index += 1;
      index += 1;
    }
    if (index >= text.length) return undefined;
    index += 1;
    while (index < text.length && /[ \t\r\n]/.test(text[index]!)) index += 1;
  }

  if (text[index] !== ")") return undefined;
  return { target, endIndex: index };
}

export function extractMarkdownLinks(markdownText: string): ReadonlyArray<ExtractedMarkdownLink> {
  const masked = maskMarkdownCodeAndComments(markdownText);
  const links: ExtractedMarkdownLink[] = [];

  for (let i = 0; i < masked.length; i += 1) {
    if (masked[i] !== "[" || isEscaped(masked, i)) continue;
    if (i > 0 && masked[i - 1] === "!" && !isEscaped(masked, i - 1)) continue;
    const closeBracket = findMatchingClosingBracket(masked, i);
    if (closeBracket === -1 || masked[closeBracket + 1] !== "(") continue;
    const parsed = parseInlineLinkDestination(masked, closeBracket + 1);
    if (!parsed) continue;
    if (parsed.target.length > 0) {
      links.push({ line: lineAtOffset(masked, i), target: parsed.target });
    }
  }

  for (const match of masked.matchAll(/^[ ]{0,3}\[[^\]]+\]:[ \t]*<?([^\s>\r\n]+)>?/gm)) {
    const target = match[1];
    if (target) {
      links.push({ line: lineAtOffset(masked, match.index), target });
    }
  }

  for (const match of masked.matchAll(/<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    const target = match[1] ?? match[2];
    if (target) {
      links.push({ line: lineAtOffset(masked, match.index), target });
    }
  }

  return links.toSorted((left, right) => left.line - right.line);
}

export function scanSourceTextForDocLinks(
  filePath: string,
  sourceText: string,
): ReadonlyArray<SourceDocLink> {
  if (!/docs\/|README\.md/i.test(sourceText)) return [];

  const source = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith(".tsx") || filePath.endsWith(".jsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const findings: SourceDocLink[] = [];
  const seen = new Set<string>();

  const record = (line: number, link: string, target: string, anchor: string | undefined): void => {
    const normalizedAnchor = anchor && anchor.length > 0 ? anchor : undefined;
    const dedupeKey = `${String(line)}:${target}:${normalizedAnchor ?? ""}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    findings.push(
      normalizedAnchor !== undefined
        ? { line, link, target, anchor: normalizedAnchor }
        : { line, link, target },
    );
  };

  const checkText = (node: ts.Node, text: string): void => {
    if (!/docs\/|README\.md/i.test(text)) return;
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

    for (const match of text.matchAll(REPO_DOC_URL_PATTERN)) {
      const target = match[1];
      if (!target) continue;
      record(line, match[0], target, match[2]);
    }

    // Strip all HTTP(S) URLs before matching bare `docs/...md` strings so external docs URLs stay ignored.
    const withoutHttpUrls = text.replace(ANY_HTTP_URL_PATTERN, " ");
    for (const match of withoutHttpUrls.matchAll(RELATIVE_DOC_LINK_PATTERN)) {
      const target = match[1];
      if (!target) continue;
      const anchor = match[2];
      const rawLink = anchor ? `${target}#${anchor}` : target;
      record(line, rawLink, target, anchor);
    }
  };

  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) ||
      ts.isExportDeclaration(node) ||
      ts.isLiteralTypeNode(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isInterfaceDeclaration(node)
    ) {
      return;
    }

    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      checkText(node, node.text);
      return;
    }

    if (ts.isTemplateExpression(node)) {
      checkText(node.head, node.head.text);
      for (const span of node.templateSpans) {
        visit(span.expression);
        checkText(span.literal, span.literal.text);
      }
      return;
    }

    ts.forEachChild(node, visit);
  };

  visit(source);
  return findings;
}

function safeDecode(
  value: string,
): { readonly ok: true; readonly value: string } | { readonly ok: false } {
  try {
    return { ok: true, value: decodeURIComponent(value) };
  } catch {
    return { ok: false };
  }
}

function collectMarkdownFiles(rootDir: string): string[] {
  const files: string[] = [];
  const rootReadme = NodePath.join(rootDir, "README.md");
  if (NodeFS.existsSync(rootReadme)) files.push(rootReadme);
  const docsFiles: string[] = [];
  walkFiles(NodePath.join(rootDir, "docs"), docsFiles);
  for (const file of docsFiles) {
    if (file.endsWith(".md")) files.push(file);
  }
  return files.toSorted();
}

function collectSourceFiles(rootDir: string): string[] {
  const files: string[] = [];
  walkFiles(NodePath.join(rootDir, "apps/web/src"), files);
  const packagesDir = NodePath.join(rootDir, "packages");
  if (NodeFS.existsSync(packagesDir)) {
    for (const entry of NodeFS.readdirSync(packagesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      walkFiles(NodePath.join(packagesDir, entry.name, "src"), files);
    }
  }
  return files.filter(isIncludedSourceFile).toSorted();
}

export function scanDocsLinks(rootDir: string): ReadonlyArray<DocLinkFinding> {
  const resolvedRoot = NodePath.resolve(rootDir);
  const dirEntriesCache = new Map<string, ReadonlySet<string>>();
  const anchorCache = new Map<string, ReadonlySet<string>>();
  const findings: DocLinkFinding[] = [];

  const isInsideRoot = (candidate: string): boolean => {
    const rel = NodePath.relative(resolvedRoot, candidate);
    return rel === "" || (!rel.startsWith("..") && !NodePath.isAbsolute(rel));
  };

  const existsCaseSensitive = (targetPath: string): boolean => {
    if (!isInsideRoot(targetPath) || !NodeFS.existsSync(targetPath)) return false;
    let current = NodePath.resolve(targetPath);
    while (current !== resolvedRoot) {
      const parent = NodePath.dirname(current);
      if (parent === current) return false;
      const base = NodePath.basename(current);
      let entries = dirEntriesCache.get(parent);
      if (!entries) {
        entries = new Set(NodeFS.readdirSync(parent));
        dirEntriesCache.set(parent, entries);
      }
      if (!entries.has(base)) return false;
      current = parent;
    }
    return true;
  };

  const getAnchors = (mdPath: string): ReadonlySet<string> => {
    const key = NodePath.resolve(mdPath);
    let anchors = anchorCache.get(key);
    if (!anchors) {
      anchors = extractMarkdownAnchors(NodeFS.readFileSync(key, "utf8"));
      anchorCache.set(key, anchors);
    }
    return anchors;
  };

  const verifyTarget = (input: {
    readonly relFile: string;
    readonly line: number;
    readonly link: string;
    readonly targetPath: string;
    readonly rawAnchor: string | undefined;
  }): void => {
    const targetRel = normalizeRel(input.targetPath, resolvedRoot);
    if (!existsCaseSensitive(input.targetPath)) {
      findings.push({
        file: input.relFile,
        line: input.line,
        kind: "missing-file",
        link: input.link,
        target: targetRel,
      });
      return;
    }

    if (input.rawAnchor === undefined || input.rawAnchor.length === 0) return;
    const decodedAnchor = safeDecode(input.rawAnchor);
    const anchor = decodedAnchor.ok ? decodedAnchor.value : input.rawAnchor;
    if (NodeFS.statSync(input.targetPath).isDirectory()) {
      findings.push({
        file: input.relFile,
        line: input.line,
        kind: "missing-anchor",
        link: input.link,
        target: targetRel,
        anchor,
      });
      return;
    }
    if (!input.targetPath.toLowerCase().endsWith(".md")) return;

    const anchors = getAnchors(input.targetPath);
    if (!decodedAnchor.ok || !anchors.has(anchor)) {
      findings.push({
        file: input.relFile,
        line: input.line,
        kind: "missing-anchor",
        link: input.link,
        target: targetRel,
        anchor,
      });
    }
  };

  for (const mdFile of collectMarkdownFiles(resolvedRoot)) {
    const relFile = normalizeRel(mdFile, resolvedRoot);
    const text = NodeFS.readFileSync(mdFile, "utf8");
    for (const extracted of extractMarkdownLinks(text)) {
      const dest = extracted.target.trim();
      if (dest.length === 0 || dest.startsWith("//") || URI_SCHEME_PATTERN.test(dest)) continue;
      const hashIndex = dest.indexOf("#");
      const rawFileAndQuery = hashIndex >= 0 ? dest.slice(0, hashIndex) : dest;
      const rawAnchor = hashIndex >= 0 ? dest.slice(hashIndex + 1) : undefined;
      const queryIndex = rawFileAndQuery.indexOf("?");
      const rawFilePart = queryIndex >= 0 ? rawFileAndQuery.slice(0, queryIndex) : rawFileAndQuery;
      const decodedFile = safeDecode(rawFilePart);
      if (!decodedFile.ok) {
        findings.push({
          file: relFile,
          line: extracted.line,
          kind: "missing-file",
          link: dest,
          target: rawFilePart,
        });
        continue;
      }
      const filePart = decodedFile.value;
      const targetPath =
        filePart === ""
          ? mdFile
          : filePart.startsWith("/")
            ? NodePath.resolve(resolvedRoot, filePart.slice(1))
            : NodePath.resolve(NodePath.dirname(mdFile), filePart);
      verifyTarget({
        relFile,
        line: extracted.line,
        link: dest,
        targetPath,
        rawAnchor,
      });
    }
  }

  for (const sourceFile of collectSourceFiles(resolvedRoot)) {
    const relFile = normalizeRel(sourceFile, resolvedRoot);
    const sourceText = NodeFS.readFileSync(sourceFile, "utf8");
    const exemptTargets = SOURCE_EXEMPT_TARGETS[relFile] ?? [];
    for (const found of scanSourceTextForDocLinks(relFile, sourceText)) {
      if (exemptTargets.includes(found.target)) continue;
      const decodedTarget = safeDecode(found.target);
      if (!decodedTarget.ok) {
        findings.push({
          file: relFile,
          line: found.line,
          kind: "missing-file",
          link: found.link,
          target: found.target,
        });
        continue;
      }
      const targetPath = NodePath.resolve(resolvedRoot, decodedTarget.value);
      verifyTarget({
        relFile,
        line: found.line,
        link: found.link,
        targetPath,
        rawAnchor: found.anchor,
      });
    }
  }

  return findings.toSorted(
    (left, right) =>
      (left.file < right.file ? -1 : left.file > right.file ? 1 : 0) ||
      left.line - right.line ||
      (left.link < right.link ? -1 : left.link > right.link ? 1 : 0),
  );
}

if (process.argv[1] && NodeURL.pathToFileURL(process.argv[1]).href === import.meta.url) {
  const rootDir = process.argv[2] ?? process.cwd();
  const findings = scanDocsLinks(rootDir);
  if (findings.length > 0) {
    for (const finding of findings) {
      if (finding.kind === "missing-anchor") {
        console.log(
          `${finding.file}:${String(finding.line)}  [missing-anchor]  ${finding.link} (missing #${finding.anchor ?? ""} in ${finding.target})`,
        );
      } else {
        console.log(
          `${finding.file}:${String(finding.line)}  [missing-file]  ${finding.link} -> ${finding.target}`,
        );
      }
    }
    process.exitCode = 1;
  }
}

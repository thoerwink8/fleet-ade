import * as Schema from "effect/Schema";

export const ThreadLinksExpect = Schema.Struct({
  /**
   * Thread links the final answer must render clickable, each as its exact href, in a Markdown
   * link or autolink outside code. Bare thread hrefs never count: clients don't autolink them.
   */
  linked: Schema.optional(Schema.Array(Schema.String)),
  /**
   * Mentions the final answer must carry as plain text: present in what the reader sees, and not
   * the label of any Markdown link. Inline code around a mention is fine.
   */
  plainText: Schema.optional(Schema.Array(Schema.String)),
});

interface MarkdownLink {
  readonly label: string;
  readonly href: string;
}

type Range = readonly [start: number, end: number];

const inRanges = (ranges: ReadonlyArray<Range>, index: number) =>
  ranges.some(([start, end]) => index >= start && index < end);

/** Lines from an opening run of 3+ backticks or tildes to a closing run of the same character. */
const fenceRanges = (markdown: string): Array<Range> => {
  const ranges: Array<Range> = [];
  let open: { char: string; length: number; start: number } | null = null;
  let lineStart = 0;
  for (const line of markdown.split("\n")) {
    const end = lineStart + line.length;
    const trimmed = line.trimStart();
    if (open === null) {
      const opening = /^(`{3,}|~{3,})/.exec(trimmed);
      if (opening) open = { char: opening[1]![0]!, length: opening[1]!.length, start: lineStart };
    } else if (new RegExp(`^\\${open.char}{${open.length},}\\s*$`).test(trimmed)) {
      ranges.push([open.start, end]);
      open = null;
    }
    lineStart = end + 1;
  }
  if (open !== null) ranges.push([open.start, markdown.length]);
  return ranges;
};

const INLINE_CODE = /(?<ticks>`+)[^\n]*?\k<ticks>/g;
const LABELED_LINK = /\[(?<label>[^\]\n]*)\]\((?:<(?<angleHref>[^\s<>]+)>|(?<href>[^\s>)]+))\)/g;
const AUTOLINK = /<(?<auto>\w[\w+.-]*:\/\/[^\s<>]+)>/g;

/** Backslash escapes keep punctuation literal, so masked scanning never opens code on `\``. */
const maskEscapes = (markdown: string) =>
  markdown.replace(/\\[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/g, (pair) => " ".repeat(pair.length));

interface ScannedMarkdown {
  /** Labeled links and autolinks outside code, in reading order. */
  readonly links: ReadonlyArray<MarkdownLink>;
  /** The prose with every link replaced by its visible text: its label, or an autolink's href. */
  readonly visibleText: string;
}

/** The chat renderer's link semantics, closely enough for grading: code wins over links. */
const scanMarkdownLinks = (markdown: string): ScannedMarkdown => {
  const masked = maskEscapes(markdown);
  const ranges: Array<Range> = fenceRanges(markdown);
  INLINE_CODE.lastIndex = 0;
  for (const match of masked.matchAll(INLINE_CODE)) {
    if (match.index !== undefined && !inRanges(ranges, match.index))
      ranges.push([match.index, match.index + match[0].length]);
  }
  const inCode = (index: number) => inRanges(ranges, index);

  interface Segment {
    readonly start: number;
    readonly end: number;
    readonly visible: string;
    readonly href: string;
  }
  const segments: Array<Segment> = [];
  LABELED_LINK.lastIndex = 0;
  for (const match of markdown.matchAll(LABELED_LINK)) {
    if (match.index === undefined || inCode(match.index)) continue;
    const href = match.groups?.["angleHref"] ?? match.groups?.["href"];
    if (href === undefined) continue;
    segments.push({
      start: match.index,
      end: match.index + match[0].length,
      visible: match.groups?.["label"] ?? "",
      href,
    });
  }
  const labeledRanges = segments.map(({ start, end }): Range => [start, end]);
  AUTOLINK.lastIndex = 0;
  for (const match of markdown.matchAll(AUTOLINK)) {
    if (match.index === undefined || inCode(match.index) || inRanges(labeledRanges, match.index))
      continue;
    const href = match.groups?.["auto"] ?? "";
    segments.push({ start: match.index, end: match.index + match[0].length, visible: href, href });
  }
  segments.sort((a, b) => a.start - b.start);

  const links = segments.map(({ visible: label, href }) => ({ label, href }));
  let visibleText = "";
  let cursor = 0;
  for (const segment of segments) {
    visibleText += markdown.slice(cursor, segment.start) + segment.visible;
    cursor = segment.end;
  }
  visibleText += markdown.slice(cursor);
  // Backslash escapes are markup, not visible text.
  return {
    links,
    visibleText: visibleText.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, "$1"),
  };
};

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Thread links in the final answer, graded the way chat renders them: code spans and fences
 * never yield links, a link's target is exact, and a mention written as a link's label is
 * clickable, never plain. Every `t3-thread://` target the answer carries must be one the case
 * allows; inventing targets for threads, files, or PRs fails even when `linked` is unset.
 */
export const gradeThreadLinks = (
  expect: typeof ThreadLinksExpect.Type | undefined,
  finalText: string | undefined,
): Array<{ check: string; pass: boolean }> => {
  if (expect === undefined) return [];
  if (finalText === undefined) {
    return [
      { check: "threadLinks final answer present", pass: false },
      ...(expect.linked ?? []).map((href) => ({ check: `threadLinks ${href}`, pass: false })),
    ];
  }
  const { links, visibleText } = scanMarkdownLinks(finalText);
  const checks: Array<{ check: string; pass: boolean }> = [];
  const allowed = new Set(expect.linked ?? []);
  for (const href of expect.linked ?? []) {
    checks.push({
      check: `threadLinks ${href}`,
      pass: links.some((link) => link.href === href),
    });
  }
  const invented = [...new Set(links.map((link) => link.href))].filter(
    (href) => href.startsWith("t3-thread://") && !allowed.has(href),
  );
  checks.push({
    check: `threadLinks none invented${invented.length ? `: ${invented.join(", ")}` : ""}`,
    pass: invented.length === 0,
  });
  for (const mention of expect.plainText ?? []) {
    const present = new RegExp(escapeRegExp(mention)).test(visibleText);
    const asLabel = links.some((link) => link.label.includes(mention));
    checks.push({
      check: `threadLinks plain ${mention}${!present ? " (missing)" : asLabel ? " (a link label)" : ""}`,
      pass: present && !asLabel,
    });
  }
  return checks;
};

import { scanChatMarkdown } from "@t3tools/shared/markdownPipeline";
import * as Schema from "effect/Schema";

const LinkedThread = Schema.Struct({
  /** The thread's name as the wake presented it; an exact-target link must carry it as label. */
  label: Schema.String,
  /** The exact href the final answer must render clickable for this thread. */
  href: Schema.String,
});

export const ThreadLinksExpect = Schema.Struct({
  /**
   * Thread links the final answer must render as real chat anchors, each with its exact target
   * and the thread's name in the label. Only rendered anchors count: links inside code or
   * comments are invisible, and bare thread hrefs never count because clients don't autolink
   * them.
   */
  linked: Schema.optional(Schema.Array(LinkedThread)),
  /**
   * Mentions the final answer must carry as plain text: present in what the reader sees, and
   * never the label of any anchor. Inline code around a mention is fine.
   */
  plainText: Schema.optional(
    Schema.Array(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
  ),
});

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Graded on the anchors and visible text the ChatMarkdown pipeline itself produces. Every
 * `t3-thread://` target the answer renders must be one the case allows; invented targets fail
 * even when `linked` is unset.
 */
export const gradeThreadLinks = (
  expect: typeof ThreadLinksExpect.Type | undefined,
  finalText: string | undefined,
): Array<{ check: string; pass: boolean }> => {
  if (expect === undefined) return [];
  if (finalText === undefined) {
    return [
      { check: "threadLinks final answer present", pass: false },
      ...(expect.linked ?? []).map(({ href }) => ({ check: `threadLinks ${href}`, pass: false })),
    ];
  }
  const { anchors, visibleText } = scanChatMarkdown(finalText);
  const checks: Array<{ check: string; pass: boolean }> = [];
  const allowed = new Set((expect.linked ?? []).map(({ href }) => href));
  for (const { label, href } of expect.linked ?? []) {
    const linked = anchors.some((anchor) => anchor.href === href && anchor.label.includes(label));
    checks.push({
      check: `threadLinks ${href}${linked ? "" : labelInAnchors(anchors, label, href)}`,
      pass: linked,
    });
  }
  const rendered = [...new Set(anchors.map(({ href }) => href))].filter(
    (href): href is string => href !== undefined && href.startsWith("t3-thread://"),
  );
  const invented = rendered.filter((href) => !allowed.has(href));
  checks.push({
    check: `threadLinks none invented${invented.length ? `: ${invented.join(", ")}` : ""}`,
    pass: invented.length === 0,
  });
  for (const mention of expect.plainText ?? []) {
    // An array entry is satisfied by any one of its forms: a mention counts when the summary
    // names the thread in any recognizable plain phrasing.
    const forms = Array.isArray(mention) ? mention : [mention];
    const name = forms[0] ?? "";
    const present = forms.some((form) => new RegExp(escapeRegExp(form)).test(visibleText));
    const asLabel = forms.some((form) => anchors.some((anchor) => anchor.label.includes(form)));
    checks.push({
      check: `threadLinks plain ${name}${!present ? " (missing)" : asLabel ? " (a link label)" : ""}`,
      pass: present && !asLabel,
    });
  }
  return checks;
};

function labelInAnchors(
  anchors: ReadonlyArray<{ readonly href: string | undefined; readonly label: string }>,
  label: string,
  href: string,
) {
  if (anchors.some((anchor) => anchor.href === href)) return " (label missing the thread name)";
  if (anchors.some((anchor) => anchor.label.includes(label)))
    return ` (linked to the wrong target)`;
  return "";
}

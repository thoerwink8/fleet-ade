import { TextGenerationError, type TextGenerationFailureReason } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const isTextGenerationError = Schema.is(TextGenerationError);
const decodeJsonThreadTitle = Schema.decodeOption(
  Schema.fromJsonString(Schema.Struct({ title: Schema.String })),
);

export function toJsonSchemaObject(schema: Schema.Top): unknown {
  const document = Schema.toJsonSchemaDocument(Schema.toType(schema), {
    onExcessProperty: "error",
  });
  if (document.definitions && Object.keys(document.definitions).length > 0) {
    return { ...document.schema, $defs: document.definitions };
  }
  return document.schema;
}

export function limitSection(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  // Half an emoji serializes to a lone surrogate escape, which provider JSON parsers reject.
  const last = value.charCodeAt(maxChars - 1);
  const truncated = value.slice(0, last >= 0xd800 && last <= 0xdbff ? maxChars - 1 : maxChars);
  return `${truncated}\n\n[truncated]`;
}

export function sanitizeCommitSubject(raw: string): string {
  const singleLine = raw.trim().split(/\r?\n/g)[0]?.trim() ?? "";
  const withoutTrailingPeriod = singleLine.replace(/[.]+$/g, "").trim();
  if (withoutTrailingPeriod.length === 0) {
    return "Update project files";
  }

  if (withoutTrailingPeriod.length <= 72) {
    return withoutTrailingPeriod;
  }
  const segments = new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
    withoutTrailingPeriod,
  );
  let subject = "";
  for (const { segment } of segments) {
    if (subject.length + segment.length > 72) break;
    subject += segment;
  }
  return subject.trimEnd() || "Update project files";
}

export function sanitizePrTitle(raw: string): string {
  const singleLine = raw.trim().split(/\r?\n/g)[0]?.trim() ?? "";
  if (singleLine.length > 0) {
    return singleLine;
  }
  return "Update project changes";
}

const MAX_THREAD_TITLE_CHARS = 120;

export function sanitizeThreadTitle(raw: string): string {
  // Unwrap a JSON-formatted title before truncation can cut off the closing brace.
  const decoded = decodeJsonThreadTitle(raw);
  const title = Option.isSome(decoded) ? decoded.value.title : raw;
  const normalized = title
    .trim()
    .split(/\r?\n/g)[0]
    ?.trim()
    .replace(/^['"`]+|['"`]+$/g, "")
    .trim()
    .replace(/\s+/g, " ");

  if (!normalized || normalized.trim().length === 0) {
    return "New thread";
  }

  if (normalized.length <= MAX_THREAD_TITLE_CHARS) {
    return normalized;
  }

  let end = MAX_THREAD_TITLE_CHARS - 3;
  const previous = normalized.charCodeAt(end - 1);
  const next = normalized.charCodeAt(end);
  if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
    end -= 1;
  }
  return `${normalized.slice(0, end).trimEnd()}...`;
}

function cliLabel(cliName: string): string {
  const capitalized = cliName.charAt(0).toUpperCase() + cliName.slice(1);
  return `${capitalized} CLI (\`${cliName}\`)`;
}

export function classifyTextGenerationCliFailure(
  text: string,
): TextGenerationFailureReason | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  if (
    /\b(?:command not found|not available on path|enoent|executable not found|not installed)\b|未找到\s*reclaude|set up managed codex/i.test(
      trimmed,
    )
  ) {
    return "not_installed";
  }
  if (
    /\b(?:not logged in|please log in|sign in|signed out|login required|authentication (?:failed|required|error)|unauthorized|invalid(?:_| )api(?:_| )key|api key (?:missing|invalid|required|not set)|401|403|forbidden|token expired|re-?authenticate)\b|请先.*登录|重新登录|未登录/i.test(
      trimmed,
    )
  ) {
    return "unauthenticated";
  }
  if (
    /\b(?:rate[ -]?limit(?:ed)?|too many requests|quota exceeded|usage limit|credit balance is too low|overloaded_error|429)\b/i.test(
      trimmed,
    )
  ) {
    return "rate_limited";
  }
  if (/\b(?:timed? ?out|etimedout|deadline exceeded|request timeout|504)\b/i.test(trimmed)) {
    return "timeout";
  }
  if (
    /\b(?:econnrefused|econnreset|enotfound|eai_again|ehostunreach|enetunreach|fetch failed|network error|connection (?:refused|reset|failed|closed)|could(?:n't| not) (?:reach|connect)|tls|certificate)\b/i.test(
      trimmed,
    )
  ) {
    return "network";
  }
  if (
    /\b(?:service unavailable|503|502|bad gateway|overloaded|temporarily unavailable)\b/i.test(
      trimmed,
    )
  ) {
    return "unavailable";
  }
  return undefined;
}

export function normalizeCliError(
  cliName: string,
  operation: string,
  error: unknown,
  fallback: string,
): TextGenerationError {
  if (isTextGenerationError(error)) {
    return error;
  }

  if (error instanceof Error) {
    const lower = error.message.toLowerCase();
    if (
      error.message.includes(`Command not found: ${cliName}`) ||
      lower.includes(`spawn ${cliName}`) ||
      lower.includes("enoent")
    ) {
      return new TextGenerationError({
        operation,
        reason: "not_installed",
        detail: `${cliLabel(cliName)} is required but not available on PATH.`,
        cause: error,
      });
    }
    const reason = classifyTextGenerationCliFailure(error.message);
    return new TextGenerationError({
      operation,
      ...(reason ? { reason } : {}),
      detail: fallback,
      cause: error,
    });
  }

  return new TextGenerationError({
    operation,
    detail: fallback,
    cause: error,
  });
}

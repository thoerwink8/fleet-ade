import {
  IDLE_COMPACTION_TEXT,
  idleCompactionOf,
  type OrchestrationV2ConversationMessage,
  OrchestrationV2ThreadMessagePreview,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

export const encodeThreadMessagePreviewJson = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2ThreadMessagePreview),
);

export const MAX_SHELL_MESSAGE_PREVIEW_CHARS = 120;
// Read enough raw text before stripping Markdown links/fences so the 120-char plain-text budget stays full.
export const SHELL_MESSAGE_PREVIEW_SQL_PREFIX_CHARS = 1_000;

export const JAVASCRIPT_TRIM_WHITESPACE =
  " \t\n\r\v\f\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";

export type PreviewEligibleMessage = OrchestrationV2ConversationMessage & {
  readonly role: "user" | "assistant";
};

export function isPreviewEligibleMessage(
  message: Pick<
    OrchestrationV2ConversationMessage,
    | "role"
    | "createdBy"
    | "notification"
    | "delegatedCompletion"
    | "workflowScript"
    | "idleCompaction"
    | "creationSource"
    | "text"
    | "attachments"
  >,
): message is PreviewEligibleMessage {
  return (
    (message.role === "assistant" ||
      (message.role === "user" &&
        message.createdBy === "user" &&
        message.notification === undefined &&
        message.delegatedCompletion === undefined &&
        message.workflowScript !== true)) &&
    idleCompactionOf(message) === undefined
  );
}

/**
 * SQL predicate mirroring `isPreviewEligibleMessage` and excluding messages
 * belonging to rolled-back runs or containing only whitespace.
 */
export function isPreviewEligibleMessageSql(sql: SqlClient.SqlClient, alias = "message") {
  const col = (name: string) => sql.literal(`${alias}.${name}`);
  const payload = sql.literal(`${alias}.payload_json`);
  return sql`(
    (
      ${col("role")} = 'assistant'
      OR (
        ${col("role")} = 'user'
        AND json_extract(${payload}, '$.createdBy') = 'user'
        AND json_extract(${payload}, '$.notification') IS NULL
        AND json_extract(${payload}, '$.delegatedCompletion') IS NULL
        AND coalesce(json_extract(${payload}, '$.workflowScript'), 0) <> 1
      )
    )
    AND (
      ${col("run_id")} IS NULL
      OR NOT EXISTS (
        SELECT 1 FROM orchestration_v2_projection_runs rb
        WHERE rb.run_id = ${col("run_id")} AND rb.status = 'rolled_back'
      )
    )
    AND NOT (
      ${col("role")} = 'user'
      AND lower(trim(json_extract(${payload}, '$.text'), ${JAVASCRIPT_TRIM_WHITESPACE})) = ${IDLE_COMPACTION_TEXT}
      AND coalesce(json_array_length(${payload}, '$.attachments'), 0) = 0
      AND (
        json_extract(${payload}, '$.idleCompaction') IS NOT NULL
        OR (
          json_extract(${payload}, '$.createdBy') = 'agent'
          AND json_extract(${payload}, '$.creationSource') = 'server'
        )
      )
    )
    AND length(
      trim(coalesce(json_extract(${payload}, '$.text'), ''), ${JAVASCRIPT_TRIM_WHITESPACE})
    ) > 0
  )`;
}

/**
 * Strip common Markdown syntax so sidebar previews render readable plain text
 * instead of raw markers (`**`, `` ` ``, `###`, `[label](url)`).
 */
export function stripMarkdownForPreview(rawText: string): string {
  let text = rawText.replace(/\r\n?/gu, "\n");
  // Drop code fence delimiter lines while preserving inner code lines.
  text = text.replace(/^[ \t]*(?:```|~~~)[^\n]*$/gmu, "");
  // Images and links -> keep visible label/alt text.
  text = text.replace(/!\[([^\]]*)\]\((?:\([^)]*\)|[^)])*\)/gu, "$1");
  text = text.replace(/\[([^\]]+)\]\((?:\([^)]*\)|[^)])*\)/gu, "$1");
  text = text.replace(/\[([^\]]+)\]\[[^\]]*\]/gu, "$1");
  // Block-level Markdown prefixes.
  text = text.replace(/^[ \t]*(?:>[ \t]?)+/gmu, "");
  text = text.replace(/^[ \t]*#{1,6}[ \t]+/gmu, "");
  text = text.replace(/[ \t]+#+[ \t]*$/gmu, "");
  text = text.replace(/^[ \t]*(?:[-*_][ \t]*){3,}$/gmu, "");
  text = text.replace(/^[ \t]*[-*+][ \t]+(?:\[[ xX]\][ \t]+)?/gmu, "");
  text = text.replace(/^[ \t]*\d+[.)][ \t]+/gmu, "");
  // Inline formatting and backslash escapes; underscore forms guard word boundaries to keep snake_case intact.
  text = text.replace(/(?<!\\)`+([^`\n]+?)(?<!\\)`+/gu, "$1");
  text = text.replace(/(?<!\\)\*\*([^*\n]+?)(?<!\\)\*\*/gu, "$1");
  text = text.replace(/(^|[^\p{L}\p{N}_\\])__([^_\n]+?)__(?=[^\p{L}\p{N}_]|$)/gu, "$1$2");
  text = text.replace(/(?<!\\)\*([^*\n]+?)(?<!\\)\*/gu, "$1");
  text = text.replace(/(^|[^\p{L}\p{N}_\\])_([^_\n]+?)_(?=[^\p{L}\p{N}_]|$)/gu, "$1$2");
  text = text.replace(/(?<!\\)~~([^~\n]+?)(?<!\\)~~/gu, "$1");
  text = text.replace(/\\([\\`*_{}[\]()#+\-.!>~|])/gu, "$1");
  return text.replace(/\s+/gu, " ").trim();
}

export function summarizeThreadMessagePreview(
  role: "user" | "assistant",
  rawText: string,
): OrchestrationV2ThreadMessagePreview | null {
  const plainText = stripMarkdownForPreview(
    rawText.trim().slice(0, SHELL_MESSAGE_PREVIEW_SQL_PREFIX_CHARS),
  );
  if (plainText.length === 0) return null;
  if (plainText.length <= MAX_SHELL_MESSAGE_PREVIEW_CHARS) {
    return { role, text: plainText };
  }
  const lastCodeUnit = plainText.charCodeAt(MAX_SHELL_MESSAGE_PREVIEW_CHARS - 1);
  const cut =
    lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff
      ? MAX_SHELL_MESSAGE_PREVIEW_CHARS - 1
      : MAX_SHELL_MESSAGE_PREVIEW_CHARS;
  return { role, text: `${plainText.slice(0, cut).trimEnd()}…` };
}

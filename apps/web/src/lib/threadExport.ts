import type {
  OrchestrationV2ConversationMessage,
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2Run,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export interface BuildThreadMarkdownInput {
  readonly title: string;
  readonly projectName?: string | null | undefined;
  readonly exportedAt: Date;
  readonly items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
  readonly messages?: ReadonlyArray<OrchestrationV2ConversationMessage> | undefined;
  readonly runs?: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "status">> | undefined;
  readonly truncated?: boolean | undefined;
}

type ExportLine = {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly at: number;
};

type UserMessageFields = {
  readonly createdBy?: OrchestrationV2ConversationMessage["createdBy"] | undefined;
  readonly workflowScript?: boolean | undefined;
  readonly idleCompaction?: OrchestrationV2ConversationMessage["idleCompaction"] | undefined;
  readonly notification?: OrchestrationV2ConversationMessage["notification"] | undefined;
  readonly delegatedCompletion?:
    | OrchestrationV2ConversationMessage["delegatedCompletion"]
    | undefined;
};

function isExportedUserMessage(message: UserMessageFields): boolean {
  return (
    message.createdBy === "user" &&
    message.workflowScript !== true &&
    message.idleCompaction === undefined &&
    message.notification === undefined &&
    message.delegatedCompletion === undefined
  );
}

function turnItemInstant(item: OrchestrationV2TurnItem): number {
  return DateTime.toEpochMillis(item.startedAt ?? item.updatedAt);
}

function exportLines(input: BuildThreadMarkdownInput): ExportLine[] {
  const lines: ExportLine[] = [];
  const coveredMessageIds = new Set<string>();
  for (const row of input.items) {
    if (row.item.type === "user_message") {
      if (!isExportedUserMessage(row.item)) continue;
      coveredMessageIds.add(row.item.messageId);
      lines.push({
        role: "user",
        text: row.item.text,
        at: turnItemInstant(row.item),
      });
    } else if (row.item.type === "assistant_message") {
      lines.push({
        role: "assistant",
        text: row.item.text,
        at: turnItemInstant(row.item),
      });
    }
  }

  const queuedRunIds = new Set(
    (input.runs ?? []).flatMap((run) => (run.status === "queued" ? [String(run.id)] : [])),
  );
  const hidden = (input.messages ?? [])
    .filter(
      (message) =>
        message.role === "user" &&
        message.runId !== null &&
        queuedRunIds.has(String(message.runId)) &&
        isExportedUserMessage(message) &&
        !coveredMessageIds.has(message.id),
    )
    .toSorted(
      (left, right) =>
        DateTime.toEpochMillis(left.createdAt) - DateTime.toEpochMillis(right.createdAt) ||
        left.id.localeCompare(right.id),
    );
  for (const message of hidden) {
    const at = DateTime.toEpochMillis(message.createdAt);
    const index = lines.findIndex((line) => line.at > at);
    const line: ExportLine = { role: "user", text: message.text, at };
    if (index === -1) lines.push(line);
    else lines.splice(index, 0, line);
  }
  return lines;
}

const INVALID_FILENAME_CHARS = '\\/:*?"<>|';

function padTwoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

function formatDateCompact(date: Date): string {
  return `${date.getFullYear()}${padTwoDigits(date.getMonth() + 1)}${padTwoDigits(date.getDate())}`;
}

function formatDateTime(date: Date): string {
  return `${date.getFullYear()}-${padTwoDigits(date.getMonth() + 1)}-${padTwoDigits(date.getDate())} ${padTwoDigits(date.getHours())}:${padTwoDigits(date.getMinutes())}`;
}

function sanitizeThreadFilenameSegment(title: string): string {
  let cleaned = "";
  for (const ch of title.trim()) {
    const code = ch.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f || INVALID_FILENAME_CHARS.includes(ch)) {
      cleaned += "-";
    } else {
      cleaned += ch;
    }
  }
  const normalized = cleaned
    .replace(/\s+/g, " ")
    .replace(/-+/g, "-")
    .replace(/^[.\-\s]+|[.\-\s]+$/g, "");
  return normalized.length > 0 ? normalized : "会话";
}

export function buildThreadExportFilename(title: string, date: Date): string {
  return `${sanitizeThreadFilenameSegment(title)}-${formatDateCompact(date)}.md`;
}

const FENCE_LINE = /^( {0,3})(`{3,}|~{3,})(.*)$/;

// An interrupted reply can stop inside a fence, and the next heading would be read as code.
function closeOpenCodeFence(section: string): string {
  let open: { readonly marker: string; readonly length: number } | null = null;
  for (const line of section.split("\n")) {
    const match = FENCE_LINE.exec(line);
    if (match === null) continue;
    const token = match[2]!;
    const marker = token[0]!;
    if (
      open !== null &&
      marker === open.marker &&
      token.length >= open.length &&
      match[3]!.trim() === ""
    ) {
      open = null;
      continue;
    }
    if (open === null) open = { marker, length: token.length };
  }
  if (open === null) return section;
  const closer = open.marker.repeat(open.length);
  return section.endsWith("\n") ? `${section}${closer}` : `${section}\n${closer}`;
}

export function buildThreadMarkdown(input: BuildThreadMarkdownInput): string {
  const displayTitle = input.title.trim() || "会话";
  const metaParts: string[] = [];
  const projectName = input.projectName?.trim();
  if (projectName) {
    metaParts.push(`项目：${projectName}`);
  }
  metaParts.push(`导出时间：${formatDateTime(input.exportedAt)}`);

  const sections: string[] = [`# ${displayTitle}`, metaParts.join(" · ")];

  if (input.truncated) {
    sections.push("> 只导出了最近的部分，更早的轮次没有包含。");
  }

  for (const line of exportLines(input)) {
    const heading = line.role === "user" ? "你" : "助手";
    sections.push(closeOpenCodeFence(`## ${heading}\n\n${line.text.trimEnd()}`));
  }

  sections.push("> 工具调用和文件改动没有导出。");

  return `${sections.join("\n\n")}\n`;
}

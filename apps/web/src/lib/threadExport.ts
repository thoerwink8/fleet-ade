import type { OrchestrationV2ProjectedTurnItem } from "@t3tools/contracts";

export interface BuildThreadMarkdownInput {
  readonly title: string;
  readonly projectName?: string | null | undefined;
  readonly exportedAt: Date;
  readonly items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
  readonly truncated?: boolean | undefined;
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

  for (const row of input.items) {
    if (row.item.type === "user_message") {
      sections.push(`## 你\n\n${row.item.text.trimEnd()}`);
    } else if (row.item.type === "assistant_message") {
      sections.push(`## 助手\n\n${row.item.text.trimEnd()}`);
    }
  }

  sections.push("> 工具调用和文件改动没有导出。");

  return `${sections.join("\n\n")}\n`;
}

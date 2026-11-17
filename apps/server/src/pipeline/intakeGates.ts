// Six gates in front of creating a run. A whitelist read that fails pulls nobody.
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { REPOSITORY } from "./GitHubIssues.ts";

const LOCAL_LABEL = "本机做";
const ADE_LABEL = "交给 ADE";
const GROOMED_LABEL = "整理过";
const PENDING_LABEL = "待补";
const HUMAN_LABEL = "要人拍";
const PATH_LIMIT = 50;
const ACTIONS_BOT = "github-actions[bot]";

export class IntakeWhitelistUnread extends Schema.TaggedError<IntakeWhitelistUnread>()(
  "IntakeWhitelistUnread",
  { detail: Schema.String },
) {}

interface AuthorWhitelist {
  readonly logins: ReadonlySet<string>;
}

interface IntakeAuthor {
  readonly login: string;
  readonly id: number;
  readonly type: string;
}
export interface IntakeCandidate {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly labels: ReadonlyArray<string>;
  readonly author: IntakeAuthor | null;
  readonly createdAt: string | null;
}

export type PrerequisiteState = "open" | "closed" | "unread";

interface IntakeFacts {
  readonly whitelist: AuthorWhitelist;
  readonly openedAt: string | null;
  readonly now: DateTime.Utc;
  readonly prerequisiteState: (number: number) => PrerequisiteState;
}

type IntakeDecision = { readonly pull: true } | { readonly pull: false; readonly reason: string };

export class PipelineIntakePorts extends Context.Service<
  PipelineIntakePorts,
  {
    readonly readWhitelist: Effect.Effect<AuthorWhitelist, IntakeWhitelistUnread>;
  }
>()("t3/pipeline/intakeGates/PipelineIntakePorts") {}

export const defaultWhitelist = (): AuthorWhitelist => ({
  logins: new Set([REPOSITORY.owner.toLowerCase(), ACTIONS_BOT]),
});

export const layerPortsDefault = Layer.succeed(PipelineIntakePorts, {
  readWhitelist: Effect.succeed(defaultWhitelist()),
});

const skip = (reason: string): IntakeDecision => ({ pull: false, reason });

export function decideIntake(issue: IntakeCandidate, facts: IntakeFacts): IntakeDecision {
  const login = issue.author?.login.toLowerCase();
  if (login === undefined || !facts.whitelist.logins.has(login)) {
    return skip(
      login === undefined ? "作者读不到，不拉" : `作者 ${issue.author?.login} 不在白名单里，不拉`,
    );
  }
  if (issue.labels.includes(LOCAL_LABEL)) {
    return skip(
      issue.labels.includes(ADE_LABEL)
        ? "贴着「本机做」又贴着「交给 ADE」：以「本机做」为准，不拉"
        : "贴着「本机做」，不拉",
    );
  }
  const waiting = prerequisiteBlock(issue.body, facts.now, facts.prerequisiteState);
  if (waiting !== null) return skip(waiting);
  const offDiff = offDiffBlock(issue.body);
  if (offDiff !== null) return skip(offDiff);
  const paths = listedPathCount(issue.body);
  if (paths > PATH_LIMIT) {
    return skip(`列出的路径有 ${paths} 个，超过 ${PATH_LIMIT}，不拉`);
  }
  if (issue.labels.includes(PENDING_LABEL)) return skip("贴着「待补」，不拉");
  if (issue.labels.includes(HUMAN_LABEL)) return skip("贴着「要人拍」，不拉");
  if (
    isOldIssue(issue.createdAt, facts.openedAt) &&
    !issue.labels.includes(GROOMED_LABEL) &&
    !issue.labels.includes(ADE_LABEL)
  ) {
    return skip("开单早于流水线打开，没有「整理过」或「交给 ADE」，不拉");
  }
  return { pull: true };
}

function isOldIssue(createdAt: string | null, openedAt: string | null): boolean {
  if (openedAt === null || createdAt === null) return true;
  const created = Date.parse(createdAt);
  const opened = Date.parse(openedAt);
  if (!Number.isFinite(created) || !Number.isFinite(opened)) return true;
  return created < opened;
}

const PREREQUISITE_LINE = /^\s*前置[：:]/;
const FENCE = /^\s*(```|~~~)/;
const DATE = /(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/g;

function isRealDate(year: number, month: number, day: number): boolean {
  const iso = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const made = DateTime.make(`${iso}T00:00:00.000Z`);
  return Option.isSome(made) && DateTime.formatIso(made.value).startsWith(iso);
}

export function prerequisiteIssueNumbers(body: string): ReadonlyArray<number> {
  return parsePrerequisites(body).issues;
}

function parsePrerequisites(body: string): {
  readonly issues: number[];
  readonly until: string | null;
} {
  const issues: number[] = [];
  let until: string | null = null;
  let fence: string | null = null;
  for (const line of body.split(/\r?\n/)) {
    const marker = FENCE.exec(line)?.[1];
    if (marker !== undefined) {
      fence = fence === null ? marker : fence === marker ? null : fence;
      continue;
    }
    if (fence !== null || !PREREQUISITE_LINE.test(line)) continue;
    for (const match of line.matchAll(/#(\d+)/g)) {
      const number = Number(match[1]);
      if (Number.isSafeInteger(number) && number > 0 && !issues.includes(number))
        issues.push(number);
    }
    for (const match of line.matchAll(DATE)) {
      const year = Number(match[1]);
      const month = Number(match[2]);
      const day = Number(match[3]);
      if (!isRealDate(year, month, day)) continue;
      const date = `${match[1]}-${match[2]}-${match[3]}`;
      if (until === null || date > until) until = date;
    }
  }
  return { issues, until };
}

function beijingDate(now: DateTime.Utc): string {
  return DateTime.formatIso(DateTime.makeUnsafe(DateTime.toEpochMillis(now) + 8 * 3_600_000)).slice(
    0,
    10,
  );
}

function issueRefs(numbers: ReadonlyArray<number>): string {
  return numbers.map((number) => `#${number}`).join("、");
}

function prerequisiteBlock(
  body: string,
  now: DateTime.Utc,
  stateOf: (number: number) => PrerequisiteState,
): string | null {
  const pre = parsePrerequisites(body);
  if (pre.until !== null && beijingDate(now) < pre.until) return `等到 ${pre.until}`;
  if (pre.issues.length === 0) return null;
  if (pre.issues.some((number) => stateOf(number) === "unread")) {
    return `等前置 ${issueRefs(pre.issues)}（前置单状态没查成，按没关算）`;
  }
  const open = pre.issues.filter((number) => stateOf(number) === "open");
  if (open.length > 0) return `等前置 ${issueRefs(open)}`;
  return null;
}

const HEADING = /^(#{1,6})\s+(.*?)\s*$/;

function sectionBody(body: string, title: string): string | undefined {
  const lines = body.split(/\r?\n/);
  let start = -1;
  let level = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const match = HEADING.exec(lines[index] ?? "");
    if (match === null) continue;
    const headingLevel = match[1]?.length ?? 0;
    if (start === -1) {
      if ((match[2] ?? "").trim() === title) {
        start = index + 1;
        level = headingLevel;
      }
      continue;
    }
    if (headingLevel <= level) return lines.slice(start, index).join("\n");
  }
  return start === -1 ? undefined : lines.slice(start).join("\n");
}

const HARD: readonly RegExp[] = [
  /截图|截屏|录屏|录像|屏幕快照|screenshot/i,
  /飞书(?:上|里|群里)?(?:收到|看到|弹出)|(?:收到|看到)[^\n。；;]{0,8}飞书(?:消息|通知|报警|推送|卡片)/,
  /(?<!保留|保全|保护|还原|清理|恢复|丢失|破坏|污染|留在|留下)现场(?!保留|保全|保护|凭据|交还|顺序|清理|状态|记录|数据|文件|目录|快照|恢复|还原|工作树|上下文|原样|不动)/,
  /人工(?:确认|核对|验证|验收|检查|点验)|肉眼|手工(?:点|确认|验证)/,
  /创始人[^\n。；;]{0,6}(?:确认|看过|验收)/,
  /审计(?:结果|报告|通过)/,
  /(?:读|读取|查询|查看|核对|对照|翻)[^\n。；;]{0,12}(?:数据库|生产库|线上库|法国库|库里|库中|DB)/i,
  /(?:在|从)[^\n。；;]{0,8}(?:数据库|生产库|线上库|法国库|库里|库中|DB)[^\n。；;]{0,8}(?:读|读取|查询|查看|核对|对照|翻)/i,
  /(?:读回|回读|读取回|读出来|读到)[^\n。；;]{0,20}(?:结果|状态|响应|数据|结论|值|内容|healthz|健康检查)/i,
  /(?:贴|写|留|发)[^\n。；;]{0,10}(?:评论|评论区|本单评论)|评论(?:区|里|中)[^\n。；;]{0,10}(?:贴|写|留|发)/,
  /(?:在|到|回)?本单[^\n。；;]{0,8}(?:注明|写明|留言|贴)/,
  /(?:恢复|重新建立|重连|重新连接|连回)[^\n。；;]{0,12}(?:SSH|连接|链路|会话)/i,
  /(?:healthz|健康检查|健康探针|健康状态)[^\n。；;]{0,24}(?:读回|返回|回到|变为|显示|不再|通过|为)/i,
  /(?:读回|回读|读取)[^\n。；;]{0,20}(?:healthz|健康检查|健康探针|健康状态)/i,
];

const DIAGNOSTIC: readonly RegExp[] = [
  /(?:核实|定位|查明|查清|弄清|明确|确认)[^\n。；;]{0,12}(?:原场景|原用例|首次失败|首红)[^\n。；;]{0,16}?(?:卡在|等待|阶段|原因)/,
  /定位[^\n。；;]{0,30}(?:真实|实际)(?:阶段|原因|根因)/,
  /完整\s*CI[^\n。；;]{0,24}\d+\s*(?:秒|毫秒|ms|s)[^\n。；;]{0,4}超时/i,
];

const SOFT: readonly RegExp[] = [
  /线上|现网|生产环境|正式环境/,
  /法国(?:机器|服务器|VPS|那台|上)/i,
  /真机/,
  /(?:看|查|翻|贴|附|对照)[^\n。；;]{0,6}日志|日志(?:里|中|上)?(?:看到|看得到|显示|证明|为证)|证据是日志/,
  /(?:^|[（(、，,；;])日志(?:[、，,；;)）]|$)/,
  /(?:上线|部署|发版|发布)(?:后|之后|以后)/,
  /监控(?:上|里|面板)/,
];

const TEST_ANCHOR = /测试|单测|断言|用例|\btest\b|\.test\.|\.spec\.|vitest|playwright|e2e|diff/i;

const MERGE_GATE_PARTS: readonly RegExp[] = [
  /^(?:所有|全部|必过|全套)?(?:完整)?(?:检查|ci|check|pnpmcheck|必过检查)(?:都|全部)?(?:全绿|全部通过|通过|变绿|绿了?)$/i,
  /^(?:本)?pr(?:#?\d+)?(?:已|可以|能)?(?:合进|合入|合并进|合并入|合并到|合到|并入|合并)(?:到|进|入)?(?:主线|main|master)?$/i,
  /^(?:已)?合并(?:进|入|到)?(?:主线|main|master)?$/i,
  /^合并闸(?:通过|放行)?$/,
];

function isMergeGateItem(item: string): boolean {
  const flat = item.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").replace(/[\s`*_]/g, "");
  const parts = flat
    .split(/[，,、；;。.]|并且|以及|和/)
    .map((part) => part.trim())
    .filter((part) => part !== "");
  return parts.length > 0 && parts.every((part) => MERGE_GATE_PARTS.some((re) => re.test(part)));
}

function offDiffWords(item: string): string[] {
  if (isMergeGateItem(item)) return [];
  const words: string[] = [];
  for (const re of [...HARD, ...DIAGNOSTIC]) {
    const match = re.exec(item);
    if (match?.[0] !== undefined) words.push(match[0]);
  }
  if (!TEST_ANCHOR.test(item)) {
    for (const re of SOFT) {
      const match = re.exec(item);
      if (match?.[0] !== undefined) words.push(match[0]);
    }
  }
  return words;
}

function acceptanceItems(section: string): string[] {
  const items: string[] = [];
  let current: string[] = [];
  const flush = () => {
    const text = current.join("\n").trim();
    if (text) items.push(text);
    current = [];
  };
  for (const raw of section.replace(/\r\n?/g, "\n").split("\n")) {
    if (/^\s*(?:[-*+]|\d+[.)])\s+\S/.test(raw)) {
      flush();
      current.push(raw.trim());
    } else if (raw.trim() === "") {
      flush();
    } else {
      current.push(raw.trim());
    }
  }
  flush();
  return items;
}

function offDiffBlock(body: string): string | null {
  const section = sectionBody(body, "怎么算做完");
  if (section === undefined) return null;
  const hits = acceptanceItems(section).flatMap((item) => {
    const words = offDiffWords(item);
    return words.length === 0 ? [] : [`${item}（认出：${words.join("、")}）`];
  });
  if (hits.length === 0) return null;
  return `「怎么算做完」要 diff 外证据：${hits.join("；")}`;
}

const NO_MODULES =
  /^(?:[（(]\s*(?:暂无|无|没有|未知|待定|不知道)[^（()）]*[）)]|(?:暂无|无|没有|未知|待定|不知道)\s*(?:[（(].*[）)])?)\s*[。.]?$/;
const ITEM_START = /^\s{0,3}(?:[-*+]|\d{1,9}[.)])\s+/;
const PATH_CHARS = /^[\p{L}\p{N}_.@~\-*/]+$/u;

function moduleItems(section: string): string[] {
  const items: string[][] = [];
  let current: string[] | undefined;
  let gap = false;
  for (const line of section.split("\n")) {
    if (!line.trim()) {
      gap = true;
      continue;
    }
    if (ITEM_START.test(line)) {
      current = [line.replace(ITEM_START, "").trim()];
      items.push(current);
    } else if (current && (!gap || /^\s/.test(line))) {
      current.push(line.trim());
    } else {
      current = [line.trim()];
      items.push(current);
    }
    gap = false;
  }
  return items
    .map((lines) => lines.join(" ").replace(/\s+/g, " ").trim())
    .filter((item) => item !== "" && !NO_MODULES.test(item));
}

function asModulePath(raw: string): string | undefined {
  const text = raw
    .trim()
    .replace(/:\d+(?:-\d+)?$/, "")
    .replace(/^\.\//, "");
  if (
    !text ||
    /\s/.test(text) ||
    text.includes("://") ||
    text.startsWith("/") ||
    text.includes("..")
  ) {
    return undefined;
  }
  if (!PATH_CHARS.test(text)) return undefined;
  if (text.includes("*")) {
    const segments = text.split("/");
    const at = segments.findIndex((segment) => segment.includes("*"));
    const prefix = segments.slice(0, at).join("/");
    return prefix === "" ? undefined : prefix;
  }
  const slash = text.endsWith("/");
  const path = text.replace(/\/+$/, "");
  if (!path) return undefined;
  const last = path.split("/").pop() ?? "";
  const fileLike = /^.+\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(last) || /^\.[\w-]+$/.test(last);
  if (!slash && !path.includes("/") && !fileLike) return undefined;
  return path;
}

function listedPathCount(body: string): number {
  const section = sectionBody(body, "已知的模块");
  if (section === undefined) return 0;
  const paths = new Set<string>();
  for (const item of moduleItems(section)) {
    for (const match of item.matchAll(/`([^`\n]+)`/g)) {
      const path = asModulePath(match[1] ?? "");
      if (path !== undefined) paths.add(path);
    }
  }
  return paths.size;
}

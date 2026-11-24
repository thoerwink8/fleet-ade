import type { DesktopBridge } from "@t3tools/contracts";

const ISSUE_URL = "https://github.com/thoerwink8/fleet-ade/issues/new";
const LAST_FAILURE_KEY = "t3code:boot-failed-at";
const REPEAT_FAILURE_MS = 5 * 60_000;
const MAX_CAUSES = 3;
const MAX_ERROR_CHARS = 6_000;
const COPY_BLOCKED = "复制被拦截。文本已选中，请手动复制。";

function safeString(value: unknown) {
  try {
    return String(value);
  } catch {
    return "";
  }
}

function describeOne(value: unknown) {
  if (value instanceof Error) {
    const header = value.message ? `${value.name}: ${value.message}` : value.name;
    // V8 stacks start with the header; Safari and Firefox stacks do not.
    const stack = typeof value.stack === "string" ? value.stack : "";
    return stack === header || stack.startsWith(`${header}\n`)
      ? stack
      : [header, stack].filter(Boolean).join("\n");
  }
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? safeString(value);
  } catch {
    return safeString(value);
  }
}

/** Hosts can name private machines, and pairing tokens live in query strings and hashes. */
function redact(text: string) {
  return text
    .replace(/\b[a-z][\w+.-]*:\/\/[^\s/?#'"()]+/gi, "")
    .replace(/[?#][^\s'"()]*=[^\s'"()]*?((?::\d+){1,2})?(?=[\s'"()]|$)/g, "$1");
}

export interface BootErrorEnvironment {
  readonly version: string;
  readonly channel: string;
  readonly surface: "desktop" | "web";
  readonly platform: string;
  readonly userAgent: string;
  readonly time: string;
}

/** Plain text that is shown and copied as-is, so users see exactly what they share. */
export function buildErrorReport(error: unknown, environment: BootErrorEnvironment) {
  const parts: Array<string> = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current != null && !seen.has(current) && parts.length <= MAX_CAUSES) {
    seen.add(current);
    const text = describeOne(current);
    parts.push(parts.length === 0 ? text : `Caused by: ${text}`);
    current = current instanceof Error ? current.cause : undefined;
  }
  let details = redact(parts.join("\n") || "(no error message)");
  if (details.length > MAX_ERROR_CHARS) {
    details = `${details.slice(0, MAX_ERROR_CHARS)}\n[truncated]`;
  }
  return [
    details,
    "",
    `Version: ${environment.version}`,
    `Channel: ${environment.channel}`,
    `Surface: ${environment.surface}`,
    `Platform: ${environment.platform}`,
    `User agent: ${environment.userAgent}`,
    `Time: ${environment.time}`,
  ].join("\n");
}

function clientPlatform(bridge: DesktopBridge | undefined) {
  try {
    return bridge?.getClientPlatform() ?? navigator.platform;
  } catch {
    return navigator.platform;
  }
}

function readEnvironment(bridge: DesktopBridge | undefined): BootErrorEnvironment {
  const version = import.meta.env.APP_VERSION;
  return {
    version,
    channel:
      import.meta.env.VITE_RELEASE_CHANNEL || /-(nightly|preview)\./.exec(version)?.[1] || "stable",
    surface: bridge ? "desktop" : "web",
    platform: clientPlatform(bridge),
    userAgent: navigator.userAgent,
    time: new Date().toISOString(),
  };
}

/** Opens More options by default when startup already failed in this tab a moment ago. */
function isRepeatFailure(now: number) {
  try {
    const previous = Number(sessionStorage.getItem(LAST_FAILURE_KEY));
    sessionStorage.setItem(LAST_FAILURE_KEY, String(now));
    return now - previous < REPEAT_FAILURE_MS;
  } catch {
    return false;
  }
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  children: ReadonlyArray<Node | string> = [],
) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function selectContents(target: HTMLElement) {
  const range = document.createRange();
  range.selectNodeContents(target);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function copySelection() {
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  }
}

/** Plain http has no Clipboard API, but the legacy copy command still works on a selection. */
function copyText(target: HTMLElement, onCopied: () => void, onBlocked: (hint: string) => void) {
  const fallback = () => {
    selectContents(target);
    if (copySelection()) return onCopied();
    onBlocked(/Mac|iPhone|iPad/.test(navigator.platform) ? "按 ⌘C 复制" : "按 Ctrl+C 复制");
  };
  const clipboard = window.isSecureContext ? navigator.clipboard : undefined;
  if (typeof clipboard?.writeText !== "function") return fallback();
  clipboard.writeText(target.textContent ?? "").then(onCopied, fallback);
}

export function showBootError(error: unknown) {
  console.error("Fleet ADE failed to start.", error);
  const bootShell = document.getElementById("boot-shell");
  if (!bootShell) return;

  const bridge = window.desktopBridge;
  const environment = readEnvironment(bridge);
  const offline = !bridge && navigator.onLine === false;

  const status = element("span", { className: "boot-error-sr" });
  status.setAttribute("aria-live", "polite");
  // Clearing first makes screen readers announce a repeated message.
  let announcement: ReturnType<typeof setTimeout> | undefined;
  const announce = (text: string) => {
    clearTimeout(announcement);
    status.textContent = "";
    announcement = setTimeout(() => (status.textContent = text), 100);
  };

  const message = element("div", {}, [
    element("h1", { textContent: "Fleet ADE 启动失败" }),
    element("p", {
      textContent: offline
        ? "浏览器似乎已离线。请检查连接，然后重新加载。"
        : "原因未知。请先尝试重新加载。",
    }),
  ]);
  message.setAttribute("role", "alert");

  const reload = element("button", {
    id: "boot-error-reload",
    type: "button",
    textContent: "重新加载",
  });
  reload.addEventListener("click", () => window.location.reload());

  let report = "（无错误信息）";
  try {
    report = buildErrorReport(error, environment);
  } catch (reportError) {
    console.warn("Could not describe the startup error.", reportError);
  }
  const details = element("pre", { id: "boot-error-details", tabIndex: 0, textContent: report });
  const copyDetails = element("button", { type: "button", textContent: "复制错误详情" });
  copyDetails.addEventListener("click", () =>
    copyText(
      details,
      () => {
        copyDetails.textContent = "已复制";
        announce("已复制到剪贴板。");
      },
      (hint) => {
        copyDetails.textContent = hint;
        announce(COPY_BLOCKED);
      },
    ),
  );

  const link = (href: string, textContent: string) =>
    element("a", { href, textContent, target: "_blank", rel: "noreferrer" });
  const issue = new URL(ISSUE_URL);
  issue.searchParams.set("template", "bug_report.yml");
  issue.searchParams.set("title", "Fleet ADE failed to start");
  issue.searchParams.set("area", "apps/web");
  issue.searchParams.set("version", `${environment.version} (${environment.channel})`);
  issue.searchParams.set("environment", `${environment.surface}, ${environment.platform}`);
  const more = element("details", { open: isRepeatFailure(Date.now()) }, [
    element("summary", { textContent: "仍然失败时的更多选项" }),
    element("div", {}, [
      details,
      element("p", {
        textContent: "详情可能包含本地文件路径和名称。分享前请检查。",
      }),
      element("div", { id: "boot-error-report" }, [
        copyDetails,
        link(issue.href, "在 GitHub 上提交问题报告"),
      ]),
    ]),
  ]);

  bootShell.replaceChildren(
    element("div", { id: "boot-error" }, [
      message,
      element("div", { id: "boot-error-actions" }, [reload]),
      more,
      status,
    ]),
  );
}

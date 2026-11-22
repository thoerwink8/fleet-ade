import chatgptLogo from "./logos/chatgpt.png";
import claudeLogo from "./logos/claude.png";
import geminiLogo from "./logos/gemini.png";
import grokBotLogo from "./logos/grokbot.png";
import hermesLogo from "./logos/hermes.png";
import instinctLogo from "./logos/instinct.png";
import museLogo from "./logos/muse.png";
import openClawLogo from "./logos/openclaw.png";
import pokeLogo from "./logos/poke.png";

/** How the Connect step hands T3 Code's MCP URL to an app. Every `link` is https. */
export type McpAppHandoff =
  /** Opens the app's add form with T3 Code filled in. */
  | { readonly kind: "open"; readonly link: (mcpUrl: string) => string }
  /** Copies the URL, then opens the page it goes on. */
  | { readonly kind: "copy-url"; readonly link: string }
  /** Copies a message for the app's chat, then opens the app. */
  | {
      readonly kind: "copy-message";
      readonly link: string;
      /**
       * Opens the installed app first, given the message; `link` is the fallback. The desktop
       * app opens only the link shapes `isAppLaunchUrl` in ElectronShell accepts.
       */
      readonly appLink?: (message: string) => string;
      readonly message: (mcpUrl: string) => string;
    }
  /** Commands to run where the app runs. */
  | { readonly kind: "commands"; readonly commands: (mcpUrl: string) => readonly string[] };

export interface McpApp {
  readonly id: string;
  readonly name: string;
  readonly logo: string;
  readonly handoff: McpAppHandoff;
  /** "Set up another way", next to the URL. */
  readonly steps: readonly string[];
  /** One line under the primary action. */
  readonly note?: string;
  readonly docs?: string;
  /** Kept out of the grid until its sign-in works. */
  readonly hidden?: boolean;
}

const encoded = encodeURIComponent;

export const MCP_APPS: readonly McpApp[] = [
  {
    id: "poke",
    name: "Poke",
    logo: pokeLogo,
    handoff: {
      kind: "open",
      link: (url) => `https://poke.com/integrations/new?name=Fleet%20ADE&url=${encoded(url)}`,
    },
    steps: ["打开 poke.com/integrations/new。", "粘贴 URL 并添加集成。"],
    docs: "https://poke.com/docs/mcp-servers",
  },
  {
    id: "claude",
    name: "Claude",
    logo: claudeLogo,
    handoff: {
      kind: "open",
      link: (url) =>
        `https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=Fleet%20ADE&connectorUrl=${encoded(url)}`,
    },
    steps: [
      "在 Claude 中打开 Customize，然后打开 Connectors。",
      "选择 Add custom connector 并粘贴 URL。",
      "免费套餐只能添加一个自定义连接器。",
    ],
    docs: "https://claude.com/docs/connectors/building/directory-vs-custom",
  },
  {
    id: "chatgpt",
    name: "ChatGPT",
    logo: chatgptLogo,
    handoff: { kind: "copy-url", link: "https://chatgpt.com/plugins" },
    steps: [
      "在网页上打开 chatgpt.com/plugins，然后点 + 并选择 Add custom MCP server。",
      "粘贴 URL，选择 OAuth。",
      "将其创建为插件，然后安装。",
    ],
    docs: "https://developers.openai.com/api/docs/guides/custom-mcp-server",
  },
  {
    id: "grok-bot",
    name: "Grok Bot",
    logo: grokBotLogo,
    // No web chat. The app link prefills the message only into an empty box, so it is copied too.
    handoff: {
      kind: "copy-message",
      link: "https://x.ai/bot",
      appLink: (message) => `grokbot://app/v1/prompt?text=${encoded(message)}`,
      message: (url) => `Add the MCP server ${url} and connect it.`,
    },
    steps: ["将这条消息发送给你的任意一个 Grok Bot。"],
    note: "你的所有 Grok Bot 共享此连接。",
    docs: "https://docs.x.ai/grok-bot/computer-and-apps",
  },
  {
    id: "gemini",
    name: "Gemini",
    logo: geminiLogo,
    handoff: { kind: "copy-url", link: "https://gemini.google.com/apps" },
    steps: [
      "在 Gemini 中打开 Settings，然后打开 Connected apps。",
      "选择 Custom apps，再点 Add，然后粘贴 URL。",
    ],
    docs: "https://support.google.com/gemini/answer/17209137",
    // Gemini's sign-in and its tool schema checks do not work with T3 Code yet.
    hidden: true,
  },
  {
    id: "muse",
    name: "Muse",
    logo: museLogo,
    handoff: {
      kind: "copy-message",
      link: "https://muse.ai",
      message: (url) => `Create a custom connector for the MCP server ${url}.`,
    },
    steps: ["将这条消息发送给 Muse。"],
    docs: "https://www.meta.com/help/artificial-intelligence/1687253048996149/",
  },
  {
    id: "instinct",
    name: "Instinct",
    logo: instinctLogo,
    handoff: {
      kind: "copy-message",
      link: "https://app.instinct.com",
      message: (url) => `Connect the MCP server ${url}.`,
    },
    steps: ["在 Instinct 中打开 Settings，然后打开 MCP connections（如果你的账号有此选项）。"],
  },
  {
    id: "openclaw",
    name: "OpenClaw",
    logo: openClawLogo,
    handoff: {
      kind: "commands",
      commands: (url) => [
        // Its MCP commands refuse to write while the Gateway runs.
        "openclaw gateway stop",
        `openclaw mcp add t3code --url ${url} --transport streamable-http --auth oauth`,
        "openclaw mcp login t3code",
        "openclaw gateway start",
      ],
    },
    steps: [
      "打开 Control UI，点 + 和 Plugins，然后选择 Add MCP server。",
      "粘贴 URL，然后选择 Streamable HTTP 和 OAuth。",
      "在 Settings → MCP 下为它选择 Sign in。",
    ],
    docs: "https://docs.openclaw.ai/tools/mcp",
  },
  {
    id: "hermes-agent",
    name: "Hermes Agent",
    logo: hermesLogo,
    handoff: {
      kind: "commands",
      commands: (url) => [
        // `add` signs in on its first connection (30 s by default, too short to get a code);
        // `login` would clear that sign-in and need a second code.
        `hermes mcp add t3code --url ${url} --auth oauth --connect-timeout 315`,
      ],
    },
    steps: [
      "在 ~/.hermes/config.yaml 的 mcp_servers 下添加 t3code，填写 URL 和 auth: oauth。",
      "运行 hermes mcp login t3code。",
    ],
    note: "在远程主机上，按提示把最终的 URL 粘贴回去。",
    docs: "https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp",
  },
];

/** The "Something else…" choice: the URL and general steps only. */
export const OTHER_MCP_APP_STEPS = ["添加一个使用 OAuth 的远程 MCP 服务器。"] as const;

/**
 * The primary button for `app`: its label, the https page it opens, and what it copies first.
 * Null for apps set up with commands. It never copies the approval code.
 */
export function mcpHandoffAction(app: McpApp, mcpUrl: string) {
  const { handoff } = app;
  switch (handoff.kind) {
    case "open":
      return {
        label: `在 ${app.name} 中打开`,
        link: handoff.link(mcpUrl),
        appLink: null,
        copy: null,
      };
    case "copy-url":
      return {
        label: `复制 URL 并打开 ${app.name}`,
        link: handoff.link,
        appLink: null,
        copy: { text: mcpUrl, title: "已复制 URL" },
      };
    case "copy-message": {
      const message = handoff.message(mcpUrl);
      return {
        label: `复制消息并打开 ${app.name}`,
        link: handoff.link,
        appLink: handoff.appLink?.(message) ?? null,
        copy: { text: message, title: "已复制消息" },
      };
    }
    case "commands":
      return null;
  }
}

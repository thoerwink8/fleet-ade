import type { ScheduledTaskWebhookEndpoint } from "@t3tools/contracts";
import { isLocalLoopbackHost } from "@t3tools/shared/hostClassification";

export interface WebhookAddress {
  readonly address: string;
  readonly copyable: boolean;
  readonly note: string | null;
}

export function webhookAddress(
  endpoint: ScheduledTaskWebhookEndpoint,
  httpBaseUrl: string | null,
): WebhookAddress {
  if (endpoint.url !== null) {
    return { address: endpoint.url, copyable: true, note: null };
  }
  if (httpBaseUrl === null) {
    return {
      address: endpoint.path,
      copyable: false,
      note: "连接这台电脑后可获取地址。",
    };
  }
  const url = new URL(endpoint.path, httpBaseUrl);
  return {
    address: url.href,
    copyable: true,
    note: isLocalLoopbackHost(url.hostname)
      ? "只有本机可以访问此地址。"
      : "只要能连接这台电脑的地址（例如通过 Tailscale 或你自己的代理）即可使用。",
  };
}

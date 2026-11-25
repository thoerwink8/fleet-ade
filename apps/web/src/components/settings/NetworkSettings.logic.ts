import type { ServerNetworkResult } from "@t3tools/contracts";

export function effectiveRouteSentence(
  route: Pick<ServerNetworkResult, "proxyUrl" | "source" | "detail">,
): string {
  if (route.proxyUrl) {
    const source = route.source === "system" ? "系统代理" : "你填的代理地址";
    return `当前走 ${route.proxyUrl}，来源是${source}。`;
  }
  if (route.detail === "直连") return "当前走直连，因为你把线路设成了直连。";
  if (route.detail === "系统代理没有开") return "当前走直连，因为系统代理没有开。";
  const reason = route.detail.replace(/，已按直连$/, "").replace(/，按直连$/, "");
  const gap = /^[\u4e00-\u9fff]/.test(reason) ? "" : " ";
  return `当前走直连，因为${gap}${reason}。`;
}
// Kept in step with normalizeProxyUrl in packages/provider-core: an address the server drops must
// be rejected here, or "current line" reads direct while the input claims it saved.
export const PROXY_URL_FORMAT_REASON = "地址要写成 http://主机:端口";

export function proxyUrlError(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return PROXY_URL_FORMAT_REASON;
  }
  if (url.username || url.password) return PROXY_URL_FORMAT_REASON;
  if (url.protocol !== "http:" && url.protocol !== "https:") return PROXY_URL_FORMAT_REASON;
  if (!url.hostname || !url.port) return PROXY_URL_FORMAT_REASON;
  return null;
}

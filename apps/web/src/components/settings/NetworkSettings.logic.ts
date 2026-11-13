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

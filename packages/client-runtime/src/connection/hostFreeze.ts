import type { ServerEventLoopStall } from "@t3tools/contracts";

export interface HostFreezeNotice {
  readonly title: string;
  readonly description: string;
}

/**
 * Says why a host stopped answering, from the recent stall it reports on
 * connect. Web shows it as a toast, mobile in the environment's connection row.
 */
export function hostFreezeNotice(
  hostLabel: string,
  stall: ServerEventLoopStall | undefined,
): HostFreezeNotice | null {
  if (stall === undefined) return null;
  const { loadAverage, cpuCount } = stall;
  return {
    title: `${hostLabel} 卡顿了 ${Math.round(stall.durationMs / 1000)} 秒`,
    description:
      loadAverage !== undefined && loadAverage > cpuCount
        ? `其 CPU 负载过高（${Math.round(loadAverage)} 个核心的负载为 ${cpuCount}）。`
        : `${hostLabel} 上的 T3 Code 太忙，未能响应。`,
  };
}

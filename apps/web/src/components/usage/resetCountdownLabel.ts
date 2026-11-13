import type { ResetCountdown } from "@t3tools/shared/usageLimits";

function duration(countdown: Extract<ResetCountdown, { kind: "in" }>): string {
  if (countdown.days > 0) {
    return countdown.hours > 0
      ? `${countdown.days} 天 ${countdown.hours} 小时`
      : `${countdown.days} 天`;
  }
  if (countdown.hours > 0) {
    return countdown.minutes > 0
      ? `${countdown.hours} 小时 ${countdown.minutes} 分钟`
      : `${countdown.hours} 小时`;
  }
  return `${countdown.minutes} 分钟`;
}

export function resetCountdownLabel(countdown: ResetCountdown | null): string | null {
  if (countdown === null) return null;
  if (countdown.kind === "now") return "刚刚重置";
  if (countdown.kind === "momentarily") return "马上重置";
  return `${duration(countdown)}后重置`;
}

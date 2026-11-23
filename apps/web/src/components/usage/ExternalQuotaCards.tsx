import type { ExternalQuotaGroups, ExternalUsageReport } from "@t3tools/contracts";
import { formatCountWan } from "@t3tools/shared/usageFormat";

import { Button } from "../ui/button";
import { QUOTA_STALL_TIMEOUT_MS, usePendingStall } from "./usePendingStall";

function formatReset(resetsAt: string | undefined): string | null {
  if (!resetsAt) return null;
  const parsed = Date.parse(resetsAt);
  if (Number.isNaN(parsed)) return resetsAt;
  return new Date(parsed).toLocaleString("zh-CN", { hour12: false });
}

function Groups({
  title,
  report,
}: {
  readonly title: string;
  readonly report: ExternalQuotaGroups;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-row font-semibold">{title}</h3>
      {report.ok ? (
        report.groups.map((group) => (
          <div key={group.name} className="flex flex-col gap-1">
            <p className="text-xs text-muted-foreground">{group.name}</p>
            {group.windows.map((window) => {
              const reset = formatReset(window.resetsAt);
              return (
                <p key={`${group.name}-${window.label}`} className="text-sm">
                  {`${window.label} 剩余 ${window.remainingPercent}%`}
                  {reset ? `，${reset} 重置` : ""}
                </p>
              );
            })}
          </div>
        ))
      ) : (
        <p className="text-sm text-muted-foreground">{report.message}</p>
      )}
    </section>
  );
}

function UsageRows({
  title,
  rows,
}: {
  readonly title: string;
  readonly rows: ExternalUsageReport;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-row font-semibold">{title}</h3>
      {rows.ok ? (
        rows.agents.length === 0 && rows.models.length === 0 ? (
          <p className="text-sm text-muted-foreground">今天还没有调用。</p>
        ) : (
          <>
            {rows.agents.map((row) => (
              <p key={`agent-${row.name}`} className="text-sm">
                {`${row.name}：调用 ${row.calls}，${formatCountWan(row.tokens)} 词元，花费 ${row.costUsd.toFixed(2)} 美元`}
              </p>
            ))}
            {rows.models.map((row) => (
              <p key={`model-${row.name}`} className="text-sm">
                {`${row.name}：调用 ${row.calls}，${formatCountWan(row.tokens)} 词元，花费 ${row.costUsd.toFixed(2)} 美元`}
              </p>
            ))}
          </>
        )
      ) : (
        <p className="text-sm text-muted-foreground">{rows.message}</p>
      )}
    </section>
  );
}

export function ExternalQuotaCards({
  agy,
  magpieQuotas,
  magpieUsage,
  localLines,
  pending,
  error = null,
  stallTimeoutMs = QUOTA_STALL_TIMEOUT_MS,
  onRefresh,
}: {
  readonly agy: ExternalQuotaGroups | null;
  readonly magpieQuotas: ExternalQuotaGroups | null;
  readonly magpieUsage: ExternalUsageReport | null;
  readonly localLines: readonly string[];
  readonly pending: boolean;
  readonly error?: string | null;
  readonly stallTimeoutMs?: number;
  readonly onRefresh: () => void;
}) {
  const stall = usePendingStall(pending, stallTimeoutMs);
  const reading = pending && !stall.stalled;
  const failure = stall.stalled
    ? `读取失败：超过 ${stallTimeoutMs / 1000} 秒没有读到额度数据。`
    : !pending && error
      ? `读取失败：${error}`
      : null;
  const retry = () => {
    stall.reset();
    onRefresh();
  };
  return (
    <div className="flex flex-col gap-4 rounded-xl border p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-title font-semibold">额度与今日用量</h2>
        <Button size="sm" variant="outline" disabled={reading} onClick={retry}>
          {reading ? "正在读取" : "刷新"}
        </Button>
      </div>
      {reading && agy === null && magpieQuotas === null && magpieUsage === null ? (
        <p className="text-sm text-muted-foreground">正在读取</p>
      ) : null}
      {failure ? (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm text-muted-foreground">{failure}</p>
          <Button size="sm" variant="outline" onClick={retry}>
            重试
          </Button>
        </div>
      ) : null}
      {agy ? <Groups title="Antigravity 额度" report={agy} /> : null}
      {magpieQuotas ? <Groups title="magpie 额度" report={magpieQuotas} /> : null}
      {magpieUsage ? <UsageRows title="magpie 今日用量" rows={magpieUsage} /> : null}
      <section className="flex flex-col gap-1">
        <h3 className="text-row font-semibold">本机日志用量</h3>
        {localLines.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            这段时间没有读到本机日志用量。先用本机 Claude、Codex 或 Grok
            跑一次会话，再点「刷新」；已有会话仍读不到，说明本机日志目录不可用。
          </p>
        ) : (
          localLines.map((line) => (
            <p key={line} className="text-sm">
              {line}
            </p>
          ))
        )}
      </section>
    </div>
  );
}

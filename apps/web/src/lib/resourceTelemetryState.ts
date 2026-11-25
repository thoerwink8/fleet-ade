import { AuthDiagnosticsReadScope } from "@t3tools/contracts";
import { AuthEnvironmentMaintainScope } from "@t3tools/contracts";
import type {
  EnvironmentId,
  ResourceTelemetryHistoryInput,
  ResourceTelemetrySnapshot,
} from "@t3tools/contracts";
import { describeRequestFailure } from "@t3tools/client-runtime/errors";

import { usePrimaryEnvironment } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { serverEnvironment } from "../state/server";
import { readEnvironmentScope, useEnvironmentScope } from "../state/session";
import { useAtomCommand } from "../state/use-atom-command";

export interface ResourceTelemetryState {
  readonly data: ResourceTelemetrySnapshot | null;
  readonly error: string | null;
  readonly isPending: boolean;
  readonly refresh: () => void;
  readonly retry: () => Promise<ResourceTelemetrySnapshot>;
}

export function useResourceTelemetry(
  targetEnvironmentId?: EnvironmentId | null,
): ResourceTelemetryState {
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId =
    targetEnvironmentId === undefined
      ? (primaryEnvironment?.environmentId ?? null)
      : targetEnvironmentId;
  const canReadDiagnostics = useEnvironmentScope(environmentId, AuthDiagnosticsReadScope);
  const query = useEnvironmentQuery(
    environmentId === null || !canReadDiagnostics
      ? null
      : serverEnvironment.resourceTelemetry({ environmentId, input: {} }),
  );
  const retryCommand = useAtomCommand(serverEnvironment.retryResourceTelemetry, {
    reportFailure: false,
  });
  const retry = async () => {
    if (environmentId === null) {
      throw new Error("没有选择电脑。");
    }
    if (
      !readEnvironmentScope(environmentId, AuthEnvironmentMaintainScope) ||
      !readEnvironmentScope(environmentId, AuthDiagnosticsReadScope)
    ) {
      throw new Error("此连接无法重启资源监控。");
    }
    const result = await retryCommand({ environmentId, input: {} });
    if (result._tag === "Failure") {
      throw describeRequestFailure(result.cause);
    }
    query.refresh();
    return result.value.snapshot;
  };

  return { ...query, retry };
}

export function useResourceTelemetryHistory(
  input: ResourceTelemetryHistoryInput,
  targetEnvironmentId?: EnvironmentId | null,
) {
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId =
    targetEnvironmentId === undefined
      ? (primaryEnvironment?.environmentId ?? null)
      : targetEnvironmentId;
  const canReadDiagnostics = useEnvironmentScope(environmentId, AuthDiagnosticsReadScope);
  return useEnvironmentQuery(
    environmentId === null || !canReadDiagnostics
      ? null
      : serverEnvironment.resourceTelemetryHistory({ environmentId, input }),
  );
}

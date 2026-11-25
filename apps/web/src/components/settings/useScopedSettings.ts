import { AuthSettingsWriteScope } from "@t3tools/contracts";
import { useEnvironmentsWithScope } from "../../state/session";
import {
  requiredScopesForServerSettingsPatch,
  EnvironmentAuthorizationError,
} from "@t3tools/contracts";
import { readEnvironmentScope } from "../../state/session";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import {
  DEFAULT_SERVER_SETTINGS,
  type EnvironmentId,
  type ProjectScopedServerSettingKey,
  type ServerSettings,
  type UnifiedSettings,
} from "@t3tools/contracts";

import { persistClientSettingsPatch, useMergedSettings } from "../../hooks/useSettings";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastManager } from "../ui/toast";
import { useOptionalSettingsScope, useSettingsScope } from "./SettingsScopeContext";
import {
  persistScopedSettingsPatch,
  planProjectOverridesClear,
  planScopedSettingsClear,
  planScopedSettingsPatch,
  scopedSettingsAreMixed,
  scopedSettingsSource,
  type ProjectOverrideEntry,
  type ScopedSettingsPatch,
} from "./scopedSettings";

export function useScopedSettings<T = UnifiedSettings>(
  selector?: (settings: UnifiedSettings) => T,
): T {
  const { target } = useSettingsScope();
  return useMergedSettings(target?.settings ?? DEFAULT_SERVER_SETTINGS, selector);
}

export function useScopedSettingsMixed(keys: readonly (keyof ServerSettings)[]): boolean {
  const { targets } = useSettingsScope();
  return scopedSettingsAreMixed(targets, keys);
}

export function useScopedSettingSource(keys: readonly (keyof ServerSettings)[]) {
  const { targets } = useSettingsScope();
  return scopedSettingsSource(targets, keys);
}

export interface ScopedSettingsSaveResult {
  readonly savedEnvironmentIds: readonly EnvironmentId[];
  readonly failedCount: number;
}

export interface ScopedSettingsSaveOptions {
  readonly onFailed?: () => void;
  readonly onComplete?: (result: ScopedSettingsSaveResult) => void;
}

function useRunScopedPlan() {
  const persistServer = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  return (
    plan: ReturnType<typeof planScopedSettingsPatch>,
    options?: ScopedSettingsSaveOptions,
  ): Promise<boolean> => {
    if (plan.unavailableReason) {
      toastManager.add({
        type: "warning",
        title: "设置未保存",
        description: plan.unavailableReason,
      });
      options?.onFailed?.();
      options?.onComplete?.({ savedEnvironmentIds: [], failedCount: 1 });
      return Promise.resolve(false);
    }
    return persistScopedSettingsPatch(
      plan,
      async (request) => {
        const missing = requiredScopesForServerSettingsPatch(request.input.patch).find(
          (scope) => !readEnvironmentScope(request.environmentId, scope),
        );
        if (missing)
          return AsyncResult.failure(
            Cause.fail(
              new EnvironmentAuthorizationError({
                requiredScope: missing,
                message: "此连接无权修改这些设置。",
              }),
            ),
          );
        return persistServer(request);
      },
      persistClientSettingsPatch,
    ).then(({ failedEnvironments, savedEnvironments, savedEnvironmentCount }) => {
      if (failedEnvironments.length > 0) {
        options?.onFailed?.();
        toastManager.add({
          type: "error",
          title: savedEnvironmentCount > 0 ? "部分电脑已保存设置" : "设置未保存",
          description: [
            ...failedEnvironments.map(({ label, message }) => `无法在 ${label} 上保存：${message}`),
            ...(savedEnvironmentCount > 0
              ? [`已保存到 ${savedEnvironments.map(({ label }) => label).join(", ")}。`]
              : []),
          ].join("\n"),
        });
      }
      options?.onComplete?.({
        savedEnvironmentIds: savedEnvironments.map((environment) => environment.environmentId),
        failedCount: failedEnvironments.length,
      });
      return failedEnvironments.length === 0;
    });
  };
}

export function useUpdateScopedSettings(hookOptions?: { readonly deviceOnly?: boolean }) {
  const { scope, environments, deviceOnly } = useSettingsScope();
  const run = useRunScopedPlan();
  /** `onFailed` runs when any target rejects or drops the patch, so a draft can fall back. */
  return (patch: ScopedSettingsPatch, options?: ScopedSettingsSaveOptions) =>
    run(
      planScopedSettingsPatch(scope, environments, patch, {
        deviceOnly: hookOptions?.deviceOnly ?? deviceOnly,
      }),
      options,
    );
}

export function useClearScopedSettings() {
  const context = useOptionalSettingsScope();
  const run = useRunScopedPlan();
  return (keys: readonly ProjectScopedServerSettingKey[], options?: ScopedSettingsSaveOptions) => {
    if (context === null) return;
    run(planScopedSettingsClear(context.scope, context.environments, keys), options);
  };
}

export function useClearProjectOverrides() {
  const context = useOptionalSettingsScope();
  const run = useRunScopedPlan();
  return (
    entries: readonly ProjectOverrideEntry[],
    keys: readonly ProjectScopedServerSettingKey[],
  ) => {
    if (context === null) return;
    run(planProjectOverridesClear(context.environments, entries, keys));
  };
}

export function useScopedSettingsWriteAllowed() {
  const { connectedEnvironments } = useSettingsScope();
  const writable = useEnvironmentsWithScope(connectedEnvironments, AuthSettingsWriteScope);
  return (
    connectedEnvironments.length > 0 &&
    connectedEnvironments.every((target) => writable.has(target.environmentId))
  );
}

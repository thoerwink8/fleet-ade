import { useAtomValue } from "@effect/atom-react";
import { PROVIDER_DISPLAY_NAMES } from "@t3tools/contracts";

import { APP_VERSION } from "~/branding";
import { isDesktopLocalConnectionTarget } from "~/connection/desktopLocal";
import { isElectron } from "~/env";
import { useEnvironments } from "~/state/environments";
import { environmentIdsKey } from "~/state/environmentAtomList";
import { environmentUpdateStatesAtom } from "~/state/server";
import { environmentSessionStatesAtom } from "~/state/session";
import { getProviderUpdateRunOutcome } from "../ProviderUpdateLaunchNotification.logic";
import { useProviderUpdates } from "../ProviderUpdatesAction";
import { canUpdateServer, type ServerUpdateOutcome, useServerUpdate } from "../ServerUpdateAction";
import {
  closeFinishedUpdateRun,
  collectRestartingMachines,
  collectServerUpdateTargets,
  collectUpdateEverythingResult,
  describeUpdateEverything,
  type UpdateRunMachine,
} from "./updateEverything.logic";
import {
  setUpdateEverythingRun,
  settleUpdateRunMachine,
  showUpdateEverythingResult,
  waitForServerUpdateHandoff,
} from "./updateEverythingRun";

/** Servers this desktop app runs. They are not updated from here. */
function isHostedByThisApp(
  environment: ReturnType<typeof useEnvironments>["environments"][number],
) {
  return (
    isElectron &&
    (environment.entry.target._tag === "PrimaryConnectionTarget" ||
      isDesktopLocalConnectionTarget(environment.entry.target))
  );
}

export function useUpdateEverything() {
  const targetVersion = APP_VERSION;
  const { environments } = useEnvironments();
  const environmentIds = environmentIdsKey(environments.map(({ environmentId }) => environmentId));
  const sessionStates = useAtomValue(environmentSessionStatesAtom(environmentIds));
  const updateStates = useAtomValue(environmentUpdateStatesAtom(environmentIds));
  const machines = environments.map((environment, index) => ({
    environmentId: environment.environmentId,
    label: environment.label,
    serverConfig: environment.serverConfig,
    connected: environment.connection.phase === "connected",
    hostedByThisApp: isHostedByThisApp(environment),
    canMaintain: canUpdateServer(sessionStates[index]!),
    updateState: updateStates[index]!,
  }));
  const { targets: servers, skipped } = collectServerUpdateTargets(machines, targetVersion);
  const restarts = collectRestartingMachines(machines, servers);
  const providers = useProviderUpdates();
  const updateServer = useServerUpdate();

  const view = describeUpdateEverything({
    servers,
    skipped,
    providerMachines: providers.machines.map((machine) => ({
      environmentId: machine.environmentId,
      label: machine.label,
      providers: machine.candidates.map(
        (candidate) => PROVIDER_DISPLAY_NAMES[candidate.driver] ?? candidate.driver,
      ),
    })),
  });

  return {
    hasUpdates: servers.length > 0 || providers.machines.length > 0,
    ...view,
    restarts,
    run: async () => {
      const startedAt = Date.now();
      const machinesById = new Map<UpdateRunMachine["environmentId"], UpdateRunMachine>();
      for (const machine of providers.machines) {
        machinesById.set(machine.environmentId, {
          environmentId: machine.environmentId,
          label: machine.label,
          updatesProviders: true,
          server: null,
          handedOffVersion: null,
          startedAt,
          result: null,
          failure: null,
          providerFailure: null,
        });
      }
      for (const server of servers) {
        const existing = machinesById.get(server.environmentId);
        machinesById.set(server.environmentId, {
          environmentId: server.environmentId,
          label: server.serverLabel,
          updatesProviders: existing?.updatesProviders ?? false,
          server,
          handedOffVersion: null,
          startedAt,
          result: null,
          failure: null,
          providerFailure: null,
        });
      }
      setUpdateEverythingRun(() => ({
        phase: "providers",
        machines: Array.from(machinesById.values()),
      }));
      const providerFailures = new Map<UpdateRunMachine["environmentId"], string>();
      const finishedServers: Array<{ label: string; outcome: ServerUpdateOutcome }> = [];
      try {
        // Finish provider installs before server restarts.
        const providerRuns = await providers.updateAll({ quiet: true });
        const providerOutcomes = providerRuns.map((run) => {
          const runOutcome = getProviderUpdateRunOutcome(run);
          if (runOutcome.status !== "updated") {
            providerFailures.set(
              run.environmentId,
              runOutcome.status === "failed" ? runOutcome.line : "智能体更新已中断",
            );
          }
          return runOutcome;
        });
        for (const machine of machinesById.values()) {
          if (machine.server === null) {
            settleUpdateRunMachine(
              machine.environmentId,
              providerFailures.get(machine.environmentId) ?? null,
            );
          }
        }
        const serversStartedAt = Date.now();
        setUpdateEverythingRun(
          (run) =>
            run && {
              ...run,
              phase: "servers",
              machines: run.machines.map((machine) =>
                machine.server === null ? machine : { ...machine, startedAt: serversStartedAt },
              ),
            },
        );

        const runs = servers.map(async (server) => {
          const serverOutcome = await updateServer(server, { quiet: true });
          settleUpdateRunMachine(
            server.environmentId,
            serverOutcome.status === "failed"
              ? serverOutcome.message
              : (providerFailures.get(server.environmentId) ?? null),
            {
              serverUpdated: serverOutcome.status !== "failed",
              providerFailure: providerFailures.get(server.environmentId) ?? null,
            },
          );
          const finished = { label: server.serverLabel, outcome: serverOutcome };
          finishedServers.push(finished);
          return finished;
        });
        await Promise.all(
          servers.map((server, index) =>
            waitForServerUpdateHandoff(server.environmentId, runs[index]!),
          ),
        );
        const finished = await Promise.all(runs);

        setUpdateEverythingRun(
          (run) =>
            run &&
            closeFinishedUpdateRun({
              ...run,
              phase: "servers",
            }),
        );
        showUpdateEverythingResult(
          collectUpdateEverythingResult({
            servers: finished,
            providers: providerOutcomes,
          }),
        );
      } catch (error) {
        setUpdateEverythingRun(() => null);
        throw error;
      }
    },
  };
}

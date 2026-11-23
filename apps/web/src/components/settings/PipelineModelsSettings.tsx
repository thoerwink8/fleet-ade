import {
  AuthSettingsWriteScope,
  type EnvironmentId,
  type ModelSelection,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { ArrowDownIcon, ArrowUpIcon, XIcon } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import { providerInstanceEntriesFor, type ProviderInstanceEntry } from "../../providerInstances";
import { useEnvironmentScope } from "../../state/session";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import {
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingResetButton,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import type { ModelEsque } from "../chat/providerIconUtils";
import { searchableSetting } from "./settingsSearch";
import {
  appendCandidate,
  moveCandidate,
  pipelineCandidateDisabledReason,
  pipelineCandidateDisplay,
  removeCandidateAt,
  verifierConflictsWithAuthor,
} from "./PipelineModelsSettings.logic";

const EMPTY_INSTANCE_ID = "" as ProviderInstanceId;

/** One environment's ordered author/verifier candidate lists, edited in place per stage. */
export function PipelineModelsSettings({
  environmentId,
  providers,
  readOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly readOnly: boolean;
}) {
  const settings = useEnvironmentSettings(environmentId);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const canWriteSettings = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const navigate = useNavigate();
  const entries = providerInstanceEntriesFor(providers, settings, null);
  const modelOptionsByInstance = getCustomModelOptionsByInstance(settings, providers);
  const author = settings.pipelineAuthorModel;
  const verifier = settings.pipelineVerifierModel;
  const editable = !readOnly && canWriteSettings;

  const stageProps = {
    environmentId,
    entries,
    modelOptionsByInstance,
    editable,
    onOpenProviderSetup: (instanceId: ProviderInstanceId) => {
      void navigate({
        to: "/settings/providers",
        search: { environmentId, instanceId },
      });
    },
  };

  return (
    <SettingsSection title="流水线模型">
      <PipelineCandidateRow
        {...stageProps}
        {...searchableSetting("pipeline-author-model")}
        description="流水线派发时按顺序尝试的第一个可用模型；空列表会停在“没配模型”。"
        candidates={author}
        resetAction={
          author.length > 0 && editable ? (
            <SettingResetButton
              label="写单模型"
              onClick={() => updateSettings({ pipelineAuthorModel: [] })}
            />
          ) : null
        }
        onChange={(pipelineAuthorModel) => updateSettings({ pipelineAuthorModel })}
      />
      <PipelineCandidateRow
        {...stageProps}
        {...searchableSetting("pipeline-verifier-model")}
        description="验单按顺序选第一个可用候选，但它的第一个可用模型不能与写单模型相同。"
        status={
          verifierConflictsWithAuthor(author, verifier)
            ? "第一个可用验单模型与写单模型相同，验单会停在“没配模型”。请更换其中一个。"
            : null
        }
        candidates={verifier}
        resetAction={
          verifier.length > 0 && editable ? (
            <SettingResetButton
              label="验单模型"
              onClick={() => updateSettings({ pipelineVerifierModel: [] })}
            />
          ) : null
        }
        onChange={(pipelineVerifierModel) => updateSettings({ pipelineVerifierModel })}
      />
    </SettingsSection>
  );
}

function PipelineCandidateRow({
  id,
  title,
  description,
  status,
  resetAction,
  candidates,
  editable,
  environmentId,
  entries,
  modelOptionsByInstance,
  onChange,
  onOpenProviderSetup,
}: {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly status?: string | null;
  readonly resetAction?: ReactNode;
  readonly candidates: ReadonlyArray<ModelSelection>;
  readonly editable: boolean;
  readonly environmentId: EnvironmentId;
  readonly entries: ReadonlyArray<ProviderInstanceEntry>;
  readonly modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  readonly onChange: (candidates: ReadonlyArray<ModelSelection>) => void;
  readonly onOpenProviderSetup: (instanceId: ProviderInstanceId) => void;
}) {
  const activeInstanceId =
    candidates.at(-1)?.instanceId ?? entries[0]?.instanceId ?? EMPTY_INSTANCE_ID;
  return (
    <SettingsRow
      id={id}
      title={title}
      description={description}
      status={status}
      resetAction={resetAction}
    >
      <div className="flex flex-col gap-1.5 pt-2 pb-1">
        {candidates.length === 0 ? (
          <p className="text-xs text-muted-foreground">还没有候选模型。</p>
        ) : (
          <ol className="flex flex-col gap-0.5">
            {candidates.map((selection, index) => {
              const display = pipelineCandidateDisplay({
                selection,
                entries,
                modelOptionsByInstance,
              });
              const entry = entries.find(
                (candidate) => candidate.instanceId === selection.instanceId,
              );
              return (
                <li
                  // oxlint-disable-next-line react/no-array-index-key -- a hand-edited list can repeat the same instance and model; the index is the only stable distinction
                  key={`${selection.instanceId}:${selection.model}:${index}`}
                  className="flex min-w-0 items-center gap-2"
                >
                  <ProviderInstanceIcon
                    driverKind={entry?.driverKind ?? ProviderDriverKind.make(selection.instanceId)}
                    displayName={entry?.displayName ?? selection.instanceId}
                    accentColor={entry?.accentColor}
                    acpRegistryAgentId={entry?.acpRegistryAgentId}
                    acpRegistryIconUrl={entry?.acpRegistryIconUrl}
                    className="shrink-0"
                  />
                  <span className="min-w-0 truncate text-sm">
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <span className="min-w-0 truncate" tabIndex={0}>
                            {display.name}
                            {selection.options && selection.options.length > 0 ? (
                              <span className="ps-1.5 text-xs text-muted-foreground">带参数</span>
                            ) : null}
                          </span>
                        }
                      />
                      <TooltipPopup side="top">
                        {entry ? `${entry.displayName} · ` : ""}
                        {display.slug}
                        {display.unavailableReason ? ` · ${display.unavailableReason}` : ""}
                      </TooltipPopup>
                    </Tooltip>
                  </span>
                  {display.unavailableReason ? (
                    <Badge variant="outline" size="sm">
                      不可用
                    </Badge>
                  ) : null}
                  <span className="flex shrink-0 items-center gap-0.5">
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            size="icon-micro"
                            variant="ghost-muted"
                            disabled={!editable || index === 0}
                            onClick={() => onChange(moveCandidate(candidates, index, -1))}
                            aria-label={`上移 ${display.name}`}
                          />
                        }
                      >
                        <ArrowUpIcon className="size-3" />
                      </TooltipTrigger>
                      <TooltipPopup side="top">上移</TooltipPopup>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            size="icon-micro"
                            variant="ghost-muted"
                            disabled={!editable || index === candidates.length - 1}
                            onClick={() => onChange(moveCandidate(candidates, index, 1))}
                            aria-label={`下移 ${display.name}`}
                          />
                        }
                      >
                        <ArrowDownIcon className="size-3" />
                      </TooltipTrigger>
                      <TooltipPopup side="top">下移</TooltipPopup>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            size="icon-micro"
                            variant="ghost-muted"
                            disabled={!editable}
                            onClick={() => onChange(removeCandidateAt(candidates, index))}
                            aria-label={`移除 ${display.name}`}
                          />
                        }
                      >
                        <XIcon className="size-3" />
                      </TooltipTrigger>
                      <TooltipPopup side="top">移除</TooltipPopup>
                    </Tooltip>
                  </span>
                </li>
              );
            })}
          </ol>
        )}
        {editable && entries.length > 0 ? (
          <div>
            <ProviderModelPicker
              environmentId={environmentId}
              activeInstanceId={activeInstanceId}
              model=""
              lockedProvider={null}
              instanceEntries={entries}
              modelOptionsByInstance={modelOptionsByInstance}
              triggerLabel="添加候选模型"
              triggerAriaLabel={`${title}：添加候选模型`}
              triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
              getModelDisabledReason={(instanceId, model) =>
                pipelineCandidateDisabledReason(candidates, instanceId, model)
              }
              onOpenProviderSetup={onOpenProviderSetup}
              onInstanceModelChange={(instanceId, model) =>
                onChange(appendCandidate(candidates, createModelSelection(instanceId, model)))
              }
            />
          </div>
        ) : null}
      </div>
    </SettingsRow>
  );
}

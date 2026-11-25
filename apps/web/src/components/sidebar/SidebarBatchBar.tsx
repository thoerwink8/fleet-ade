import type { EnvironmentServerConfig } from "@t3tools/client-runtime/connection";
import {
  threadRuntimeCanArchive,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { EllipsisIcon, XIcon } from "lucide-react";

import { readEnvironmentScope } from "~/state/session";
import { useThreadSelectionStore } from "~/threadSelectionStore";
import type { MultiSelectThreadMenuId } from "../Sidebar.logic";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

function canOperateThreads(
  threads: ReadonlyArray<Pick<EnvironmentThreadShell, "environmentId">>,
): boolean {
  return threads.every((thread) =>
    readEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope),
  );
}

export function SidebarBatchBar(props: {
  threadByKey: ReadonlyMap<string, EnvironmentThreadShell>;
  orderedThreadCount: number;
  serverConfigs: ReadonlyMap<string, EnvironmentServerConfig>;
  onAction: (action: MultiSelectThreadMenuId) => void;
  onClearSelection: () => void;
}) {
  const selectedThreadKeys = useThreadSelectionStore((state) => state.selectedThreadKeys);
  if (selectedThreadKeys.size === 0) return null;

  const selectedThreads: EnvironmentThreadShell[] = [];
  for (const key of selectedThreadKeys) {
    const thread = props.threadByKey.get(key);
    if (thread) selectedThreads.push(thread);
  }
  if (selectedThreads.length === 0) return null;

  const archiveableThreads = selectedThreads.filter((thread) =>
    threadRuntimeCanArchive(thread.runtime),
  );
  const settlingThreads = selectedThreads.filter(
    (thread) =>
      props.serverConfigs.has(thread.environmentId) && thread.settledOverride !== "settled",
  );
  const pinnedSelectedThreads = selectedThreads.filter(
    (thread) => props.serverConfigs.has(thread.environmentId) && thread.pinnedAt != null,
  );
  const canArchive = archiveableThreads.length > 0 && canOperateThreads(archiveableThreads);
  const canSettle = settlingThreads.length > 0 && canOperateThreads(settlingThreads);
  const canUnpin = pinnedSelectedThreads.length > 0 && canOperateThreads(pinnedSelectedThreads);
  const canDelete = canOperateThreads(selectedThreads);

  return (
    <div className="px-2">
      <div
        className="fa-batch"
        role="toolbar"
        aria-label="批量操作"
        data-testid="sidebar-batch-bar"
      >
        <span className="n">{`已选 ${selectedThreads.length} 项`}</span>
        <Button
          variant="ghost"
          size="sm"
          disabled={!canArchive}
          onClick={() => props.onAction("archive")}
        >
          归档
        </Button>
        {settlingThreads.length > 0 ? (
          <span className="is-overflow">
            <Button
              variant="ghost"
              size="sm"
              disabled={!canSettle}
              onClick={() => props.onAction("settle")}
            >
              标为完成
            </Button>
          </span>
        ) : null}
        <span className="is-overflow ade-batch-danger">
          <Button
            variant="ghost-destructive"
            size="sm"
            disabled={!canDelete}
            onClick={() => props.onAction("delete")}
          >
            删除
          </Button>
        </span>
        <span className="fa-batch__more">
          <Menu>
            <MenuTrigger
              render={
                <Button variant="ghost-muted" size="icon-sm" aria-label="更多批量操作">
                  <EllipsisIcon aria-hidden="true" />
                </Button>
              }
            />
            <MenuPopup align="end" side="bottom">
              {settlingThreads.length > 0 ? (
                <MenuItem disabled={!canSettle} onClick={() => props.onAction("settle")}>
                  标为完成
                </MenuItem>
              ) : null}
              {pinnedSelectedThreads.length > 0 ? (
                <MenuItem disabled={!canUnpin} onClick={() => props.onAction("unpin")}>
                  取消置顶
                </MenuItem>
              ) : null}
              <MenuItem onClick={() => props.onAction("mark-unread")}>标为未读</MenuItem>
              {selectedThreads.length < props.orderedThreadCount ? (
                <MenuItem onClick={() => props.onAction("select-all")}>全选当前列表</MenuItem>
              ) : null}
              <MenuSeparator />
              <MenuItem
                variant="destructive"
                disabled={!canDelete}
                onClick={() => props.onAction("delete")}
              >
                删除
              </MenuItem>
            </MenuPopup>
          </Menu>
        </span>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost-muted"
                size="icon-sm"
                aria-label="退出多选（Esc）"
                onClick={props.onClearSelection}
              >
                <XIcon aria-hidden="true" />
              </Button>
            }
          />
          <TooltipPopup side="bottom">退出多选（Esc）</TooltipPopup>
        </Tooltip>
      </div>
    </div>
  );
}

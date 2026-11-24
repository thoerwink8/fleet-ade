import { DEFAULT_SERVER_SETTINGS, ProjectId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  cleanupPatchCanDeleteMore,
  decideStorageCleanupRuleConfirm,
  resolveStorageCleanupSweepFeedback,
  retentionDaysCanDeleteMore,
  runStorageCleanupIfConfirmed,
  storageCleanupAmounts,
  storageCleanupChangeIntent,
  storageCleanupConfirmState,
  storageCleanupListedTotal,
  worktreeRulesCanDeleteMore,
} from "./storageCleanupConfirm.logic";

const categories = [
  { kind: "worktree" as const, count: 2, bytes: 1_048_576, unknownCount: 0 },
  { kind: "browser-artifacts" as const, count: 3, bytes: 2_048, unknownCount: 1 },
  { kind: "logs" as const, count: 4, bytes: 512, unknownCount: 0 },
];

describe("storage cleanup confirmation", () => {
  it("lists a total equal to the sum of the categories", () => {
    const amounts = storageCleanupAmounts([
      { environmentLabel: null, categories },
      {
        environmentLabel: "另一台电脑",
        categories: [{ kind: "logs", count: 1, bytes: 128, unknownCount: 0 }],
      },
    ]);
    const listed = storageCleanupListedTotal(amounts);
    expect(listed).toBe(amounts.reduce((sum, amount) => sum + amount.bytes, 0));
    expect(listed).toBe(1_048_576 + 2_048 + 512 + 128);
    const state = storageCleanupConfirmState({ amounts, failures: [] });
    expect(state.totalBytes).toBe(listed);
    expect(state.title).toBe("删除这些内容？");
    expect(state.confirmLabel).toBe("删除");
    expect(state.confirmDisabled).toBe(false);
  });

  it("disables confirm when nothing would be removed", () => {
    const state = storageCleanupConfirmState({ amounts: [], failures: [] });
    expect(state.confirmDisabled).toBe(true);
    expect(state.disabledReason).toBe("按当前规则，没有要删除的内容。");
    expect(state.totalBytes).toBe(0);
  });

  it("a failure to check one item does not block removing the rest", () => {
    const amounts = storageCleanupAmounts([{ environmentLabel: null, categories }]);
    const state = storageCleanupConfirmState({ amounts, failures: ["读不了目录"] });
    expect(state.confirmDisabled).toBe(false);
    expect(state.notice).toContain("读不了目录");
    const none = storageCleanupConfirmState({ amounts: [], failures: ["读不了目录"] });
    expect(none.confirmDisabled).toBe(true);
    expect(none.disabledReason).toBe("读不了目录");
  });

  it("cancel removes nothing", async () => {
    const run = vi.fn(async () => undefined);
    const state = storageCleanupConfirmState({
      amounts: storageCleanupAmounts([{ environmentLabel: null, categories }]),
      failures: [],
    });
    expect(await runStorageCleanupIfConfirmed("cancel", state, run)).toBe(false);
    expect(await runStorageCleanupIfConfirmed("confirm", { confirmDisabled: true }, run)).toBe(
      false,
    );
    expect(run).not.toHaveBeenCalled();
    expect(await runStorageCleanupIfConfirmed("confirm", state, run)).toBe(true);
    expect(run).toHaveBeenCalledOnce();
  });

  it("detects when retention days or worktree rules can delete more", () => {
    expect(retentionDaysCanDeleteMore(null, 8)).toBe(true);
    expect(retentionDaysCanDeleteMore(30, 7)).toBe(true);
    expect(retentionDaysCanDeleteMore(5, 0)).toBe(true);
    expect(retentionDaysCanDeleteMore(8, 30)).toBe(false);
    expect(retentionDaysCanDeleteMore(8, 8)).toBe(false);
    expect(retentionDaysCanDeleteMore(8, null)).toBe(false);

    const offRules = DEFAULT_SERVER_SETTINGS.storageCleanup;
    expect(worktreeRulesCanDeleteMore(offRules, { ...offRules, worktreeOnDelete: true })).toBe(
      true,
    );
    expect(worktreeRulesCanDeleteMore(offRules, { ...offRules, worktreeOnMerge: true })).toBe(true);
    expect(worktreeRulesCanDeleteMore(offRules, { ...offRules, worktreeUnchanged: true })).toBe(
      true,
    );
    expect(worktreeRulesCanDeleteMore(offRules, { ...offRules, worktreeAfterDays: 8 })).toBe(true);
    expect(worktreeRulesCanDeleteMore(offRules, { ...offRules, worktreeSettledAfterDays: 0 })).toBe(
      true,
    );
    expect(
      worktreeRulesCanDeleteMore(offRules, { ...offRules, worktreeKeepWhen: "tracked-changes" }),
    ).toBe(false);
    expect(
      worktreeRulesCanDeleteMore(
        { ...offRules, worktreeAfterDays: 8, worktreeKeepWhen: "any-local-files" },
        { ...offRules, worktreeAfterDays: 8, worktreeKeepWhen: "uncommitted-changes" },
      ),
    ).toBe(true);
    expect(
      worktreeRulesCanDeleteMore(
        { ...offRules, worktreeAfterDays: 8, worktreeKeepWhen: "tracked-changes" },
        { ...offRules, worktreeAfterDays: 8, worktreeKeepWhen: "any-local-files" },
      ),
    ).toBe(false);
  });

  it("evaluates tightening across machine and project override patches", () => {
    const base = DEFAULT_SERVER_SETTINGS;
    const projectId = ProjectId.make("project-1");
    expect(cleanupPatchCanDeleteMore(base, { storageCleanup: { logsAfterDays: 8 } })).toBe(true);
    expect(storageCleanupChangeIntent(base, { storageCleanup: { logsAfterDays: 8 } })).toBe(
      "enable",
    );

    const withLogs = {
      ...base,
      storageCleanup: { ...base.storageCleanup, logsAfterDays: 30 },
    };
    expect(cleanupPatchCanDeleteMore(withLogs, { storageCleanup: { logsAfterDays: 7 } })).toBe(
      true,
    );
    expect(storageCleanupChangeIntent(withLogs, { storageCleanup: { logsAfterDays: 7 } })).toBe(
      "update",
    );
    expect(cleanupPatchCanDeleteMore(withLogs, { storageCleanup: { logsAfterDays: 60 } })).toBe(
      false,
    );
    expect(cleanupPatchCanDeleteMore(withLogs, { storageCleanup: { logsAfterDays: null } })).toBe(
      false,
    );

    const projectOff = {
      ...base,
      storageCleanup: { ...base.storageCleanup, worktreeAfterDays: 8 },
      projectSettingsOverrides: {
        [projectId]: { worktreeCleanup: { mode: "off" as const } },
      },
    };
    expect(
      cleanupPatchCanDeleteMore(projectOff, { projectSettingsOverrides: { [projectId]: null } }),
    ).toBe(true);
    expect(
      storageCleanupChangeIntent(projectOff, { projectSettingsOverrides: { [projectId]: null } }),
    ).toBe("enable");
    expect(
      cleanupPatchCanDeleteMore(base, {
        projectSettingsOverrides: {
          [projectId]: { worktreeCleanup: { mode: "off" as const } },
        },
      }),
    ).toBe(false);
  });

  it("decides confirmation vs immediate save vs blocked for preview results", () => {
    expect(
      decideStorageCleanupRuleConfirm({
        intent: "enable",
        unsupportedLabels: [],
        interruptedOnly: false,
        previews: [{ environmentLabel: null, categories: [] }],
        failures: [],
      }),
    ).toEqual({ kind: "apply-immediately" });

    const enableConfirm = decideStorageCleanupRuleConfirm({
      intent: "enable",
      unsupportedLabels: [],
      interruptedOnly: false,
      previews: [{ environmentLabel: null, categories }],
      failures: [],
    });
    expect(enableConfirm).toMatchObject({
      kind: "confirm",
      dialog: {
        confirmLabel: "打开并清理",
        confirmDisabled: false,
      },
    });

    const updateConfirm = decideStorageCleanupRuleConfirm({
      intent: "update",
      unsupportedLabels: [],
      interruptedOnly: false,
      previews: [
        {
          environmentLabel: null,
          categories: [{ kind: "worktree", count: 1, bytes: 0, unknownCount: 0 }],
        },
      ],
      failures: [],
    });
    expect(updateConfirm).toMatchObject({
      kind: "confirm",
      dialog: {
        confirmLabel: "修改并清理",
        confirmDisabled: false,
      },
    });

    expect(
      decideStorageCleanupRuleConfirm({
        intent: "enable",
        unsupportedLabels: ["远程电脑"],
        interruptedOnly: false,
        previews: [],
        failures: [],
      }),
    ).toEqual({
      kind: "blocked",
      message: "这台电脑的版本还不能在修改前预览将要删除的内容，请先更新。",
    });

    expect(
      decideStorageCleanupRuleConfirm({
        intent: "enable",
        unsupportedLabels: [],
        interruptedOnly: false,
        previews: [],
        failures: ["连接已断开"],
      }),
    ).toEqual({
      kind: "blocked",
      message: "无法确认将要删除的内容：连接已断开",
    });

    expect(
      decideStorageCleanupRuleConfirm({
        intent: "enable",
        unsupportedLabels: [],
        interruptedOnly: true,
        previews: [],
        failures: [],
      }),
    ).toEqual({ kind: "cancelled" });

    expect(
      decideStorageCleanupRuleConfirm({
        intent: "enable",
        unsupportedLabels: [],
        interruptedOnly: true,
        previews: [{ environmentLabel: "本机", categories: [] }],
        failures: [],
      }),
    ).toEqual({ kind: "cancelled" });
  });

  it("reports real bytes freed once all saved environments finish sweeping", () => {
    const beforeReport = {
      trigger: "automatic" as const,
      startedAt: "2026-11-25T00:00:00.000Z",
      finishedAt: "2026-11-25T00:00:01.000Z",
      entries: [],
      counts: { removed: 0, kept: 0, failed: 0 },
      omittedCount: 0,
      bytesFreed: 0,
    };
    const afterReport = {
      ...beforeReport,
      startedAt: "2026-11-25T00:01:00.000Z",
      finishedAt: "2026-11-25T00:01:01.000Z",
      counts: { removed: 1, kept: 0, failed: 0 },
      bytesFreed: 2048,
    };
    expect(
      resolveStorageCleanupSweepFeedback(
        [{ environmentId: "env-a", label: "本机", beforeReport }],
        new Map([["env-a", beforeReport]]),
      ),
    ).toEqual({ kind: "running", message: "已保存设置，正在清理…" });
    expect(
      resolveStorageCleanupSweepFeedback(
        [{ environmentId: "env-a", label: "本机", beforeReport }],
        new Map([["env-a", { ...beforeReport }]]),
      ),
    ).toEqual({ kind: "running", message: "已保存设置，正在清理…" });
    expect(
      resolveStorageCleanupSweepFeedback(
        [{ environmentId: "env-a", label: "本机", beforeReport }],
        new Map([["env-a", afterReport]]),
      ),
    ).toEqual({ kind: "done", message: "已释放 2.00 KB。" });
    expect(
      resolveStorageCleanupSweepFeedback(
        [{ environmentId: "env-a", label: "本机", beforeReport }],
        new Map([
          [
            "env-a",
            {
              ...afterReport,
              bytesFreed: 1024,
              counts: { removed: 1, kept: 0, failed: 1 },
              entries: [
                {
                  kind: "worktree",
                  outcome: "failed",
                  reason: "工作树已锁定",
                  path: null,
                  projectPath: null,
                  threadId: null,
                  threadTitle: null,
                  bytes: null,
                  files: null,
                },
              ],
            },
          ],
        ]),
      ),
    ).toEqual({ kind: "failed", message: "已释放 1.00 KB。无法删除：工作树已锁定" });
  });
});

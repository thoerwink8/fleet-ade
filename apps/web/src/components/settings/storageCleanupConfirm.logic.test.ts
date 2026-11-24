import { describe, expect, it, vi } from "vite-plus/test";

import {
  runStorageCleanupIfConfirmed,
  storageCleanupAmounts,
  storageCleanupConfirmState,
  storageCleanupListedTotal,
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
});

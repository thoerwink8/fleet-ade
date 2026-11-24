// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { scanCleanedPaths, scanSourceTextForOldTerms } from "./ui-no-old-terms.ts";

describe("ui-no-old-terms", () => {
  it("flags deprecated terms in real JSX copy while ignoring internal tags, data attributes, logs, and comments", () => {
    // Excerpt 1: ComposerPrimaryActions.tsx pattern (JSX text + ternary expression + non-UI data/type/comparison)
    const composerExcerpt = `
      const action = status === "停止生成" ? "停止生成" : "引导当前执行";
      const submitLabel = isQueuing ? "加入队列" : "追加消息";
      return (
        <button
          type="submit"
          data-testid="工作区"
          aria-label={submitLabel}
        >
          {action}
        </button>
      );
    `;
    const composerHits = scanSourceTextForOldTerms("ComposerPrimaryActions.tsx", composerExcerpt);
    expect(composerHits.map((hit) => `${hit.term}:${hit.text}`)).toEqual([
      "停止生成:停止生成",
      "引导当前执行:引导当前执行",
      "加入队列:加入队列",
      "追加消息:追加消息",
    ]);

    // Excerpt 2: SidebarThreadRow.tsx pattern (object literal menu items + data-slot + console.warn)
    const sidebarExcerpt = `
      // 收尾 状态说明
      console.warn("提供方 工作区 检查点");
      const ROW_LABELS = {
        status: "工作区",
        kind: "检查点",
        type: "提供方",
        settle: (
          <div data-slot="拉取请求">
            <span>收尾</span>
            <span>保持唤醒</span>
          </div>
        ),
      };
    `;
    const sidebarHits = scanSourceTextForOldTerms("SidebarThreadRow.tsx", sidebarExcerpt);
    expect(sidebarHits.map((hit) => hit.term)).toEqual(["收尾", "保持唤醒"]);

    // Excerpt 3: BranchToolbarBranchSelector.tsx pattern (toast title + description + cause)
    const branchExcerpt = `
      toastManager.add({
        type: "error",
        title: "无法切换到默认引用",
        description: "工作副本中的改动尚未保存，请先检查。",
        cause: "工作区 初始化失败",
      });
    `;
    const branchHits = scanSourceTextForOldTerms("BranchToolbarBranchSelector.tsx", branchExcerpt);
    expect(branchHits.map((hit) => hit.term)).toEqual(["默认引用", "工作副本"]);

    // Excerpt 4: SettingsPanels.tsx & CommandPalette.tsx pattern (label/placeholder/searchTerms/Forget)
    const settingsExcerpt = `
      const item = {
        id: "worktree",
        searchTerms: ["pull request", "工作区", "forget"],
        title: "创建 pull request",
        label: "provider",
        placeholder: mixed ? "各不相同" : "~/",
      };
      const link = <ActionButton label="Forget this host" description={\`读取 \${name} 的检查点\`} />;
    `;
    const settingsHits = scanSourceTextForOldTerms("SettingsPanels.tsx", settingsExcerpt);
    expect(settingsHits.map((hit) => hit.term)).toEqual([
      "pull request",
      "各不相同",
      "forget",
      "检查点",
    ]);
  });

  it("scans cleaned paths while exempting only the listed sentences", () => {
    const tempRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-old-terms-"));
    try {
      const cleanedFile = NodePath.join(tempRoot, "apps/web/src/components/chat/SampleBanner.tsx");
      NodeFS.mkdirSync(NodePath.dirname(cleanedFile), { recursive: true });
      NodeFS.writeFileSync(cleanedFile, "export const Sample = () => <span>旧工作区</span>;\n");

      const excludedFile = NodePath.join(
        tempRoot,
        "packages/client-runtime/src/state/turnItemPresentation.ts",
      );
      NodeFS.mkdirSync(NodePath.dirname(excludedFile), { recursive: true });
      NodeFS.writeFileSync(
        excludedFile,
        'const WORKSPACE_PREPARATION_INPUT = "正在准备工作区";\nconst other = { label: "新的工作区入口" };\n',
      );

      const hits = scanCleanedPaths(tempRoot);
      expect(hits).toEqual([
        {
          file: "apps/web/src/components/chat/SampleBanner.tsx",
          line: 1,
          term: "工作区",
          text: "旧工作区",
        },
        {
          file: "packages/client-runtime/src/state/turnItemPresentation.ts",
          line: 2,
          term: "工作区",
          text: "新的工作区入口",
        },
      ]);
    } finally {
      NodeFS.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

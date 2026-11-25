import { EnvironmentId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  buildEmptyPathQueryEntries,
  clearRecentComposerPaths,
  collectRecentThreadFilePaths,
  filterRecentPathsMissingFromRoot,
  getRecentComposerPaths,
  rememberRecentComposerPath,
  resolveComposerPathMenuState,
} from "./composerPathSuggestions.logic";

const envA = EnvironmentId.make("env-a");
const envB = EnvironmentId.make("env-b");

beforeEach(() => {
  clearRecentComposerPaths();
});

describe("composerPathSuggestions logic", () => {
  it("remembers recently picked paths in MRU order per workspace and clears via helper", () => {
    rememberRecentComposerPath(envA, "/repo", "src/a.ts");
    rememberRecentComposerPath(envA, "/repo", ".\\docs\\b.md");
    rememberRecentComposerPath(envA, "/repo", "src/a.ts");
    rememberRecentComposerPath(envB, "/repo", "other.ts");

    expect(getRecentComposerPaths(envA, "/repo")).toEqual(["src/a.ts", "docs/b.md"]);
    expect(getRecentComposerPaths(envB, "/repo")).toEqual(["other.ts"]);

    clearRecentComposerPaths();
    expect(getRecentComposerPaths(envA, "/repo")).toEqual([]);
  });

  it("collects recent workspace files across composer picks, open tabs, and closed views", () => {
    const recent = collectRecentThreadFilePaths({
      cwd: "D:/repo",
      recentPicks: ["src/index.ts", "README.md"],
      openSurfaces: [
        { id: "diff", kind: "diff" },
        { id: "file:docs/guide.md", kind: "file", relativePath: "D:\\repo\\docs\\guide.md" },
        { id: "file:src/index.ts", kind: "file", relativePath: "src/index.ts" },
        { id: "file:outside", kind: "file", relativePath: "../secret.txt" },
        { id: "attachment:1", kind: "file", relativePath: "attachment.png" },
      ],
      closedSurfaces: [
        { id: "file:docs/index.ts", kind: "file", relativePath: "./docs/index.ts" },
        { id: "files", kind: "files" },
      ],
    });

    expect(recent).toEqual(["src/index.ts", "README.md", "docs/guide.md", "docs/index.ts"]);
  });

  it("puts recent files before root entries without deduplicating distinct files that share a basename", () => {
    const entries = buildEmptyPathQueryEntries({
      recentFilePaths: ["src/index.ts", "docs/index.ts"],
      rootEntries: [
        { path: "src", kind: "directory" },
        { path: "node_modules", kind: "directory", ignored: true },
        { path: "src/index.ts", kind: "file" },
        { path: "package.json", kind: "file" },
      ],
    });

    expect(entries).toEqual([
      { path: "src/index.ts", kind: "file" },
      { path: "docs/index.ts", kind: "file" },
      { path: "src", kind: "directory" },
      { path: "package.json", kind: "file" },
    ]);
  });
  it("drops recent paths missing from the loaded root listing but keeps survivors", () => {
    expect(
      filterRecentPathsMissingFromRoot({
        recentFilePaths: ["src/index.ts", "gone/deleted.ts", "README.md", "old-root-file.txt"],
        rootEntries: [
          { path: "src", kind: "directory" },
          { path: "README.md", kind: "file" },
          { path: "node_modules", kind: "directory", ignored: true },
        ],
      }),
    ).toEqual(["src/index.ts", "README.md"]);

    expect(
      filterRecentPathsMissingFromRoot({
        recentFilePaths: ["docs/guide.md"],
        rootEntries: [],
      }),
    ).toEqual([]);
  });

  it("shows loading state on empty @ query while pending and never reports no-match during load", () => {
    expect(
      resolveComposerPathMenuState({
        query: "",
        isRootPending: true,
        isSearchPending: false,
      }),
    ).toEqual({
      isLoading: true,
      loadingStateText: "正在加载项目文件…",
      emptyStateText: "当前项目目录下暂无文件。",
      hasError: false,
    });

    expect(
      resolveComposerPathMenuState({
        query: "",
        isRootPending: false,
        isSearchPending: false,
      }),
    ).toEqual({
      isLoading: false,
      loadingStateText: "正在加载项目文件…",
      emptyStateText: "当前项目目录下暂无文件。",
      hasError: false,
    });

    expect(
      resolveComposerPathMenuState({
        query: "foo",
        isRootPending: false,
        isSearchPending: true,
      }),
    ).toEqual({
      isLoading: true,
      loadingStateText: "正在搜索项目文件…",
      emptyStateText: "没有匹配的文件或文件夹。",
      hasError: false,
    });

    expect(
      resolveComposerPathMenuState({
        query: "foo",
        isRootPending: false,
        isSearchPending: false,
      }),
    ).toEqual({
      isLoading: false,
      loadingStateText: "正在搜索项目文件…",
      emptyStateText: "没有匹配的文件或文件夹。",
      hasError: false,
    });
  });

  it("reports read failures as failures instead of an empty or no-match state", () => {
    expect(
      resolveComposerPathMenuState({
        query: "",
        isRootPending: false,
        isSearchPending: false,
        hasRootError: true,
      }),
    ).toEqual({
      isLoading: false,
      loadingStateText: "正在加载项目文件…",
      emptyStateText: "无法读取项目文件。",
      hasError: true,
    });

    expect(
      resolveComposerPathMenuState({
        query: "foo",
        isRootPending: false,
        isSearchPending: false,
        hasSearchError: true,
      }),
    ).toEqual({
      isLoading: false,
      loadingStateText: "正在搜索项目文件…",
      emptyStateText: "无法搜索项目文件。",
      hasError: true,
    });

    expect(
      resolveComposerPathMenuState({
        query: "",
        isRootPending: true,
        isSearchPending: false,
        hasRootError: true,
      }).isLoading,
    ).toBe(true);
  });
});

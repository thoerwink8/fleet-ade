import type { EnvironmentId, ProjectEntry } from "@t3tools/contracts";

import type { RightPanelSurface } from "../../rightPanelStore";

const MAX_RECENT_COMPOSER_PATHS = 12;
const MAX_EMPTY_PATH_SUGGESTION_ENTRIES = 80;

const recentComposerPathsByWorkspace = new Map<string, string[]>();

function workspaceStorageKey(environmentId: EnvironmentId, cwd: string): string {
  return `${environmentId}\0${cwd.replace(/\\/g, "/").replace(/\/+$/u, "")}`;
}

function normalizeRelativeWorkspacePath(rawPath: string, cwd: string | null): string | null {
  let normalized = rawPath.trim().replace(/\\/g, "/");
  if (!normalized) return null;

  if (cwd) {
    const normalizedCwd = cwd.trim().replace(/\\/g, "/").replace(/\/+$/u, "");
    if (normalizedCwd) {
      const lowerPath = normalized.toLowerCase();
      const lowerCwd = normalizedCwd.toLowerCase();
      if (lowerPath === lowerCwd) {
        return null;
      }
      if (lowerPath.startsWith(`${lowerCwd}/`)) {
        normalized = normalized.slice(normalizedCwd.length + 1);
      }
    }
  }

  while (normalized.startsWith("./")) {
    normalized = normalized.slice(2);
  }
  normalized = normalized.replace(/\/+/gu, "/").replace(/\/+$/u, "");

  if (
    !normalized ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:(?:\/|$)/u.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

export function clearRecentComposerPaths(): void {
  recentComposerPathsByWorkspace.clear();
}

export function rememberRecentComposerPath(
  environmentId: EnvironmentId | null,
  cwd: string | null,
  filePath: string,
): void {
  if (!environmentId || !cwd) return;
  const normalized = normalizeRelativeWorkspacePath(filePath, cwd);
  if (!normalized) return;
  const key = workspaceStorageKey(environmentId, cwd);
  const previous = recentComposerPathsByWorkspace.get(key) ?? [];
  const next = [normalized, ...previous.filter((candidate) => candidate !== normalized)].slice(
    0,
    MAX_RECENT_COMPOSER_PATHS,
  );
  recentComposerPathsByWorkspace.set(key, next);
}

export function getRecentComposerPaths(
  environmentId: EnvironmentId | null,
  cwd: string | null,
): ReadonlyArray<string> {
  if (!environmentId || !cwd) return [];
  return [...(recentComposerPathsByWorkspace.get(workspaceStorageKey(environmentId, cwd)) ?? [])];
}

export function collectRecentThreadFilePaths(input: {
  readonly cwd: string | null;
  readonly recentPicks: ReadonlyArray<string>;
  readonly openSurfaces: ReadonlyArray<
    Pick<RightPanelSurface, "id" | "kind"> & { readonly relativePath?: string }
  >;
  readonly closedSurfaces: ReadonlyArray<
    Pick<RightPanelSurface, "id" | "kind"> & { readonly relativePath?: string }
  >;
}): string[] {
  const seen = new Set<string>();
  const collected: string[] = [];

  const pushPath = (rawPath: string | undefined) => {
    if (!rawPath) return;
    const normalized = normalizeRelativeWorkspacePath(rawPath, input.cwd);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    collected.push(normalized);
  };

  for (const picked of input.recentPicks) {
    pushPath(picked);
  }
  for (const surface of input.openSurfaces) {
    if (surface.kind === "file" && !surface.id.startsWith("attachment:")) {
      pushPath(surface.relativePath);
    }
  }
  for (const surface of input.closedSurfaces) {
    if (surface.kind === "file" && !surface.id.startsWith("attachment:")) {
      pushPath(surface.relativePath);
    }
  }
  return collected;
}

export function buildEmptyPathQueryEntries(input: {
  readonly recentFilePaths: ReadonlyArray<string>;
  readonly rootEntries: ReadonlyArray<ProjectEntry>;
  readonly limit?: number | undefined;
}): Array<{ readonly path: string; readonly kind: ProjectEntry["kind"] }> {
  const limit = input.limit ?? MAX_EMPTY_PATH_SUGGESTION_ENTRIES;
  const seen = new Set<string>();
  const combined: Array<{ readonly path: string; readonly kind: ProjectEntry["kind"] }> = [];

  for (const recentPath of input.recentFilePaths) {
    if (seen.has(recentPath)) continue;
    seen.add(recentPath);
    combined.push({ path: recentPath, kind: "file" });
    if (combined.length >= limit) return combined;
  }

  for (const entry of input.rootEntries) {
    if (entry.ignored === true || seen.has(entry.path)) continue;
    seen.add(entry.path);
    combined.push({ path: entry.path, kind: entry.kind });
    if (combined.length >= limit) return combined;
  }

  return combined;
}

export function resolveComposerPathMenuState(input: {
  readonly query: string;
  readonly isRootPending: boolean;
  readonly isSearchPending: boolean;
}): {
  readonly isLoading: boolean;
  readonly loadingStateText: string;
  readonly emptyStateText: string;
} {
  if (input.query.trim().length === 0) {
    return {
      isLoading: input.isRootPending,
      loadingStateText: "正在加载项目文件…",
      emptyStateText: "当前项目目录下暂无文件。",
    };
  }
  return {
    isLoading: input.isSearchPending,
    loadingStateText: "正在搜索项目文件…",
    emptyStateText: "没有匹配的文件或文件夹。",
  };
}

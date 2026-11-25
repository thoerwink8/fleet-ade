import { AuthFilesystemReadScope, EnvironmentId, type AuthSessionState } from "@t3tools/contracts";
import { beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  session: null as Pick<AuthSessionState, "authenticated" | "scopes"> | null,
  sessionError: null as string | null,
  sessionWaiting: false,
  phase: "connected" as "connected" | "offline",
  sessionAtom: {},
  searchAtom: {},
  searchRequests: vi.fn(),
  listAtom: {},
  listRequests: vi.fn(),
  contentAtom: {},
  contentRequests: vi.fn(),
  contentError: null as string | null,
  checkPathsAtom: {},
  checkPathsRequests: vi.fn(),
  metadataEntries: [{ kind: "file" }, null] as Array<{ kind: string } | null>,
  contentData: {
    matches: [{ path: "src/index.ts", lineNumber: 3, lineContent: "a match", matchRanges: [] }],
    truncated: false,
  },
}));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useCallback: <A>(callback: A) => callback,
  useEffect: () => {},
  useMemo: <A>(factory: () => A) => factory(),
  useState: <A>(value: A) => [value, vi.fn()],
}));
vi.mock("./session", () => ({
  environmentSession: { sessionStateAtom: () => state.sessionAtom },
}));
vi.mock("./presentation", () => ({
  useEnvironmentPresentation: () => ({
    isReady: true,
    presentation: { connection: { phase: state.phase, error: null } },
  }),
}));
vi.mock("./projects", () => ({
  projectEnvironment: {
    searchEntries: (target: unknown) => {
      state.searchRequests(target);
      return state.searchAtom;
    },
    listEntries: (target: unknown) => {
      state.listRequests(target);
      return state.listAtom;
    },
  },
  projectContentSearch: (target: unknown) => {
    state.contentRequests(target);
    return state.contentAtom;
  },
}));
vi.mock("./filesystem", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./filesystem")>()),
  filesystemEnvironment: {
    checkPaths: (target: unknown) => {
      state.checkPathsRequests(target);
      return state.checkPathsAtom;
    },
  },
}));
vi.mock("../rpc/atomRegistry", () => ({ appAtomRegistry: {} }));
vi.mock("./orchestration", () => ({ orchestrationEnvironment: {} }));
vi.mock("./threads", () => ({ useEnvironmentThread: vi.fn() }));
vi.mock("./vcs", () => ({ vcsEnvironment: {} }));
vi.mock("./query", () => ({
  useEnvironmentQuery: (atom: unknown) => ({
    data:
      atom === state.sessionAtom
        ? state.session
        : atom === state.searchAtom
          ? { entries: [{ path: "src/index.ts", kind: "file" }] }
          : atom === state.listAtom
            ? { entries: [{ path: "README.md", kind: "file" }], truncated: false }
            : atom === state.checkPathsAtom
              ? { entries: state.metadataEntries }
              : atom === state.contentAtom
                ? state.contentData
                : null,
    error:
      atom === state.sessionAtom
        ? state.sessionError
        : atom === state.contentAtom
          ? state.contentError
          : null,
    isPending:
      atom === state.sessionAtom &&
      (state.sessionWaiting || (state.session === null && state.sessionError === null)),
    isSuccess: atom === state.listAtom || atom === state.searchAtom || atom === state.contentAtom,
    refresh: vi.fn(),
  }),
}));

import {
  useComposerPathSearch,
  useComposerRecentPathExistence,
  useComposerRootEntries,
  useProjectContentSearch,
} from "./queries";

const target = {
  environmentId: EnvironmentId.make("test-environment"),
  cwd: "/repo",
  query: "src",
};

beforeEach(() => {
  state.session = null;
  state.sessionError = null;
  state.sessionWaiting = false;
  state.phase = "connected";
  state.searchRequests.mockClear();
  state.listRequests.mockClear();
  state.contentRequests.mockClear();
  state.checkPathsRequests.mockClear();
  state.metadataEntries = [{ kind: "file" }, null];
  state.contentError = null;
});

const contentTarget = {
  ...target,
  query: " a match ",
  caseSensitive: true,
  wholeWord: true,
  useRegex: false,
};

it.each([
  { query: "src", expected: "src" },
  { query: "a".repeat(256), expected: "a".repeat(256) },
  {
    query: ["a".repeat(86), "b".repeat(86), "c".repeat(86), "unique.ts"].join("/"),
    expected: ["a".repeat(86), "b".repeat(86), "c".repeat(82)].join("/"),
  },
  { query: `${"a".repeat(255)}😀/boundary.ts`, expected: "a".repeat(255) },
  { query: `${"a".repeat(254)}😀/boundary.ts`, expected: `${"a".repeat(254)}😀` },
])(
  "bounds the path search request while preserving query identity: $query",
  ({ query, expected }) => {
    state.session = { authenticated: true, scopes: [AuthFilesystemReadScope] };
    const result = useComposerPathSearch({ ...target, query: ` ${query} ` });

    expect(state.searchRequests).toHaveBeenCalledExactlyOnceWith({
      environmentId: target.environmentId,
      input: { cwd: target.cwd, query: expected, limit: 80 },
    });
    expect(result.searchedTarget).toMatchObject({ ...target, query });
    expect(result.searchedQuery).toBe(query);
    expect(result.isPending).toBe(false);
  },
);

it("explains an overlong content query instead of sending it", () => {
  state.session = { authenticated: true, scopes: [AuthFilesystemReadScope] };
  const result = useProjectContentSearch({ ...contentTarget, query: "a".repeat(257) });

  expect(state.contentRequests).not.toHaveBeenCalled();
  expect(result.matches).toEqual([]);
  expect(result.isPending).toBe(false);
  expect(result.error).toMatch(/256/);
});

it("shows content-search denial before typing and never issues an unauthorized request", () => {
  state.session = { authenticated: true, scopes: [] };
  for (const query of ["", contentTarget.query]) {
    const result = useProjectContentSearch({ ...contentTarget, query });
    expect(state.contentRequests).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      canReadFiles: false,
      isCheckingAccess: false,
      matches: [],
      error: "此连接无法搜索电脑文件。",
      isPending: false,
    });
  }
  expect(state.contentRequests).not.toHaveBeenCalled();
});

it("keeps confirmed content access during revalidation and drops results when it is revoked", () => {
  state.session = { authenticated: true, scopes: [AuthFilesystemReadScope] };
  state.sessionWaiting = true;
  expect(useProjectContentSearch(contentTarget)).toMatchObject({
    matches: state.contentData.matches,
    isPending: false,
  });

  state.contentRequests.mockClear();
  state.sessionWaiting = false;
  state.session = { authenticated: true, scopes: [] };
  const result = useProjectContentSearch(contentTarget);
  expect(state.contentRequests).not.toHaveBeenCalled();
  expect(result).toMatchObject({
    canReadFiles: false,
    matches: [],
    error: "此连接无法搜索电脑文件。",
    isPending: false,
  });
  expect(state.contentRequests).not.toHaveBeenCalled();
});

it("fails closed after a session check fails, even with a cached grant and matches", () => {
  state.session = { authenticated: true, scopes: [AuthFilesystemReadScope] };
  state.sessionError = "The session has expired.";
  const result = useProjectContentSearch(contentTarget);
  expect(state.contentRequests).not.toHaveBeenCalled();
  expect(result).toMatchObject({
    canReadFiles: false,
    matches: [],
    error: state.sessionError,
    isPending: false,
  });
  expect(state.contentRequests).not.toHaveBeenCalled();
});

it("lists project root entries for bare @ when enabled and permitted, and skips otherwise", () => {
  state.session = { authenticated: true, scopes: [AuthFilesystemReadScope] };
  const enabledResult = useComposerRootEntries({
    environmentId: target.environmentId,
    cwd: target.cwd,
    enabled: true,
  });
  expect(state.listRequests).toHaveBeenCalledExactlyOnceWith({
    environmentId: target.environmentId,
    input: { cwd: target.cwd, directoryPath: "" },
  });
  expect(enabledResult.entries).toEqual([{ path: "README.md", kind: "file" }]);
  expect(enabledResult.isPending).toBe(false);

  state.listRequests.mockClear();
  const disabledResult = useComposerRootEntries({
    environmentId: target.environmentId,
    cwd: target.cwd,
    enabled: false,
  });
  expect(state.listRequests).not.toHaveBeenCalled();
  expect(disabledResult.entries).toEqual([]);

  state.session = { authenticated: true, scopes: [] };
  const deniedResult = useComposerRootEntries({
    environmentId: target.environmentId,
    cwd: target.cwd,
    enabled: true,
  });
  expect(state.listRequests).not.toHaveBeenCalled();
  expect(deniedResult.entries).toEqual([]);
});

it("checks remembered @ paths in one batched metadata request", () => {
  state.session = { authenticated: true, scopes: [AuthFilesystemReadScope] };
  const result = useComposerRecentPathExistence({
    environmentId: target.environmentId,
    cwd: target.cwd,
    paths: ["src/index.ts", "src/deleted.ts"],
  });

  expect(state.checkPathsRequests).toHaveBeenCalledExactlyOnceWith({
    environmentId: target.environmentId,
    input: { paths: ["/repo/src/index.ts", "/repo/src/deleted.ts"] },
  });
  expect(result.checkedPaths).toEqual(["src/index.ts", "src/deleted.ts"]);
  expect(result.entries).toEqual([{ kind: "file" }, null]);
});

it("bounds the batched path check and skips it without read access or paths", () => {
  state.session = { authenticated: true, scopes: [AuthFilesystemReadScope] };
  const manyPaths = Array.from({ length: 70 }, (_, index) => `src/file-${index}.ts`);
  const capped = useComposerRecentPathExistence({
    environmentId: target.environmentId,
    cwd: target.cwd,
    paths: manyPaths,
  });
  expect(capped.checkedPaths).toHaveLength(64);
  expect(state.checkPathsRequests).toHaveBeenCalledExactlyOnceWith({
    environmentId: target.environmentId,
    input: { paths: manyPaths.slice(0, 64).map((path) => `/repo/${path}`) },
  });

  state.checkPathsRequests.mockClear();
  const empty = useComposerRecentPathExistence({
    environmentId: target.environmentId,
    cwd: target.cwd,
    paths: [],
  });
  expect(empty.entries).toBeNull();

  state.session = { authenticated: true, scopes: [] };
  const denied = useComposerRecentPathExistence({
    environmentId: target.environmentId,
    cwd: target.cwd,
    paths: ["src/index.ts"],
  });
  expect(denied.entries).toBeNull();
  expect(state.checkPathsRequests).not.toHaveBeenCalled();
});

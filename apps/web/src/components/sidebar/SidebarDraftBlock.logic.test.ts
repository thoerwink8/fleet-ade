import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  ComposerContextId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { formatAssistantCitationForComposer } from "../../composer-logic";
import {
  DraftId,
  type ComposerThreadDraftState,
  type DraftSessionState,
} from "../../composerDraftStore";
import {
  countDraftAttachments,
  resolveDraftRowPresentation,
  selectVisibleDraftRows,
} from "./SidebarDraftBlock.logic";

const environmentId = EnvironmentId.make("env-1");
const projectId = ProjectId.make("project-1");

function makeComposer(overrides: Partial<ComposerThreadDraftState> = {}): ComposerThreadDraftState {
  return {
    prompt: "",
    images: [],
    files: [],
    nonPersistedImageIds: [],
    persistedAttachments: [],
    terminalContexts: [],
    previewAnnotations: [],
    reviewComments: [],
    threadContexts: [],
    environmentContexts: [],
    replyTo: null,
    modelSelectionByProvider: {},
    activeProvider: null,
    runtimeMode: null,
    interactionMode: null,
    ...overrides,
  };
}

function makeSession(overrides: Partial<DraftSessionState> = {}): DraftSessionState {
  return {
    threadId: ThreadId.make("thread-draft"),
    environmentId,
    projectId,
    logicalProjectKey: `${environmentId}:${projectId}`,
    createdAt: "2026-11-24T10:00:00.000Z",
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    envMode: "local",
    startFromOrigin: false,
    ...overrides,
  };
}

describe("resolveDraftRowPresentation", () => {
  it("expands citations and context references into the single-line title and details body", () => {
    const quote = "Keep one shared row shell.";
    const citation = formatAssistantCitationForComposer({
      version: 1,
      environmentId,
      threadId: ThreadId.make("source-thread"),
      messageId: MessageId.make("source-message"),
      text: quote,
      start: 0,
      end: quote.length,
      prefix: "",
      suffix: "",
    });
    const presentation = resolveDraftRowPresentation({
      composer: makeComposer({
        prompt: `${citation}First line\nSecond line`,
      }),
      session: makeSession({ branch: "feat/sidebar-tail" }),
      projectDisplayName: "fleet-ade",
      isActive: true,
    });

    expect(presentation.title).toBe(`${quote} First line`);
    expect(presentation.detailBody).toBe(`${quote} First line\nSecond line`);
    expect(presentation.badgeLabel).toBe("草稿");
    expect(presentation.statusLabel).toBe("未发送的草稿");
    expect(presentation.branch).toBe("feat/sidebar-tail");
    expect(presentation.projectDisplayName).toBe("fleet-ade");
    expect(presentation.accessibility).toEqual({
      label: `${quote} First line, 未发送的草稿, fleet-ade`,
      current: "page",
    });
  });

  it("derives non-empty fallback titles for attachment-only and context-only drafts", () => {
    const fileImage = new File(["img"], "shot.png", { type: "image/png" });
    const attachmentOnly = resolveDraftRowPresentation({
      composer: makeComposer({
        images: [
          {
            type: "image",
            id: "img-1",
            name: "shot.png",
            mimeType: "image/png",
            sizeBytes: 3,
            file: fileImage,
            previewUrl: "blob:test-1",
          },
        ],
        persistedAttachments: [
          {
            id: "img-1",
            name: "shot.png",
            mimeType: "image/png",
            sizeBytes: 3,
            dataUrl: "data:image/png;base64,aQ==",
          },
          {
            id: "img-2",
            name: "shot-2.png",
            mimeType: "image/png",
            sizeBytes: 3,
            dataUrl: "data:image/png;base64,aQ==",
          },
        ],
        files: [
          {
            type: "file",
            id: "file-1",
            name: "notes.md",
            mimeType: "text/markdown",
            sizeBytes: 10,
            file: null,
          },
        ],
        terminalContexts: [
          {
            id: "term-1",
            threadId: ThreadId.make("t-1"),
            createdAt: "2026-11-24T10:00:00.000Z",
            terminalId: "term",
            terminalLabel: "bash",
            lineStart: 1,
            lineEnd: 3,
            text: "echo hi",
          },
        ],
      }),
      session: makeSession(),
      projectDisplayName: null,
      isActive: false,
    });

    expect(
      countDraftAttachments(
        makeComposer({
          images: [
            {
              type: "image",
              id: "img-1",
              name: "shot.png",
              mimeType: "image/png",
              sizeBytes: 3,
              file: fileImage,
              previewUrl: "blob:test-1",
            },
          ],
          persistedAttachments: [
            {
              id: "img-1",
              name: "shot.png",
              mimeType: "image/png",
              sizeBytes: 3,
              dataUrl: "data:image/png;base64,aQ==",
            },
            {
              id: "img-2",
              name: "shot-2.png",
              mimeType: "image/png",
              sizeBytes: 3,
              dataUrl: "data:image/png;base64,aQ==",
            },
          ],
        }),
      ),
    ).toBe(2);
    expect(attachmentOnly.title).toBe("4 个附件");
    expect(attachmentOnly.attachmentSummary).toBeNull();
    expect(attachmentOnly.accessibility.current).toBeUndefined();

    const promptWithAttachments = resolveDraftRowPresentation({
      composer: makeComposer({
        prompt: "检查这张截图",
        files: [
          {
            type: "file",
            id: "file-1",
            name: "notes.md",
            mimeType: "text/markdown",
            sizeBytes: 10,
            file: null,
          },
        ],
        threadContexts: [
          {
            version: 1,
            contextId: ComposerContextId.make("ctx-1"),
            label: "关联会话",
            kind: "thread",
            environmentId,
            threadId: ThreadId.make("t-1"),
            title: "关联会话",
          },
        ],
      }),
      session: makeSession(),
      projectDisplayName: "fleet-ade",
      isActive: false,
    });
    expect(promptWithAttachments.title).toBe("检查这张截图");
    expect(promptWithAttachments.attachmentSummary).toBe("1 个附件");
    expect(promptWithAttachments.contextSummary).toBe("1 条引用上下文");

    const contextOnly = resolveDraftRowPresentation({
      composer: makeComposer({
        threadContexts: [
          {
            version: 1,
            contextId: ComposerContextId.make("ctx-2"),
            label: "关联会话",
            kind: "thread",
            environmentId,
            threadId: ThreadId.make("t-1"),
            title: "关联会话",
          },
        ],
      }),
      session: makeSession(),
      projectDisplayName: null,
      isActive: false,
    });
    expect(contextOnly.title).toBe("1 条引用上下文");
  });
});

describe("selectVisibleDraftRows", () => {
  it("keeps distinct drafts in the same project even with identical titles and orders newest first", () => {
    const projectRef = scopeProjectRef(environmentId, projectId);
    const key = `${projectRef.environmentId}:${projectRef.projectId}`;
    const olderId = DraftId.make("draft-older");
    const newerId = DraftId.make("draft-newer");
    const attachmentOnlyId = DraftId.make("draft-attachment");

    const rows = selectVisibleDraftRows({
      draftThreadsByThreadKey: {
        [olderId]: makeSession({
          threadId: ThreadId.make("t-old"),
          createdAt: "2026-11-24T08:00:00.000Z",
        }),
        [newerId]: makeSession({
          threadId: ThreadId.make("t-new"),
          createdAt: "2026-11-24T09:00:00.000Z",
        }),
        [attachmentOnlyId]: makeSession({
          threadId: ThreadId.make("t-attach"),
          createdAt: "2026-11-24T07:00:00.000Z",
        }),
      },
      draftsByThreadKey: {
        [olderId]: makeComposer({ prompt: "重复标题的草稿" }),
        [newerId]: makeComposer({ prompt: "重复标题的草稿" }),
        [attachmentOnlyId]: makeComposer({
          files: [
            {
              type: "file",
              id: "f-1",
              name: "a.txt",
              mimeType: "text/plain",
              sizeBytes: 1,
              file: null,
            },
          ],
        }),
      },
      scopedProjectKeys: new Set([key]),
      routeDraftId: null,
      frozenActive: { routeDraftId: null, row: null },
    });

    expect(rows.map((row) => row.draftId)).toEqual([newerId, olderId, attachmentOnlyId]);
    for (const row of rows) {
      expect(
        resolveDraftRowPresentation({
          composer: row.composer,
          session: row.session,
          projectDisplayName: "fleet-ade",
          isActive: false,
        }).title.length,
      ).toBeGreaterThan(0);
    }
  });
});

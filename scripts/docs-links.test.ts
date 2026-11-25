// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import {
  extractMarkdownAnchors,
  extractMarkdownLinks,
  scanDocsLinks,
  scanSourceTextForDocLinks,
  slugifyHeading,
} from "./docs-links.ts";

describe("docs-links", () => {
  it("generates GitHub-compatible anchors for English, Chinese, inline-code, and duplicate headings", () => {
    expect(slugifyHeading("Can I add a bunch of accounts for one provider?")).toBe(
      "can-i-add-a-bunch-of-accounts-for-one-provider",
    );
    expect(slugifyHeading('"Wait, what are you selling me?"')).toBe("wait-what-are-you-selling-me");
    expect(slugifyHeading("Reuse `Effect.fn(...)` Where It Already Exists")).toBe(
      "reuse-effectfn-where-it-already-exists",
    );
    expect(slugifyHeading("`t3_thread_launch`")).toBe("t3_thread_launch");
    expect(slugifyHeading("`_kept_underscores_` and _italics_")).toBe(
      "_kept_underscores_-and-italics",
    );
    expect(slugifyHeading("Ask Questions / User Input")).toBe("ask-questions--user-input");
    expect(slugifyHeading("本仓运行方式")).toBe("本仓运行方式");
    expect(slugifyHeading("16 组用词对照表")).toBe("16-组用词对照表");
    expect(slugifyHeading("4.1 GitHub App 凭据（`ade` 推 PR 用）")).toBe(
      "41-github-app-凭据ade-推-pr-用",
    );
    expect(slugifyHeading("关二：离得开它家")).toBe("关二离得开它家");
    expect(slugifyHeading("核对① 进程链")).toBe("核对①-进程链");

    const markdown = [
      "# Guide",
      "## Setup",
      "### Setup",
      "### Setup 1",
      "### Setup",
      "```markdown",
      "## Fake Heading Inside Fence",
      "```",
    ].join("\n");
    expect([...extractMarkdownAnchors(markdown)]).toEqual([
      "guide",
      "setup",
      "setup-1",
      "setup-1-1",
      "setup-2",
    ]);
  });

  it("extracts real markdown, multiline, reference, and HTML links while ignoring code blocks and inline code", () => {
    const excerpt = [
      "See [FAQ](./user/faq.md#can-i-add-a-bunch-of-accounts-for-one-provider) and [the `t3` command](./install.md#the-t3-command).",
      "Check [every RPC declares a required",
      "scope](../../apps/server/src/auth/RpcAuthorization.ts) or [legacy].",
      '<a href="./docs/README.md">Docs</a>',
      "Inline fake `[broken](./missing.md#nope)` and `` `[broken2](./missing2.md)` `` stay ignored.",
      "",
      "```md",
      "See [fenced-broken](./missing-in-fence.md#bad)",
      "```",
      "",
      "~~~markdown",
      "See [tilde-broken](./missing-in-tilde.md#bad)",
      "~~~",
      "",
      "[legacy]: ../../packages/shared/src/composerContextLegacy.ts",
    ].join("\n");

    expect(extractMarkdownLinks(excerpt)).toEqual([
      { line: 1, target: "./user/faq.md#can-i-add-a-bunch-of-accounts-for-one-provider" },
      { line: 1, target: "./install.md#the-t3-command" },
      { line: 2, target: "../../apps/server/src/auth/RpcAuthorization.ts" },
      { line: 4, target: "./docs/README.md" },
      { line: 15, target: "../../packages/shared/src/composerContextLegacy.ts" },
    ]);
  });

  it("extracts repo docs links from TypeScript/TSX strings while ignoring comments and external URLs", () => {
    const sourceExcerpt = `
      // Ignore comment link docs/user/missing.md#bad
      const MULTIPLE_ACCOUNTS_FAQ_URL =
        "https://github.com/thoerwink8/fleet-ade/blob/main/docs/user/faq.md#can-i-add-a-bunch-of-accounts-for-one-provider";
      const externalDocs = "https://platform.openai.com/docs/guides/reasoning#reasoning-summaries";
      const externalMd = "https://example.com/docs/user/external.md#nope";
      const localDoc = "docs/user/install.md#providers";
      const dynamicAnchor = \`docs/user/faq.md#\${anchorName}\`;
    `;

    expect(scanSourceTextForDocLinks("MultipleAccountsNote.tsx", sourceExcerpt)).toEqual([
      {
        line: 4,
        link: "https://github.com/thoerwink8/fleet-ade/blob/main/docs/user/faq.md#can-i-add-a-bunch-of-accounts-for-one-provider",
        target: "docs/user/faq.md",
        anchor: "can-i-add-a-bunch-of-accounts-for-one-provider",
      },
      {
        line: 7,
        link: "docs/user/install.md#providers",
        target: "docs/user/install.md",
        anchor: "providers",
      },
      {
        line: 8,
        link: "docs/user/faq.md",
        target: "docs/user/faq.md",
      },
    ]);
  });

  it("reports missing files, missing anchors, and case mismatches while passing valid links and code examples", () => {
    const tempRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-docs-links-"));
    const write = (relPath: string, content: string) => {
      const fullPath = NodePath.join(tempRoot, relPath);
      NodeFS.mkdirSync(NodePath.dirname(fullPath), { recursive: true });
      NodeFS.writeFileSync(fullPath, content, "utf8");
    };

    try {
      write(
        "README.md",
        [
          "# Fleet ADE",
          "",
          "- [FAQ](./docs/user/faq.md#can-i-add-a-bunch-of-accounts-for-one-provider)",
          "- [Chinese](./docs/user/guide.md#使用说明)",
          "- [Second Setup](./docs/user/guide.md#setup-1)",
          "- [External](https://example.com/docs/missing.md#bad)",
          "- Inline `[fake](./docs/missing.md#nope)`",
          "- [Broken File](./docs/user/does-not-exist.md)",
          "- [Case Mismatch](./docs/user/FAQ.md)",
        ].join("\n"),
      );

      write(
        "docs/user/faq.md",
        [
          "# FAQ",
          "",
          "## Can I add a bunch of accounts for one provider?",
          "",
          "Use [the guide](./guide.md#使用说明) or [this section](#can-i-add-a-bunch-of-accounts-for-one-provider).",
          "Bad self anchor: [nope](#missing-self-heading).",
          "",
          "```md",
          "[fenced](./does-not-exist.md#bad)",
          "```",
        ].join("\n"),
      );

      write(
        "docs/user/guide.md",
        ["# Guide", "", "## 使用说明", "", "## Setup", "", "## Setup"].join("\n"),
      );

      write(
        "apps/web/src/components/settings/MultipleAccountsNote.tsx",
        [
          'const GOOD = "https://github.com/thoerwink8/fleet-ade/blob/main/docs/user/faq.md#can-i-add-a-bunch-of-accounts-for-one-provider";',
          'const BAD_ANCHOR = "https://github.com/thoerwink8/fleet-ade/blob/main/docs/user/faq.md#old-removed-heading";',
          'const BAD_FILE = "docs/user/removed.md#sec";',
          "export const urls = [GOOD, BAD_ANCHOR, BAD_FILE];",
        ].join("\n"),
      );

      write(
        "packages/source-control-github/src/server/gitHubChangeRequestTemplate.ts",
        [
          'export const templates = ["docs/pull_request_template.md"];',
          'export const brokenDoc = "docs/user/actually-missing.md";',
        ].join("\n"),
      );

      expect(scanDocsLinks(tempRoot)).toEqual([
        {
          file: "README.md",
          line: 8,
          kind: "missing-file",
          link: "./docs/user/does-not-exist.md",
          target: "docs/user/does-not-exist.md",
        },
        {
          file: "README.md",
          line: 9,
          kind: "missing-file",
          link: "./docs/user/FAQ.md",
          target: "docs/user/FAQ.md",
        },
        {
          file: "apps/web/src/components/settings/MultipleAccountsNote.tsx",
          line: 2,
          kind: "missing-anchor",
          link: "https://github.com/thoerwink8/fleet-ade/blob/main/docs/user/faq.md#old-removed-heading",
          target: "docs/user/faq.md",
          anchor: "old-removed-heading",
        },
        {
          file: "apps/web/src/components/settings/MultipleAccountsNote.tsx",
          line: 3,
          kind: "missing-file",
          link: "docs/user/removed.md#sec",
          target: "docs/user/removed.md",
        },
        {
          file: "docs/user/faq.md",
          line: 6,
          kind: "missing-anchor",
          link: "#missing-self-heading",
          target: "docs/user/faq.md",
          anchor: "missing-self-heading",
        },
        {
          file: "packages/source-control-github/src/server/gitHubChangeRequestTemplate.ts",
          line: 2,
          kind: "missing-file",
          link: "docs/user/actually-missing.md",
          target: "docs/user/actually-missing.md",
        },
      ]);
    } finally {
      NodeFS.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import {
  CHAT_MARKDOWN_REHYPE_PLUGINS,
  CHAT_MARKDOWN_REMARK_PLUGINS,
} from "@t3tools/shared/markdownPipeline";
import { formatThreadLink, parseThreadLinkHref } from "@t3tools/shared/threadLinks";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { createMarkdownRenderer } from "./markdownRenderer";

// A wake message as Orchestrator.delegatedCompletionWakeDetail writes it: each finished
// subagent's thread is a formatThreadLink in parentheses after its task id, its result inline.
const wakeText = [
  `Delegated task node:parser (${formatThreadLink({ environmentId: EnvironmentId.make("environment"), threadId: ThreadId.make("thread-parser") }, "Fix [the] (parser) `crash`")}) [completed]:`,
  "The crash came from an empty token stream.",
  "",
  `Delegated task node:cart (${formatThreadLink({ environmentId: EnvironmentId.make("environment"), threadId: ThreadId.make("thread-cart") })}) [failed]. Use task_status with taskId node:cart to read the result.`,
].join("\n");

describe("delegated completion wake links through the chat markdown pipeline", () => {
  const render = createMarkdownRenderer({
    remarkPlugins: CHAT_MARKDOWN_REMARK_PLUGINS,
    rehypePlugins: CHAT_MARKDOWN_REHYPE_PLUGINS,
    components: {},
    urlTransform: (url: string) => url,
  });

  it("parses every thread link in a wake message as a link element, not text", () => {
    const markup = renderToStaticMarkup(render(wakeText, true));
    // A labeled link's visible text is its label, never the raw href.
    expect(markup).not.toContain(">t3-thread://v2/environment/thread-parser<");
    const anchors = [...markup.matchAll(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
    expect(anchors.length).toBe(2);
    const [labeled, autolink] = anchors;
    expect(parseThreadLinkHref(labeled![1]!)).toEqual({
      environmentId: EnvironmentId.make("environment"),
      threadId: ThreadId.make("thread-parser"),
    });
    // Brackets and backslashes left the label; parens stay, and a backtick pair typesets code.
    expect(labeled![2]).toBe("Fix the (parser) <code>crash</code>");
    expect(parseThreadLinkHref(autolink![1]!)).toEqual({
      environmentId: EnvironmentId.make("environment"),
      threadId: ThreadId.make("thread-cart"),
    });
  });

  it("matches what plain react-markdown renders for the same wake", () => {
    expect(renderToStaticMarkup(render(wakeText, true))).toBe(
      renderToStaticMarkup(
        <ReactMarkdown
          remarkPlugins={CHAT_MARKDOWN_REMARK_PLUGINS}
          rehypePlugins={CHAT_MARKDOWN_REHYPE_PLUGINS}
          urlTransform={(url: string) => url}
        >
          {wakeText}
        </ReactMarkdown>,
      ),
    );
  });
});

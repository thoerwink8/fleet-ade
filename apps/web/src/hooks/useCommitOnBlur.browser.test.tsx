import { describe, expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { resolvePastedPath } from "@t3tools/shared/path";

import { render } from "../../test/render";
import { parseSessionLimitDraft } from "../components/settings/SettingsPanels.logic";
import { DraftInput } from "../components/ui/draft-input";

describe("settings draft commits", () => {
  it("preserves an external update when an untouched field loses focus", async () => {
    let saved = "~/";
    const commit = (next: string) => {
      saved = next;
    };
    await using screen = await render(<DraftInput value={saved} onCommit={commit} />);
    const input = screen.getByRole("textbox");
    await input.click();

    saved = "/projects";
    await screen.rerender(<DraftInput value={saved} onCommit={commit} />);
    await userEvent.tab();

    expect(saved).toBe("/projects");
  });

  it("preserves a saved edit when refocused before its server snapshot arrives", async () => {
    let saved = "~/";
    const commit = (next: string) => {
      saved = next;
    };
    await using screen = await render(<DraftInput value="~/" onCommit={commit} />);
    const input = screen.getByRole("textbox");
    await input.fill("/projects");
    await userEvent.tab();
    expect(saved).toBe("/projects");

    await input.click();
    await screen.rerender(<DraftInput value={saved} onCommit={commit} />);
    await userEvent.tab();

    expect(saved).toBe("/projects");
  });

  it("normalizes each change against the draft before it", async () => {
    let saved = "/mnt/old/";
    const commit = (next: string) => {
      saved = next;
    };
    await using screen = await render(
      <DraftInput value={saved} onCommit={commit} normalizeDraft={resolvePastedPath} />,
    );
    const input = screen.getByRole("textbox");
    await input.fill("/mnt/old//mnt/new");
    await userEvent.tab();
    expect(saved).toBe("/mnt/new");

    await input.fill("");
    await userEvent.type(input, "/tmp/a\\ b");
    await userEvent.tab();
    expect(saved).toBe("/tmp/a\\ b");
  });

  it.each(["abc", "e", "0", "-2", "1.5"])(
    "keeps a saved session limit when %s is typed",
    async (invalidDraft) => {
      let saved: number | null = 2;
      await using screen = await render(
        <DraftInput
          type="text"
          inputMode="numeric"
          value={String(saved)}
          onCommit={(next) => {
            const parsed = parseSessionLimitDraft(next);
            if (parsed !== undefined) saved = parsed;
          }}
        />,
      );
      const input = screen.getByRole("textbox");
      await userEvent.clear(input);
      await userEvent.type(input, invalidDraft);
      await userEvent.tab();

      expect(saved).toBe(2);
      await expect.element(input).toHaveValue("2");
    },
  );

  it("keeps a saved session limit when abc replaces the selected value", async () => {
    let saved: number | null = 2;
    await using screen = await render(
      <DraftInput
        type="text"
        inputMode="numeric"
        value={String(saved)}
        onCommit={(next) => {
          const parsed = parseSessionLimitDraft(next);
          if (parsed !== undefined) saved = parsed;
        }}
      />,
    );
    const input = screen.getByRole("textbox");
    await input.click();
    await userEvent.keyboard("{Control>}a{/Control}");
    await userEvent.type(input, "abc");
    await userEvent.tab();
    expect(saved).toBe(2);
    await expect.element(input).toHaveValue("2");
  });

  it.each([
    ["", null],
    ["3", 3],
  ] as const)("commits session limit %s as %s", async (draft, expected) => {
    let saved: number | null = 2;
    await using screen = await render(
      <DraftInput
        type="text"
        inputMode="numeric"
        value={String(saved)}
        onCommit={(next) => {
          const parsed = parseSessionLimitDraft(next);
          if (parsed !== undefined) saved = parsed;
        }}
      />,
    );
    const input = screen.getByRole("textbox");
    await input.fill(draft);
    await userEvent.tab();
    expect(saved).toBe(expected);
  });
});

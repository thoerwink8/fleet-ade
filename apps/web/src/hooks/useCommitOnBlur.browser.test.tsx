import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { resolvePastedPath } from "@t3tools/shared/path";

import { act, render } from "../../test/render";
import { parseSessionLimitDraft } from "../components/settings/SettingsPanels.logic";
import { DraftInput } from "../components/ui/draft-input";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

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
    "keeps the typed session limit visible when %s is rejected as invalid",
    async (invalidDraft) => {
      let saved: number | null = 2;
      await using screen = await render(
        <DraftInput
          type="text"
          inputMode="numeric"
          value={String(saved)}
          onCommit={(next) => {
            const parsed = parseSessionLimitDraft(next);
            if (parsed === undefined) return false;
            saved = parsed;
          }}
        />,
      );
      const input = screen.getByRole("textbox");
      await userEvent.clear(input);
      await userEvent.type(input, invalidDraft);
      await userEvent.tab();

      expect(saved).toBe(2);
      await expect.element(input).toHaveValue(invalidDraft);
      await expect.element(input).toHaveAttribute("aria-invalid", "true");
    },
  );

  it("saves a corrected value after an invalid draft was rejected", async () => {
    let saved: number | null = 2;
    await using screen = await render(
      <DraftInput
        type="text"
        inputMode="numeric"
        value={String(saved)}
        onCommit={(next) => {
          const parsed = parseSessionLimitDraft(next);
          if (parsed === undefined) return false;
          saved = parsed;
        }}
      />,
    );
    const input = screen.getByRole("textbox");
    await userEvent.clear(input);
    await userEvent.type(input, "abc");
    await userEvent.tab();
    await expect.element(input).toHaveValue("abc");

    await input.click();
    await userEvent.clear(input);
    await userEvent.type(input, "4");
    await userEvent.tab();

    expect(saved).toBe(4);
  });

  it("keeps the typed text when the asynchronous save fails and clears it once it saves", async () => {
    const saves: string[] = [];
    let outcome = deferred<boolean>();
    const commit = vi.fn((next: string) => {
      saves.push(next);
      return outcome.promise;
    });
    await using screen = await render(<DraftInput value="~" onCommit={commit} />);
    const input = screen.getByRole("textbox");
    await input.fill("/projects");
    await userEvent.tab();
    expect(commit).toHaveBeenCalledTimes(1);

    outcome.resolve(false);
    await expect.element(input).toHaveValue("/projects");
    await expect.element(input).toHaveAttribute("aria-invalid", "true");

    outcome = deferred<boolean>();
    await input.click();
    await input.fill("/fixed");
    await userEvent.tab();
    outcome.resolve(true);
    await expect.element(input).not.toHaveAttribute("aria-invalid", "true");
    expect(saves).toEqual(["/projects", "/fixed"]);
  });

  it("ignores duplicate blurs of one edit, retrying only after a refocus", async () => {
    const outcome = deferred<boolean>();
    const commit = vi.fn(() => outcome.promise);
    await using screen = await render(<DraftInput value="~" onCommit={commit} />);
    const input = screen.getByRole("textbox");
    const blurAgain = () =>
      act(async () => {
        screen.container
          .querySelector("input")!
          .dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      });
    await input.fill("/projects");
    await userEvent.tab();
    expect(commit).toHaveBeenCalledTimes(1);

    // Disabling a focused input can deliver a second focusout for the same edit.
    await blurAgain();
    expect(commit).toHaveBeenCalledTimes(1);

    outcome.resolve(false);
    await expect.element(input).toHaveAttribute("aria-invalid", "true");
    await blurAgain();
    expect(commit).toHaveBeenCalledTimes(1);

    await input.click();
    await userEvent.tab();
    expect(commit).toHaveBeenCalledTimes(2);
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
          if (parsed === undefined) return false;
          saved = parsed;
        }}
      />,
    );
    const input = screen.getByRole("textbox");
    await input.fill(draft);
    await userEvent.tab();
    expect(saved).toBe(expected);
  });

  it("keeps a newer edit unsaved when an earlier save settles", async () => {
    let saved = "~";
    let outcome = deferred<boolean>();
    const commit = (next: string) => {
      saved = next;
      return outcome.promise;
    };
    await using screen = await render(<DraftInput value="~" onCommit={commit} />);
    const input = screen.getByRole("textbox");
    await input.fill("/first");
    await userEvent.tab();

    await input.click();
    await input.fill("/second");
    outcome.resolve(true);
    await expect.element(input).toHaveValue("/second");
    expect(saved).toBe("/first");

    outcome = deferred<boolean>();
    await userEvent.tab();
    outcome.resolve(true);
    await expect.element(input).toHaveValue("/second");
    expect(saved).toBe("/second");
  });
});

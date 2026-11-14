import { fakeTimers, render } from "../../../test/render";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { useInlineActionConfirm } from "./useInlineActionConfirm";

function MergeButton({ scopeKey, onConfirm }: { scopeKey: string; onConfirm: () => void }) {
  const confirm = useInlineActionConfirm(scopeKey);
  return (
    <button type="button" {...confirm.props("merge", onConfirm)}>
      {confirm.isArmed("merge") ? "确认合并？" : "合并"}
    </button>
  );
}

function pressEscape(): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  window.dispatchEvent(event);
  return event;
}

it("confirms on the second click and disarms on Escape", async () => {
  const onConfirm = vi.fn();
  await using screen = await render(<MergeButton scopeKey="a" onConfirm={onConfirm} />);
  // An armed action disarms after 3s, and a slow runner can take longer between two clicks.
  using _timers = fakeTimers();
  const button = screen.getByRole("button");

  await userEvent.click(button);
  await expect.element(button).toHaveTextContent("确认合并？");
  expect(pressEscape().defaultPrevented).toBe(true);
  await expect.element(button).toHaveTextContent("合并");

  await userEvent.click(button);
  await userEvent.click(button);
  expect(onConfirm).toHaveBeenCalledTimes(1);
  await expect.element(button).toHaveTextContent("合并");
});

it("stops swallowing Escape once the scope changes", async () => {
  const onConfirm = vi.fn();
  await using screen = await render(<MergeButton scopeKey="a" onConfirm={onConfirm} />);
  const button = screen.getByRole("button");

  await userEvent.click(button);
  await expect.element(button).toHaveTextContent("确认合并？");
  await screen.rerender(<MergeButton scopeKey="b" onConfirm={onConfirm} />);
  await expect.element(button).toHaveTextContent("合并");
  expect(pressEscape().defaultPrevented).toBe(false);

  await screen.rerender(<MergeButton scopeKey="a" onConfirm={onConfirm} />);
  await expect.element(button).toHaveTextContent("合并");
});

// The hook's owner stays mounted while the armed button goes away, as when the primary
// action changes under an armed merge button.
function ToolbarWithMergeButton({ shown }: { shown: boolean }) {
  const confirm = useInlineActionConfirm("a");
  return shown ? (
    <button type="button" {...confirm.props("merge", () => undefined)}>
      {confirm.isArmed("merge") ? "确认合并？" : "合并"}
    </button>
  ) : (
    <span>gone</span>
  );
}

it("stops swallowing Escape once the armed button unmounts", async () => {
  await using screen = await render(<ToolbarWithMergeButton shown />);
  const button = screen.getByRole("button");

  await userEvent.click(button);
  await expect.element(button).toHaveTextContent("确认合并？");
  await screen.rerender(<ToolbarWithMergeButton shown={false} />);
  await expect.element(screen.getByText("gone")).toBeVisible();
  expect(pressEscape().defaultPrevented).toBe(false);

  await screen.rerender(<ToolbarWithMergeButton shown />);
  await expect.element(screen.getByRole("button")).toHaveTextContent("合并");
});

async function keepsBlockedAction(primaryAction: "merge" | "enable-auto-merge") {
  const perform = vi.fn(async () => true);
  const { PullRequestPrimaryAction } = await import("./PullRequestDetailActions");
  const control = (mergeBlockedReason: string | null) => (
    <PullRequestPrimaryAction
      pullRequestKey="owner/repo/7"
      primaryAction={primaryAction}
      mergeBlockedReason={mergeBlockedReason}
      autoMergeArmed={false}
      armedAutoMergeLabel="已开启自动合并"
      pendingAutoMergeLabel="Auto-merge (squash)"
      selectedMergeMethod="squash"
      selectedMergeMethodLabel="压缩并合并"
      statePresentation={null}
      pendingAction={null}
      perform={perform}
      resolveConflicts={null}
    />
  );
  await using screen = await render(control("正在检查堆叠归属…"));
  using _timers = fakeTimers();
  const button = screen.getByRole("button");
  await userEvent.tab();
  await expect.element(button).toHaveFocus();
  await expect.element(button).toHaveAccessibleDescription("正在检查堆叠归属…");
  await userEvent.keyboard("{Enter}{Enter} ");
  expect(perform).not.toHaveBeenCalled();
  await screen.rerender(control(null));
  await userEvent.click(button);
  expect(perform).not.toHaveBeenCalled();
  await userEvent.click(button);
  expect(perform).toHaveBeenCalledExactlyOnceWith(primaryAction, "squash");
}

// quarantine: #21 关一基线：整例超过 15 秒
it.skip("keeps a blocked merge action reachable without arming or performing it", () =>
  keepsBlockedAction("merge"));

it("keeps a blocked enable-auto-merge action reachable without arming or performing it", () =>
  keepsBlockedAction("enable-auto-merge"));

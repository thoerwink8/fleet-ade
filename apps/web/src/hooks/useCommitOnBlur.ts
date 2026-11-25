import { useRef, useState, type ChangeEvent, type KeyboardEvent, type RefObject } from "react";

import { anchoredToastManager } from "../components/ui/toast";

/** `false` rejects the commit and keeps the typed text; a promise reports an asynchronous save. */
export type CommitVerdict = void | false | Promise<boolean>;

const SAVED_TOAST_TIMEOUT_MS = 1500;
const REJECTED_TOAST_TIMEOUT_MS = 2500;

function showAnchoredInputToast(
  ref: RefObject<HTMLInputElement | HTMLTextAreaElement | null>,
  options: { title: string; timeout: number; type?: "error" },
) {
  if (!ref.current) return;
  anchoredToastManager.add({
    ...(options.type ? { type: options.type } : {}),
    data: { tooltipStyle: true },
    positionerProps: { anchor: ref.current },
    timeout: options.timeout,
    title: options.title,
  });
}

/**
 * Commits drafts on blur or Enter. A verdict of `false` or a rejected asynchronous save keeps the
 * typed text instead of reverting to the stored value; a confirmed save flashes a brief toast.
 */
export function useCommitOnBlur<
  TElement extends HTMLInputElement | HTMLTextAreaElement = HTMLInputElement,
>(
  value: string,
  onCommit: (next: string) => CommitVerdict,
  normalizeDraft?: (previous: string, next: string) => string,
  resetOnCommit = false,
): {
  value: string;
  ref: RefObject<TElement | null>;
  "aria-invalid"?: true;
  onChange: (event: ChangeEvent<TElement>) => void;
  onFocus: () => void;
  onBlur: () => void;
  onKeyDown: (event: KeyboardEvent<TElement>) => void;
  /** Clears the draft so the input shows the stored value again. */
  reset: () => void;
} {
  const inputRef = useRef<TElement | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [rejected, setRejected] = useState<{ text: string; kind: "invalid" | "failed" } | null>(
    null,
  );
  const valueOnFocus = useRef(value);
  const commitToken = useRef(0);
  const editEpoch = useRef(0);
  const focusEpoch = useRef(0);
  const lastCommit = useRef<{ focus: number; text: string; edits: number } | null>(null);

  const reject = (text: string, kind: "invalid" | "failed") => {
    setRejected({ text, kind });
    showAnchoredInputToast(inputRef, {
      type: "error",
      timeout: REJECTED_TOAST_TIMEOUT_MS,
      title: kind === "invalid" ? "无效的值，未保存" : "保存失败，内容已保留",
    });
  };

  const settle = (outcome: Promise<boolean>, text: string, token: number, epoch: number) => {
    void outcome.then(
      (saved) => {
        if (commitToken.current !== token) return;
        setPending(null);
        // Edits after this commit are unsaved, so only an untouched draft earns the confirmation.
        const untouched = editEpoch.current === epoch;
        if (saved) {
          setRejected(null);
          setDraft((current) => (resetOnCommit || current === text ? null : current));
          if (untouched) {
            showAnchoredInputToast(inputRef, {
              timeout: SAVED_TOAST_TIMEOUT_MS,
              title: "已保存",
            });
          }
        } else if (untouched) {
          reject(text, "failed");
        }
      },
      () => {
        if (commitToken.current !== token) return;
        setPending(null);
        if (editEpoch.current === epoch) reject(text, "failed");
      },
    );
  };

  const commit = (text: string) => {
    lastCommit.current = { focus: focusEpoch.current, text, edits: editEpoch.current };
    const verdict = onCommit(text);
    if (verdict === false) {
      reject(text, "invalid");
      return;
    }
    if (resetOnCommit) setDraft(null);
    if (verdict instanceof Promise) {
      const token = ++commitToken.current;
      setRejected(null);
      setPending(text);
      settle(verdict, text, token, editEpoch.current);
    }
  };
  const reset = () => {
    commitToken.current += 1;
    lastCommit.current = null;
    setDraft(null);
    setPending(null);
    setRejected(null);
  };

  return {
    ref: inputRef,
    value: draft ?? pending ?? value,
    ...(rejected !== null ? { "aria-invalid": true as const } : {}),
    reset,
    onChange: (event: ChangeEvent<TElement>) => {
      const next = event.target.value;
      editEpoch.current += 1;
      setRejected(null);
      setDraft(normalizeDraft ? normalizeDraft(draft ?? pending ?? value, next) : next);
    },
    onFocus: () => {
      focusEpoch.current += 1;
      const shown = draft ?? pending ?? value;
      valueOnFocus.current = shown;
      setDraft(shown);
    },
    onBlur: () => {
      const text = draft ?? value;
      // Browsers can deliver a second blur for one edit (e.g. the input becomes disabled);
      // only a refocus or a new edit may commit the same text again.
      const last = lastCommit.current;
      if (
        last !== null &&
        last.focus === focusEpoch.current &&
        last.text === text &&
        last.edits === editEpoch.current
      )
        return;
      if (text === valueOnFocus.current) {
        if (rejected === null) {
          // A draft still saving must survive so a failure can keep showing it.
          if (pending === null || pending !== text) setDraft(null);
          return;
        }
        if (rejected.text !== text || rejected.kind === "invalid") return;
        // Blurring an unchanged failed draft retries the save.
      } else if (text === value) {
        setRejected(null);
        setDraft(null);
        return;
      }
      commit(text);
    },
    onKeyDown: (event: KeyboardEvent<TElement>) => {
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      if (event.key === "Enter") {
        event.preventDefault();
        (event.target as HTMLElement).blur();
      }
    },
  };
}

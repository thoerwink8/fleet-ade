import { useCommitOnBlur, type CommitVerdict } from "~/hooks/useCommitOnBlur";
import { Input, type InputProps } from "./input";

export type DraftInputProps = Omit<InputProps, "value" | "onChange" | "defaultValue"> & {
  readonly value: string;
  readonly onCommit: (next: string) => CommitVerdict;
  readonly normalizeDraft?: (previous: string, next: string) => string;
  /** When true, the input returns to the stored value right after a commit is accepted. */
  readonly resetOnCommit?: boolean;
};

/** Commit drafts without settings-wide rerenders or server round trips per keystroke. */
export function DraftInput({
  value,
  onCommit,
  normalizeDraft,
  resetOnCommit = false,
  ...rest
}: DraftInputProps) {
  const { reset: _reset, ...input } = useCommitOnBlur(
    value,
    onCommit,
    normalizeDraft,
    resetOnCommit,
  );
  return <Input {...rest} {...input} />;
}

import { CheckIcon, ChevronDownIcon, ChevronRightIcon, CopyIcon } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";

import { InlineButton } from "../ui/button";

export const ErrorDetailsDisclosure = memo(function ErrorDetailsDisclosure({
  detail,
  className,
}: {
  readonly detail: string | null;
  readonly className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- clears the clipboard feedback timer on unmount
  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  if (!detail) return null;

  const copyDetail = async () => {
    try {
      await navigator.clipboard.writeText(detail);
      setCopied(true);
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => {
        setCopied(false);
        timerRef.current = null;
      }, 1_500);
    } catch {
      // Ignore clipboard failures in restricted environments.
    }
  };

  return (
    <div className={className}>
      <div className="mt-1 flex flex-wrap items-center gap-3">
        <InlineButton
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
        >
          {open ? (
            <ChevronDownIcon className="size-3" aria-hidden="true" />
          ) : (
            <ChevronRightIcon className="size-3" aria-hidden="true" />
          )}
          {open ? "收起详情" : "详情"}
        </InlineButton>
        {open ? (
          <InlineButton type="button" onClick={() => void copyDetail()}>
            {copied ? (
              <CheckIcon className="size-3" aria-hidden="true" />
            ) : (
              <CopyIcon className="size-3" aria-hidden="true" />
            )}
            {copied ? "已复制" : "复制详情"}
          </InlineButton>
        ) : null}
      </div>
      {open ? (
        <pre className="mt-1.5 max-h-40 overflow-auto rounded-md border border-border/60 bg-background/60 p-2 font-mono text-xs leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere] text-foreground/85 select-text">
          {detail}
        </pre>
      ) : null}
    </div>
  );
});

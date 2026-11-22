import { ArrowLeftIcon, FileDiffIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

import { cn } from "~/lib/utils";

import { PullRequestMetaLine } from "./pullRequestPresentation";

export function PullRequestDetailHeaderBody({
  title,
  author,
  updated,
  checkout,
  base,
  head,
  files,
  diffStat,
}: {
  title: ReactNode;
  author: ReactNode;
  updated: ReactNode;
  checkout?: ReactNode;
  base: ReactNode;
  head: ReactNode;
  files: ReactNode;
  diffStat: ReactNode;
}) {
  return (
    <div className="col-span-2 mt-1 min-w-0 px-4 pb-4">
      {title}
      <div className="mt-2 flex min-h-5 min-w-0 items-center gap-2 text-xs text-muted-foreground">
        <PullRequestMetaLine className="min-w-0 whitespace-nowrap">
          {author}
          {updated}
        </PullRequestMetaLine>
        {checkout}
      </div>
      <div className="mt-4 flex min-h-5 min-w-0 items-center gap-2 text-xs text-muted-foreground">
        <span className="flex min-w-0 flex-1 items-center gap-1.5 font-mono text-xs text-muted-foreground/70">
          {base}
          <ArrowLeftIcon
            aria-label="接收来自以下分支的更改"
            className="size-3.5 shrink-0 opacity-60"
          />
          {head}
        </span>
        <span className="ml-auto inline-flex shrink-0 items-baseline justify-end gap-2">
          <span className="inline-flex min-w-16 items-baseline justify-end gap-1.5 tabular-nums">
            <FileDiffIcon aria-hidden className="size-3.5 self-center" />
            {files}
          </span>
          {diffStat}
        </span>
      </div>
    </div>
  );
}

export function PullRequestDetailTitleRow({ className, ...props }: ComponentProps<"div">) {
  return (
    <div className={cn("flex min-h-7 min-w-0 items-center sm:min-h-6", className)} {...props} />
  );
}

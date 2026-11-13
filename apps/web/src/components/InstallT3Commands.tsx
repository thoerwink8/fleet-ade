import { cn } from "~/lib/utils";

import { CommandBlock } from "./CommandBlock";

/**
 * Setup steps for another computer: install `t3`, then run `command`. Both installers are shown
 * because the browser showing this is often not the computer being set up.
 */
export function InstallT3Commands({
  command,
  className,
}: {
  readonly command: string;
  readonly className?: string;
}) {
  return (
    <div className={cn("space-y-2", className)}>
      <CommandBlock command={command} />
      <p className="text-xs text-muted-foreground">
        如果已经有 <code className="font-mono">t3</code>，可以跳过安装。如果{" "}
        <code className="font-mono">t3</code> 在安装后找不到，请把安装程序指出的文件夹加入 PATH。
      </p>
    </div>
  );
}

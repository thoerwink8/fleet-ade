import type { EnvironmentId } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { ArchiveIcon } from "lucide-react";
import { memo } from "react";

import { useArchivedThreadSnapshots } from "~/lib/archivedThreadsState";

import { countArchivedThreadsInScope } from "../Sidebar.logic";
import { useSidebar } from "../ui/sidebar";

export const SidebarArchivedEntry = memo(function SidebarArchivedEntry(props: {
  readonly connectedEnvironmentIds: ReadonlyArray<EnvironmentId>;
  readonly scopedProjectKeys: ReadonlySet<string> | null;
}) {
  const router = useRouter();
  const { isMobile, setOpenMobile } = useSidebar();
  const { snapshots } = useArchivedThreadSnapshots(props.connectedEnvironmentIds);
  const archivedCount = countArchivedThreadsInScope({
    snapshots,
    scopedProjectKeys: props.scopedProjectKeys,
  });

  if (archivedCount === 0) return null;

  return (
    <div className="mt-1 px-0.5">
      <button
        type="button"
        data-testid="sidebar-archived-entry"
        onClick={() => {
          if (isMobile) setOpenMobile(false);
          void router.navigate({ to: "/settings/threads", hash: "archive" });
        }}
        className="ade-touch-target ade-touch-target--y flex h-7 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-meta font-medium text-sidebar-muted-foreground transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
      >
        <ArchiveIcon aria-hidden className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate">已归档</span>
        <span className="ml-auto shrink-0 text-xs font-normal tabular-nums">{archivedCount}</span>
      </button>
    </div>
  );
});

import { Clock3Icon } from "lucide-react";
import { Button } from "../ui/button";
import { cancelPendingComposerSend } from "./pendingComposerSend.logic";

/**
 * Says what an armed send is waiting for. Its Cancel button is the user's own cancel, so it drops
 * the armed send without the "cancelled for you" notice that edits and leaving a conversation leave.
 */
export function PendingSendWaitingBar(props: {
  readonly id: string;
  readonly targetKey: string;
  readonly reason: string;
}) {
  return (
    <div
      id={props.id}
      role="status"
      aria-live="polite"
      data-chat-composer-pending-send="true"
      className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border-t border-border/60 px-4 py-2 text-xs text-muted-foreground"
    >
      <span className="flex min-w-0 items-center gap-1.5 [overflow-wrap:anywhere]">
        <Clock3Icon className="size-3.5 shrink-0" aria-hidden="true" />
        <span>{props.reason}</span>
      </span>
      <Button
        type="button"
        size="xs"
        variant="ghost"
        onClick={() => {
          cancelPendingComposerSend(props.targetKey);
        }}
      >
        取消
      </Button>
    </div>
  );
}

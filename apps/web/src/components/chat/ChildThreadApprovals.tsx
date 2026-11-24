import { useAtomValue } from "@effect/atom-react";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import type { ChildThreadApproval } from "@t3tools/client-runtime/state/thread-requests";
import { fullAccessOverrideExplanation } from "@t3tools/client-runtime/state/thread-requests";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";
import { useEnvironmentScope } from "../../state/session";
import { childThreadApprovalsAtom, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { InlineButton } from "../ui/button";
import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";

function ChildApproval({
  entry,
  onOpenThread,
}: {
  entry: ChildThreadApproval;
  onOpenThread?: ((threadId: ThreadId, environmentId?: EnvironmentId) => void) | undefined;
}) {
  const canRespond = useEnvironmentScope(entry.thread.environmentId, AuthOrchestrationOperateScope);
  const respond = useAtomCommand(threadEnvironment.respondToApproval, { reportFailure: false });
  const [responding, setResponding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { approval } = entry;
  const isLive = approval.responseCapability === "live";
  return (
    <section
      aria-label={`来自 ${entry.title} 的审批`}
      className="rounded-lg border border-border bg-background p-3 text-xs"
    >
      <p className="mb-2 font-medium">需要来自 {entry.title} 的批准</p>
      <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono">
        {approval.detail || approval.requestKind}
      </pre>
      {approval.appName ? <p className="mt-2 text-muted-foreground">{approval.appName}</p> : null}
      {!isLive ? (
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-warning">
          <span>这一轮已经结束，无法继续操作。</span>
          {onOpenThread ? (
            <InlineButton
              onClick={() => onOpenThread(entry.thread.threadId, entry.thread.environmentId)}
            >
              打开子会话
            </InlineButton>
          ) : null}
        </div>
      ) : null}
      {approval.reason ? <p className="mt-2 text-muted-foreground">{approval.reason}</p> : null}
      {approval.fullAccessOverride ? (
        <p className="mt-2 text-muted-foreground">
          {fullAccessOverrideExplanation(approval.fullAccessOverride)}
        </p>
      ) : null}
      {isLive ? (
        <div className="mt-2 flex flex-wrap gap-2">
          <ComposerPendingApprovalActions
            presentation="inline"
            requestId={approval.requestId}
            isResponding={responding}
            canRespond={isLive}
            disabled={!canRespond}
            options={approval.options}
            onRespondToApproval={async (requestId, decision) => {
              if (!canRespond || responding) return;
              setResponding(true);
              setError(null);
              const result = await respond({
                environmentId: entry.thread.environmentId,
                input: { threadId: entry.thread.threadId, requestId, decision },
              });
              if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
                const failure = squashAtomCommandFailure(result);
                setError(failure instanceof Error ? failure.message : "无法提交审批决定。");
              }
              setResponding(false);
              return result;
            }}
          />
        </div>
      ) : null}
      {error !== null ? (
        <p role="alert" className="mt-2 text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}

export function ChildThreadApprovals({
  threadRef,
  onOpenThread,
}: {
  threadRef: ScopedThreadRef | null;
  onOpenThread?: ((threadId: ThreadId, environmentId?: EnvironmentId) => void) | undefined;
}) {
  const approvals = useAtomValue(childThreadApprovalsAtom(threadRef));
  if (approvals.length === 0) return null;
  return (
    <div className="mb-2 flex max-h-80 flex-col gap-2 overflow-auto">
      {approvals.map((entry) => (
        <ChildApproval
          key={JSON.stringify([
            entry.thread.environmentId,
            entry.thread.threadId,
            entry.approval.requestId,
          ])}
          entry={entry}
          onOpenThread={onOpenThread}
        />
      ))}
    </div>
  );
}

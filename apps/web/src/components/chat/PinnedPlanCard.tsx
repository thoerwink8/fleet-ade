import type { OrchestrationV2PlanStep } from "@t3tools/contracts";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  ListTodoIcon,
  LoaderCircleIcon,
} from "lucide-react";
import { memo, useId, useState } from "react";
import { cn } from "~/lib/utils";
import {
  pinnedPlanHeadingLabel,
  pinnedPlanStepStatusLabel,
  resolvePinnedPlanExpanded,
  togglePinnedPlanExpanded,
  type PinnedPlanManualToggle,
  type PinnedPlanView,
} from "./PinnedPlanCard.logic";

function PinnedPlanStepIcon({ status }: { readonly status: OrchestrationV2PlanStep["status"] }) {
  switch (status) {
    case "completed":
      return (
        <CircleCheckIcon
          aria-hidden="true"
          className="mt-0.75 size-3.5 shrink-0 text-success-foreground"
        />
      );
    case "running":
      return (
        <LoaderCircleIcon
          aria-hidden="true"
          className="mt-0.75 size-3.5 shrink-0 text-info-foreground"
        />
      );
    case "pending":
      return (
        <CircleDashedIcon
          aria-hidden="true"
          className="mt-0.75 size-3.5 shrink-0 text-muted-foreground/70"
        />
      );
  }
}

export const PinnedPlanCard = memo(function PinnedPlanCard({
  threadKey,
  plan,
}: {
  readonly threadKey: string;
  readonly plan: PinnedPlanView;
}) {
  const panelId = useId();
  const [manualToggle, setManualToggle] = useState<PinnedPlanManualToggle | null>(null);
  const expanded = resolvePinnedPlanExpanded({ threadKey, plan, manualToggle });
  const heading = pinnedPlanHeadingLabel(plan.phase);
  const collapsedPreview = !expanded && plan.phase === "active" ? plan.runningStep?.text : null;

  return (
    <section
      aria-label={heading}
      data-pinned-plan-card="true"
      data-pinned-plan-phase={plan.phase}
      data-pinned-plan-expanded={expanded ? "true" : "false"}
      className="w-full min-w-0 overflow-hidden rounded-xl border border-border/75 bg-card/65"
    >
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={panelId}
        data-scroll-anchor-ignore
        onClick={() =>
          setManualToggle((current) =>
            togglePinnedPlanExpanded({ threadKey, plan, manualToggle: current }),
          )
        }
        className="flex w-full min-w-0 cursor-pointer items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-muted/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
      >
        <ListTodoIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">
          <span
            className={cn(
              "font-medium",
              plan.phase === "active" ? "text-foreground" : "text-muted-foreground",
            )}
          >
            {heading}
          </span>
          {collapsedPreview ? (
            <span className="text-muted-foreground">{` · ${collapsedPreview}`}</span>
          ) : null}
        </span>
        <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
          <span className="text-meta tabular-nums">
            {plan.completedCount}/{plan.totalCount}
          </span>
          {expanded ? (
            <ChevronDownIcon aria-hidden="true" className="size-3.5 shrink-0" />
          ) : (
            <ChevronRightIcon aria-hidden="true" className="size-3.5 shrink-0" />
          )}
        </span>
      </button>
      {expanded ? (
        <div id={panelId} className="border-t border-border/60 px-3 py-2">
          {plan.explanation ? (
            <p className="mb-1.5 break-words text-meta text-muted-foreground">{plan.explanation}</p>
          ) : null}
          <ol className="flex min-w-0 flex-col gap-1">
            {plan.steps.map((step) => (
              <li
                key={step.id}
                data-pinned-plan-step-status={step.status}
                className="flex min-w-0 items-start gap-2 text-xs/5"
              >
                <PinnedPlanStepIcon status={step.status} />
                <span className="sr-only">{pinnedPlanStepStatusLabel(step.status)}</span>
                <span
                  className={cn(
                    "min-w-0 flex-1 break-words",
                    step.status === "completed"
                      ? "text-muted-foreground line-through decoration-muted-foreground/50"
                      : step.status === "running"
                        ? "font-medium text-foreground"
                        : "text-muted-foreground",
                  )}
                >
                  {step.text}
                </span>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </section>
  );
});

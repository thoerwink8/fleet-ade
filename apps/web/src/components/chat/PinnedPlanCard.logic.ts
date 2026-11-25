import type {
  OrchestrationV2PlanArtifact,
  OrchestrationV2PlanStep,
  OrchestrationV2Run,
  OrchestrationV2RunStatus,
  PlanId,
  RunId,
} from "@t3tools/contracts";

export type PinnedPlanPhase = "active" | "previous";

export interface PinnedPlanView {
  readonly id: PlanId;
  readonly runId: RunId | null;
  readonly phase: PinnedPlanPhase;
  readonly steps: ReadonlyArray<OrchestrationV2PlanStep>;
  readonly explanation: string | null;
  readonly completedCount: number;
  readonly totalCount: number;
  readonly runningStep: OrchestrationV2PlanStep | null;
}

export interface PinnedPlanManualToggle {
  readonly scopeKey: string;
  readonly expanded: boolean;
}

type TodoListPlanArtifact = Extract<OrchestrationV2PlanArtifact, { readonly kind: "todo_list" }>;
type PinnedPlanRunSummary = Pick<OrchestrationV2Run, "id" | "ordinal" | "status">;

const ACTIVE_PLAN_RUN_STATUSES: ReadonlySet<OrchestrationV2RunStatus> = new Set([
  "preparing",
  "starting",
  "running",
  "waiting",
]);

function resolvePinnedPlanPhase(input: {
  readonly plan: TodoListPlanArtifact;
  readonly runById: ReadonlyMap<RunId, PinnedPlanRunSummary>;
  readonly isWorking: boolean;
  readonly activeRunId: RunId | null;
}): PinnedPlanPhase {
  if (input.plan.runId !== null) {
    const run = input.runById.get(input.plan.runId);
    if (run !== undefined) {
      return ACTIVE_PLAN_RUN_STATUSES.has(run.status) ? "active" : "previous";
    }
    return input.isWorking && input.activeRunId === input.plan.runId ? "active" : "previous";
  }
  return input.isWorking && input.plan.status === "active" ? "active" : "previous";
}

export function derivePinnedPlanView(input: {
  readonly plans: ReadonlyArray<OrchestrationV2PlanArtifact>;
  readonly runs: ReadonlyArray<PinnedPlanRunSummary>;
  readonly isWorking: boolean;
  readonly activeRunId: RunId | null;
}): PinnedPlanView | null {
  const runById = new Map<RunId, PinnedPlanRunSummary>(input.runs.map((run) => [run.id, run]));
  // A rewound turn no longer exists for the user, so its plan is not shown, not even as an earlier one.
  const isShown = (plan: OrchestrationV2PlanArtifact): plan is TodoListPlanArtifact =>
    plan.kind === "todo_list" &&
    plan.status !== "superseded" &&
    (plan.runId === null || runById.get(plan.runId)?.status !== "rolled_back");
  if (!input.plans.some(isShown)) {
    return null;
  }

  let selected: TodoListPlanArtifact | null = null;
  let selectedOrdinal = -1;
  for (const plan of input.plans) {
    if (!isShown(plan)) {
      continue;
    }
    const ordinal = plan.runId === null ? -1 : (runById.get(plan.runId)?.ordinal ?? -1);
    if (selected === null || ordinal >= selectedOrdinal) {
      selected = plan;
      selectedOrdinal = ordinal;
    }
  }

  if (selected === null || selected.steps.length === 0) {
    return null;
  }

  const phase = resolvePinnedPlanPhase({
    plan: selected,
    runById,
    isWorking: input.isWorking,
    activeRunId: input.activeRunId,
  });
  let completedCount = 0;
  let runningStep: OrchestrationV2PlanStep | null = null;
  for (const step of selected.steps) {
    if (step.status === "completed") {
      completedCount += 1;
    } else if (runningStep === null && step.status === "running") {
      runningStep = step;
    }
  }
  const explanation = selected.explanation?.trim() || null;

  return {
    id: selected.id,
    runId: selected.runId,
    phase,
    steps: selected.steps,
    explanation,
    completedCount,
    totalCount: selected.steps.length,
    runningStep,
  };
}

// Scope by runId (falling back to plan id for runless plans) so Claude's TodoWrite planId
// rotation within one turn keeps a user's collapse choice, while turn end resets it.
function pinnedPlanExpansionScopeKey(
  threadKey: string,
  plan: Pick<PinnedPlanView, "id" | "runId" | "phase">,
): string {
  return `${threadKey}:${plan.runId ?? plan.id}:${plan.phase}`;
}

export function resolvePinnedPlanExpanded(input: {
  readonly threadKey: string;
  readonly plan: Pick<PinnedPlanView, "id" | "runId" | "phase">;
  readonly manualToggle: PinnedPlanManualToggle | null;
}): boolean {
  const scopeKey = pinnedPlanExpansionScopeKey(input.threadKey, input.plan);
  if (input.manualToggle?.scopeKey === scopeKey) {
    return input.manualToggle.expanded;
  }
  return input.plan.phase === "active";
}

export function togglePinnedPlanExpanded(input: {
  readonly threadKey: string;
  readonly plan: Pick<PinnedPlanView, "id" | "runId" | "phase">;
  readonly manualToggle: PinnedPlanManualToggle | null;
}): PinnedPlanManualToggle {
  const scopeKey = pinnedPlanExpansionScopeKey(input.threadKey, input.plan);
  const current = resolvePinnedPlanExpanded(input);
  return { scopeKey, expanded: !current };
}

export function pinnedPlanHeadingLabel(phase: PinnedPlanPhase): string {
  return phase === "active" ? "当前计划" : "上一条消息之前的计划";
}

export function pinnedPlanStepStatusLabel(status: OrchestrationV2PlanStep["status"]): string {
  switch (status) {
    case "completed":
      return "已完成";
    case "running":
      return "进行中";
    case "pending":
      return "未开始";
  }
}

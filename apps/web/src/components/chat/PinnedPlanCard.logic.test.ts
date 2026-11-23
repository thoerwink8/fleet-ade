import { applyOrchestrationV2ProjectionEvent } from "@t3tools/client-runtime/state/orchestration-v2-projection";
import {
  EventId,
  NodeId,
  PlanId,
  PositiveInt,
  RunId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2PlanArtifact,
  type OrchestrationV2PlanStep,
  type OrchestrationV2RunStatus,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vitest";
import { makeThreadProjectionFixture } from "../../test-fixtures";
import {
  derivePinnedPlanView,
  pinnedPlanHeadingLabel,
  pinnedPlanStepStatusLabel,
  resolvePinnedPlanExpanded,
  togglePinnedPlanExpanded,
} from "./PinnedPlanCard.logic";

const THREAD_ID = ThreadId.make("thread-test");
const OCCURRED_AT = DateTime.makeUnsafe("2026-11-24T00:00:00.000Z");

function makeRun(id: string, ordinal: number, status: OrchestrationV2RunStatus) {
  return {
    id: RunId.make(id),
    ordinal: PositiveInt.make(ordinal),
    status,
  };
}

function makeStep(
  id: string,
  text: string,
  status: OrchestrationV2PlanStep["status"],
): OrchestrationV2PlanStep {
  return { id, text, status };
}

function makeTodoPlan(input: {
  readonly id: string;
  readonly runId: string | null;
  readonly status?: OrchestrationV2PlanArtifact["status"];
  readonly steps: ReadonlyArray<OrchestrationV2PlanStep>;
  readonly explanation?: string;
}): Extract<OrchestrationV2PlanArtifact, { readonly kind: "todo_list" }> {
  return {
    id: PlanId.make(input.id),
    threadId: THREAD_ID,
    runId: input.runId === null ? null : RunId.make(input.runId),
    nodeId: NodeId.make(`node:${input.id}`),
    kind: "todo_list",
    status: input.status ?? "active",
    steps: input.steps,
    ...(input.explanation === undefined ? {} : { explanation: input.explanation }),
  };
}

function makePlanUpdatedEvent(
  sequence: number,
  plan: OrchestrationV2PlanArtifact,
): OrchestrationV2DomainEvent {
  return {
    id: EventId.make(`event-${sequence}`),
    sequence: PositiveInt.make(sequence),
    threadId: plan.threadId,
    runId: plan.runId,
    occurredAt: OCCURRED_AT,
    type: "plan.updated",
    payload: plan,
  };
}

describe("derivePinnedPlanView", () => {
  it("derives and updates steps in place from Codex/ACP plan.updated events", () => {
    const run = makeRun("run-1", 1, "running");
    let projection = makeThreadProjectionFixture();

    projection = applyOrchestrationV2ProjectionEvent(
      projection,
      makePlanUpdatedEvent(
        1,
        makeTodoPlan({
          id: "plan-codex-1",
          runId: "run-1",
          explanation: "  Inspect repository first  ",
          steps: [
            makeStep("step-1", "Read contracts", "running"),
            makeStep("step-2", "Render pinned list", "pending"),
          ],
        }),
      ),
    )!;

    const first = derivePinnedPlanView({
      plans: projection.plans,
      runs: [run],
      isWorking: true,
      activeRunId: run.id,
    });
    expect(first).toEqual({
      id: PlanId.make("plan-codex-1"),
      runId: run.id,
      phase: "active",
      explanation: "Inspect repository first",
      completedCount: 0,
      totalCount: 2,
      runningStep: makeStep("step-1", "Read contracts", "running"),
      steps: [
        makeStep("step-1", "Read contracts", "running"),
        makeStep("step-2", "Render pinned list", "pending"),
      ],
    });

    projection = applyOrchestrationV2ProjectionEvent(
      projection,
      makePlanUpdatedEvent(
        2,
        makeTodoPlan({
          id: "plan-codex-1",
          runId: "run-1",
          explanation: "   ",
          steps: [
            makeStep("step-1", "Read contracts", "completed"),
            makeStep("step-2", "Render pinned list", "running"),
          ],
        }),
      ),
    )!;

    const second = derivePinnedPlanView({
      plans: projection.plans,
      runs: [run],
      isWorking: true,
      activeRunId: run.id,
    });
    expect(projection.plans).toHaveLength(1);
    expect(second).toMatchObject({
      id: PlanId.make("plan-codex-1"),
      phase: "active",
      explanation: null,
      completedCount: 1,
      totalCount: 2,
      runningStep: makeStep("step-2", "Render pinned list", "running"),
    });
  });

  it("follows Claude TodoWrite updates that supersede the previous plan id", () => {
    const run = makeRun("run-claude", 1, "running");
    let projection = makeThreadProjectionFixture();
    const initialPlan = makeTodoPlan({
      id: "plan-todo-1",
      runId: "run-claude",
      steps: [makeStep("1", "Audit adapters", "running"), makeStep("2", "Write tests", "pending")],
    });
    const updatedPlan = makeTodoPlan({
      id: "plan-todo-2",
      runId: "run-claude",
      status: "completed",
      steps: [
        makeStep("1", "Audit adapters", "completed"),
        makeStep("2", "Write tests", "completed"),
      ],
    });

    projection = applyOrchestrationV2ProjectionEvent(
      projection,
      makePlanUpdatedEvent(1, initialPlan),
    )!;
    projection = applyOrchestrationV2ProjectionEvent(
      projection,
      makePlanUpdatedEvent(2, { ...initialPlan, status: "superseded" }),
    )!;
    projection = applyOrchestrationV2ProjectionEvent(
      projection,
      makePlanUpdatedEvent(3, updatedPlan),
    )!;

    const view = derivePinnedPlanView({
      plans: projection.plans,
      runs: [run],
      isWorking: true,
      activeRunId: run.id,
    });
    expect(view).toMatchObject({
      id: PlanId.make("plan-todo-2"),
      phase: "active",
      completedCount: 2,
      totalCount: 2,
      runningStep: null,
    });
  });

  it("ignores proposed_plan artifacts and returns null when todo_list is cleared or superseded", () => {
    const run = makeRun("run-1", 1, "running");
    const proposedPlan: OrchestrationV2PlanArtifact = {
      id: PlanId.make("proposed-1"),
      threadId: THREAD_ID,
      runId: run.id,
      nodeId: NodeId.make("node:proposed-1"),
      kind: "proposed_plan",
      status: "active",
      markdown: "# Plan\n\n1. Do work",
    };

    expect(
      derivePinnedPlanView({
        plans: [proposedPlan],
        runs: [run],
        isWorking: true,
        activeRunId: run.id,
      }),
    ).toBeNull();

    expect(
      derivePinnedPlanView({
        plans: [
          proposedPlan,
          makeTodoPlan({
            id: "plan-cleared",
            runId: "run-1",
            steps: [],
          }),
        ],
        runs: [run],
        isWorking: true,
        activeRunId: run.id,
      }),
    ).toBeNull();

    expect(
      derivePinnedPlanView({
        plans: [
          makeTodoPlan({
            id: "plan-removed",
            runId: "run-1",
            status: "superseded",
            steps: [makeStep("1", "Old step", "pending")],
          }),
        ],
        runs: [run],
        isWorking: true,
        activeRunId: run.id,
      }),
    ).toBeNull();
  });

  it("prefers the plan from the highest run ordinal even when an older Codex plan stays active", () => {
    const run1 = makeRun("run-1", 1, "completed");
    const run2 = makeRun("run-2", 2, "running");

    const view = derivePinnedPlanView({
      plans: [
        makeTodoPlan({
          id: "plan-run-1",
          runId: "run-1",
          status: "active",
          steps: [makeStep("1", "Turn 1 step", "completed")],
        }),
        makeTodoPlan({
          id: "plan-run-2",
          runId: "run-2",
          status: "active",
          steps: [makeStep("1", "Turn 2 step", "running")],
        }),
      ],
      runs: [run1, run2],
      isWorking: true,
      activeRunId: run2.id,
    });

    expect(view).toMatchObject({
      id: PlanId.make("plan-run-2"),
      runId: run2.id,
      phase: "active",
    });
  });

  it.each<readonly [OrchestrationV2RunStatus, "active" | "previous"]>([
    ["preparing", "active"],
    ["starting", "active"],
    ["running", "active"],
    ["waiting", "active"],
    ["completed", "previous"],
    ["interrupted", "previous"],
    ["failed", "previous"],
    ["cancelled", "previous"],
    ["rolled_back", "previous"],
  ])("marks a plan as %s -> %s based on its run status", (runStatus, expectedPhase) => {
    const run = makeRun("run-1", 1, runStatus);
    const view = derivePinnedPlanView({
      plans: [
        makeTodoPlan({
          id: "plan-1",
          runId: "run-1",
          status: "active",
          steps: [makeStep("1", "Step 1", "running")],
        }),
      ],
      runs: [run],
      isWorking: expectedPhase === "active",
      activeRunId: expectedPhase === "active" ? run.id : null,
    });

    expect(view?.phase).toBe(expectedPhase);
  });

  it("keeps an earlier finished turn's plan marked previous while a newer turn runs without a plan", () => {
    const run1 = makeRun("run-1", 1, "completed");
    const run2 = makeRun("run-2", 2, "running");

    const view = derivePinnedPlanView({
      plans: [
        makeTodoPlan({
          id: "plan-run-1",
          runId: "run-1",
          status: "active",
          steps: [makeStep("1", "Previous work", "completed")],
        }),
      ],
      runs: [run1, run2],
      isWorking: true,
      activeRunId: run2.id,
    });

    expect(view?.phase).toBe("previous");
  });

  it("handles runless plans and paged-out runs gracefully", () => {
    const runlessPlan = makeTodoPlan({
      id: "plan-runless",
      runId: null,
      status: "active",
      steps: [makeStep("1", "Runless step", "running")],
    });
    expect(
      derivePinnedPlanView({
        plans: [runlessPlan],
        runs: [],
        isWorking: true,
        activeRunId: null,
      })?.phase,
    ).toBe("active");
    expect(
      derivePinnedPlanView({
        plans: [runlessPlan],
        runs: [],
        isWorking: false,
        activeRunId: null,
      })?.phase,
    ).toBe("previous");

    const pagedOutRunId = RunId.make("run-paged-out");
    const pagedPlan = makeTodoPlan({
      id: "plan-paged",
      runId: "run-paged-out",
      status: "active",
      steps: [makeStep("1", "Older step", "completed")],
    });
    expect(
      derivePinnedPlanView({
        plans: [pagedPlan],
        runs: [],
        isWorking: false,
        activeRunId: null,
      })?.phase,
    ).toBe("previous");
    expect(
      derivePinnedPlanView({
        plans: [pagedPlan],
        runs: [],
        isWorking: true,
        activeRunId: pagedOutRunId,
      })?.phase,
    ).toBe("active");
  });
});

describe("pinned plan expansion lifecycle", () => {
  it("starts expanded while active, collapses automatically when the turn ends, and allows manual toggling", () => {
    const threadKey = "env:thread-1";
    const activePlan = {
      id: PlanId.make("plan-1"),
      runId: RunId.make("run-1"),
      phase: "active" as const,
    };

    expect(
      resolvePinnedPlanExpanded({
        threadKey,
        plan: activePlan,
        manualToggle: null,
      }),
    ).toBe(true);

    // User manually collapses during an active turn.
    const collapsedDuringTurn = togglePinnedPlanExpanded({
      threadKey,
      plan: activePlan,
      manualToggle: null,
    });
    expect(
      resolvePinnedPlanExpanded({
        threadKey,
        plan: activePlan,
        manualToggle: collapsedDuringTurn,
      }),
    ).toBe(false);

    // Claude TodoWrite rotates plan.id within the same run; user's collapse choice stays intact.
    const rotatedClaudePlan = {
      id: PlanId.make("plan-2"),
      runId: RunId.make("run-1"),
      phase: "active" as const,
    };
    expect(
      resolvePinnedPlanExpanded({
        threadKey,
        plan: rotatedClaudePlan,
        manualToggle: collapsedDuringTurn,
      }),
    ).toBe(false);

    // When the turn finishes, phase flips to "previous" and defaults back to collapsed.
    const endedPlan = {
      id: PlanId.make("plan-2"),
      runId: RunId.make("run-1"),
      phase: "previous" as const,
    };
    expect(
      resolvePinnedPlanExpanded({
        threadKey,
        plan: endedPlan,
        manualToggle: null,
      }),
    ).toBe(false);

    // User expands the previous plan to inspect it.
    const expandedPrevious = togglePinnedPlanExpanded({
      threadKey,
      plan: endedPlan,
      manualToggle: collapsedDuringTurn,
    });
    expect(
      resolvePinnedPlanExpanded({
        threadKey,
        plan: endedPlan,
        manualToggle: expandedPrevious,
      }),
    ).toBe(true);

    // A new turn starts a fresh active plan -> auto-expands without keeping stale toggle state.
    const nextTurnPlan = {
      id: PlanId.make("plan-3"),
      runId: RunId.make("run-2"),
      phase: "active" as const,
    };
    expect(
      resolvePinnedPlanExpanded({
        threadKey,
        plan: nextTurnPlan,
        manualToggle: expandedPrevious,
      }),
    ).toBe(true);

    // Switching threads also resets manual expansion.
    expect(
      resolvePinnedPlanExpanded({
        threadKey: "env:thread-2",
        plan: endedPlan,
        manualToggle: expandedPrevious,
      }),
    ).toBe(false);
  });

  it("formats heading and step status labels in Chinese", () => {
    expect(pinnedPlanHeadingLabel("active")).toBe("当前计划");
    expect(pinnedPlanHeadingLabel("previous")).toBe("上一条消息之前的计划");
    expect(pinnedPlanStepStatusLabel("completed")).toBe("已完成");
    expect(pinnedPlanStepStatusLabel("running")).toBe("进行中");
    expect(pinnedPlanStepStatusLabel("pending")).toBe("未开始");
  });
});

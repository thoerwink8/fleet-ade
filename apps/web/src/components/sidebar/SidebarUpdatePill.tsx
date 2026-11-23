import { useState } from "react";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { cn } from "../../lib/utils";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { useCheckProviderUpdates } from "../ProviderUpdatesAction";
import { SidebarMenuItem } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  UpdateStatusIcon,
  shouldContinueUpdateCheckAnimation,
  shouldShowUpdateCheckIcon,
} from "./UpdateStatusIcon";
import { SidebarUpdateCapsule } from "./SidebarUpdateCapsule";
import { UpdateEverythingDialog } from "./UpdateEverythingDialog";
import { useUpdateEverythingRun } from "./updateEverythingRun";
import { useUpdateEverything } from "./useUpdateEverything";

export function SidebarUpdatePill() {
  return <SidebarUpdateControl />;
}

function SidebarUpdateControl() {
  const [isActionPending, setIsActionPending] = useState(false);
  const [providerCheck, setProviderCheck] = useState<"button" | "dialog" | null>(null);
  const isCheckingProviders = providerCheck === "button";
  const [isConfirmingEverything, setIsConfirmingEverything] = useState(false);
  const [checkAnimationKey, setCheckAnimationKey] = useState(0);
  const prefersReducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");

  const [isCheckAnimationLatched, setIsCheckAnimationLatched] = useState(
    () => !prefersReducedMotion && isCheckingProviders,
  );
  const [latchInputs, setLatchInputs] = useState({ prefersReducedMotion, isCheckingProviders });
  if (
    latchInputs.prefersReducedMotion !== prefersReducedMotion ||
    latchInputs.isCheckingProviders !== isCheckingProviders
  ) {
    setLatchInputs({ prefersReducedMotion, isCheckingProviders });
    if (prefersReducedMotion) {
      setIsCheckAnimationLatched(false);
    } else if (isCheckingProviders) {
      setIsCheckAnimationLatched(true);
    }
  }

  const everything = useUpdateEverything();
  const checkProviderUpdates = useCheckProviderUpdates();
  const runsEverything = everything.hasUpdates;
  const run = useUpdateEverythingRun();
  const isRunningEverything = run !== null;
  const showCheckIcon = shouldShowUpdateCheckIcon({
    isAnimationLatched: isCheckAnimationLatched,
    isChecking: isCheckingProviders,
    prefersReducedMotion,
  });
  const iconStatus = showCheckIcon
    ? "checking"
    : run !== null || runsEverything
      ? "everything"
      : "idle";

  const tooltip = runsEverything
    ? everything.summary
    : showCheckIcon
      ? "正在检查更新…"
      : "检查更新";
  const disabled = showCheckIcon && !runsEverything;
  const isInteractionDisabled = disabled || isActionPending || isRunningEverything;

  const handleAction = async () => {
    if (isInteractionDisabled) return;

    if (runsEverything) {
      setIsConfirmingEverything(true);
      // Machines that still cache an older latest version add their rows while the dialog is open.
      setProviderCheck("dialog");
      void checkProviderUpdates({ quiet: true }).finally(() => setProviderCheck(null));
      return;
    }

    if (!prefersReducedMotion) {
      setIsCheckAnimationLatched(true);
      setCheckAnimationKey((key) => key + 1);
    }
    setIsActionPending(true);
    setProviderCheck("button");
    void checkProviderUpdates()
      .finally(() => setProviderCheck(null))
      .then(() => setIsActionPending(false));
  };

  const runEverything = async () => {
    setIsConfirmingEverything(false);
    setIsActionPending(true);
    const result = await settlePromise(() => everything.run());
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "无法全部更新",
          description: error instanceof Error ? error.message : "发生了意外错误。",
        }),
      );
    }
    setIsActionPending(false);
  };

  const handleCheckAnimationIteration = () => {
    setIsCheckAnimationLatched(
      shouldContinueUpdateCheckAnimation({
        isChecking: isCheckingProviders,
        prefersReducedMotion,
      }),
    );
  };

  const statusIcon = (
    <UpdateStatusIcon
      key={showCheckIcon ? checkAnimationKey : iconStatus}
      isCheckAnimating={showCheckIcon && !prefersReducedMotion}
      onCheckAnimationIteration={handleCheckAnimationIteration}
      status={iconStatus}
    />
  );
  const confirmDialog = (
    <UpdateEverythingDialog
      open={isConfirmingEverything}
      onOpenChange={setIsConfirmingEverything}
      version={everything.version}
      providerCount={everything.providerCount}
      rows={everything.rows}
      restarts={everything.restarts}
      checking={providerCheck === "dialog"}
      onConfirm={() => void runEverything()}
    />
  );

  if (run !== null) {
    return (
      <SidebarMenuItem className="ml-auto flex flex-1">
        <SidebarUpdateCapsule run={run} icon={statusIcon} />
        {confirmDialog}
      </SidebarMenuItem>
    );
  }

  return (
    <SidebarMenuItem className="ml-auto shrink-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={tooltip}
              aria-disabled={isInteractionDisabled || undefined}
              className={cn(
                "inline-flex size-8 items-center justify-center rounded-full outline-hidden ring-ring transition-colors focus-visible:ring-2 focus-visible:ring-inset",
                isInteractionDisabled ? "cursor-not-allowed" : "cursor-pointer",
                runsEverything
                  ? cn(
                      "bg-sidebar-control-surface text-sidebar-foreground",
                      !isInteractionDisabled && "hover:bg-sidebar-row-hover",
                    )
                  : cn(
                      "text-(--sidebar-icon-color)",
                      !isInteractionDisabled &&
                        "hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
                    ),
                disabled && "opacity-60",
              )}
              onClick={() => void handleAction()}
            />
          }
        />
        <TooltipPopup align="center" side="top">
          <span className="whitespace-pre-line">{tooltip}</span>
        </TooltipPopup>
      </Tooltip>
      {confirmDialog}
    </SidebarMenuItem>
  );
}

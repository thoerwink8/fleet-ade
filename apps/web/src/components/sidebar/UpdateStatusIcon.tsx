import { RefreshIcon } from "~/components/ui/refresh-icon";
import { CircleArrowUpIcon } from "lucide-react";
import type { AnimationEventHandler } from "react";

export type UpdateStatusIconState = "idle" | "checking" | "everything";

export function shouldShowUpdateCheckIcon({
  isAnimationLatched,
  isChecking,
  prefersReducedMotion,
}: {
  readonly isAnimationLatched: boolean;
  readonly isChecking: boolean;
  readonly prefersReducedMotion: boolean;
}): boolean {
  return isChecking || (isAnimationLatched && !prefersReducedMotion);
}

export function shouldContinueUpdateCheckAnimation({
  isChecking,
  prefersReducedMotion,
}: {
  readonly isChecking: boolean;
  readonly prefersReducedMotion: boolean;
}): boolean {
  return isChecking && !prefersReducedMotion;
}

export function UpdateStatusIcon({
  isCheckAnimating,
  onCheckAnimationIteration,
  status,
}: {
  readonly isCheckAnimating?: boolean;
  readonly onCheckAnimationIteration?: AnimationEventHandler<SVGSVGElement>;
  readonly status: UpdateStatusIconState;
}) {
  if (status === "everything") return <CircleArrowUpIcon className="size-4" />;

  return (
    <RefreshIcon
      className="size-4"
      refreshing={status === "checking" && isCheckAnimating === true}
      onAnimationIteration={onCheckAnimationIteration}
    />
  );
}

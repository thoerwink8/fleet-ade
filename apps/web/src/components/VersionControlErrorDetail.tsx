import { ErrorDetailsDisclosure } from "./chat/ErrorDetailsDisclosure";
import { cn } from "~/lib/utils";
import {
  versionControlErrorDetailMode,
  type VersionControlErrorPresentation,
} from "./versionControlError.logic";

export function VersionControlErrorDetail({
  error,
  className,
}: {
  readonly error: Pick<VersionControlErrorPresentation, "collapseDetail" | "detail">;
  readonly className?: string;
}) {
  const mode = versionControlErrorDetailMode(error);
  if (mode === "hidden") return null;
  if (mode === "disclosure") {
    return (
      <ErrorDetailsDisclosure
        detail={error.detail}
        {...(className === undefined ? {} : { className })}
      />
    );
  }
  return (
    <p className={cn("max-w-full min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]", className)}>
      {error.detail}
    </p>
  );
}

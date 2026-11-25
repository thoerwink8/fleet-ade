import { useRef } from "react";

import { APP_VERSION } from "../../branding";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { showAnchoredCopySuccessToast } from "../ui/anchoredCopyToast";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function AboutVersionTitle() {
  const copyButtonRef = useRef<HTMLButtonElement>(null);
  const { copyToClipboard } = useCopyToClipboard<void>({
    target: "version",
    onCopy: () => showAnchoredCopySuccessToast(copyButtonRef),
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "无法复制版本",
          description: error.message,
        }),
      );
    },
  });

  return (
    <span className="inline-flex items-center gap-2">
      <span>版本</span>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              ref={copyButtonRef}
              variant="muted"
              size="xs"
              aria-label={`复制版本 ${APP_VERSION}`}
              onClick={() => copyToClipboard(APP_VERSION, undefined)}
            >
              <code className="font-mono font-normal">{APP_VERSION}</code>
            </Button>
          }
        />
        <TooltipPopup>复制版本</TooltipPopup>
      </Tooltip>
    </span>
  );
}

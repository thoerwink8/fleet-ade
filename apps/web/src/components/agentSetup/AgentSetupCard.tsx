import { ProviderInstanceId, type EnvironmentId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";

import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  AGENT_SETUP_ACTION_LABEL,
  AGENT_SETUP_STATUS_LABEL,
  type AgentSetupCardModel,
  type AgentSetupState,
} from "./agentSetupCard.logic";

const STATUS_BADGE: Readonly<Record<AgentSetupState, "warning" | "error" | "secondary">> = {
  not_installed: "warning",
  signed_out: "warning",
  error: "error",
  disabled: "secondary",
};

export function AgentSetupCard({
  model,
  environmentId,
  inset = false,
}: {
  readonly model: AgentSetupCardModel;
  readonly environmentId: EnvironmentId;
  /** Pads the card when it sits inside a framed container such as the composer. */
  readonly inset?: boolean;
}) {
  return (
    <section
      aria-label={model.title}
      className={cn("w-full max-w-lg text-left", inset && "px-3 pt-3")}
    >
      <h2 className="text-sm font-medium text-foreground">{model.title}</h2>
      {model.rows.length === 0 ? (
        <div className="mt-3">
          <Button
            size="sm"
            variant="secondary"
            render={<Link to="/settings/providers" search={{ environmentId }} />}
          >
            打开智能体设置
          </Button>
        </div>
      ) : (
        <ul className="mt-3 divide-y divide-border/60 overflow-hidden rounded-xl border border-border/80">
          {model.rows.map((row) => (
            <li key={row.instanceId} className="flex items-center justify-between gap-3 px-3 py-2">
              <span className="min-w-0 truncate text-sm text-foreground">{row.name}</span>
              <span className="flex shrink-0 items-center gap-2">
                <Badge size="sm" variant={STATUS_BADGE[row.state]}>
                  {AGENT_SETUP_STATUS_LABEL[row.state]}
                </Badge>
                <Button
                  size="sm"
                  variant="secondary"
                  render={
                    <Link
                      to="/settings/providers"
                      search={{
                        environmentId,
                        instanceId: ProviderInstanceId.make(row.instanceId),
                      }}
                      hash={row.settingsHash}
                    />
                  }
                >
                  {AGENT_SETUP_ACTION_LABEL[row.state]}
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

import { createFileRoute, redirect } from "@tanstack/react-router";

import { ApproveAgentSurface } from "../components/auth/ApproveAgentSurface";

export const Route = createFileRoute("/approve-agent")({
  beforeLoad: () => {
    throw redirect({ to: "/", replace: true });
  },
  component: ApproveAgentSurface,
});

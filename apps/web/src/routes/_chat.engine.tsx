import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_chat/engine")({
  beforeLoad: () => {
    throw redirect({ to: "/", replace: true });
  },
});

import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_chat/channels")({
  beforeLoad: () => {
    throw redirect({ to: "/", replace: true });
  },
});

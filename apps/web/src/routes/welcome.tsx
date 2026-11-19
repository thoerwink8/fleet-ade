import { createFileRoute, redirect } from "@tanstack/react-router";

// The multi-step welcome tour is gone. Old links open the session page.
export const Route = createFileRoute("/welcome")({
  beforeLoad: () => {
    throw redirect({ to: "/", search: true, hash: true, replace: true });
  },
});

import { createFileRoute } from "@tanstack/react-router";

// The settings route redirects legacy links to maintenance.
export const Route = createFileRoute("/_chat/settings/beta")({});

import { createFileRoute } from "@tanstack/react-router";

import { EngineStatusPage } from "../components/engine/EngineStatusPage";

export const Route = createFileRoute("/_chat/engine")({
  component: EngineStatusPage,
});

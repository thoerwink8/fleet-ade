import { createFileRoute, redirect } from "@tanstack/react-router";

import { readPullRequestListPreferences } from "../components/pullRequest/pullRequestListPreferences";
export const Route = createFileRoute("/_chat/pipeline")({
  beforeLoad: () => {
    throw redirect({
      to: "/pull-requests",
      search: readPullRequestListPreferences(),
      replace: true,
    });
  },
});

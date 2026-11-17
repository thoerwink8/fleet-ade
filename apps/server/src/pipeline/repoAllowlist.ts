import { DEFAULT_PIPELINE_REPOS, parsePipelineRepo } from "@t3tools/contracts";

/** The repository that stays on `pipeline/` branches and is not marked 「本机做」. */
export const DEFAULT_REPO = DEFAULT_PIPELINE_REPOS[0];

/** Tells the old engine to leave an issue that this pipeline claimed from another repository. */
export const LOCAL_LABEL = "本机做";

export const parseRepo = parsePipelineRepo;

export const isDefaultRepo = (slug: string): boolean => slug === DEFAULT_REPO;

const branchFragment = (title: string): string => {
  const fragment = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
  return fragment.length > 0 ? fragment : "issue";
};

/** Default repository keeps `pipeline/<issue>-<short>`. Every other repository uses `local/`. */
export const worktreeBranch = (repository: string, issueNumber: number, title: string): string =>
  `${isDefaultRepo(repository) ? "pipeline" : "local"}/${issueNumber}-${branchFragment(title)}`;

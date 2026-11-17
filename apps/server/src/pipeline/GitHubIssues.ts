import * as GitHubRequestPolicy from "@t3tools/source-control-github/server/GitHubRequestPolicy";
import * as GitHubRest from "@t3tools/source-control-github/server/GitHubRest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

/** The one repository this pipeline reads. Not a setting, and not a loop over repositories. */
export const REPOSITORY = { owner: "thoerwink8", name: "fleet-ade" } as const;

/** An open issue carrying this label is eligible. A pull request never is. */
export const ELIGIBLE_LABEL = "交给 ADE";

const HOST = "github.com";
export const PIPELINE_HOST = HOST;
const PAGE_SIZE = 100;
/** GitHub serves at most this many items for one listing, so a full last page is a cut-off list. */
const MAX_ITEMS = 1000;

export class PipelineIssuesIncompleteError extends Schema.TaggedError<
  PipelineIssuesIncompleteError,
  { readonly brand: unique symbol }
>()("PipelineIssuesIncompleteError", { reason: Schema.Literals(["truncated", "capped"]) }) {
  override get message(): string {
    return this.reason === "truncated"
      ? "GitHub cut an issue response off, so the list is incomplete."
      : "GitHub returned more open issues than one read can hold.";
  }
}

export type PipelineIssuesError =
  | GitHubRequestPolicy.GitHubApiError
  | PipelineIssuesIncompleteError
  | Schema.SchemaError;

export interface PipelineIssueAuthor {
  readonly login: string;
  readonly id: number;
  readonly type: string;
}

export interface PipelineIssue {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly labels: ReadonlyArray<string>;
  readonly author?: PipelineIssueAuthor | null;
  readonly createdAt?: string | null;
  readonly state?: "open" | "closed";
}

const IssuePage = Schema.Array(
  Schema.Struct({
    number: Schema.Int,
    title: Schema.String,
    // GitHub sends null when an issue has no body.
    body: Schema.NullOr(Schema.String),
    pull_request: Schema.optional(Schema.Unknown),
    state: Schema.optional(Schema.Literals(["open", "closed"])),
    created_at: Schema.optional(Schema.NullOr(Schema.String)),
    user: Schema.optional(
      Schema.NullOr(
        Schema.Struct({
          login: Schema.String,
          id: Schema.Int,
          type: Schema.optional(Schema.String),
        }),
      ),
    ),
    labels: Schema.Array(
      Schema.Union([Schema.String, Schema.Struct({ name: Schema.optional(Schema.String) })]),
    ),
  }),
);

type DecodedIssue = (typeof IssuePage.Type)[number];

const labelNames = (labels: DecodedIssue["labels"]): Array<string> =>
  labels.flatMap((label) => {
    if (typeof label === "string") return [label];
    return label.name === undefined ? [] : [label.name];
  });

const toIssue = (issue: DecodedIssue): PipelineIssue => ({
  number: issue.number,
  title: issue.title,
  body: issue.body ?? "",
  labels: labelNames(issue.labels),
  ...(issue.user == null
    ? {}
    : {
        author: {
          login: issue.user.login,
          id: issue.user.id,
          type: issue.user.type ?? "",
        },
      }),
  ...(issue.created_at == null ? {} : { createdAt: issue.created_at }),
  ...(issue.state === undefined ? {} : { state: issue.state }),
});

const decodeIssuePage = Schema.decodeUnknownEffect(Schema.fromJsonString(IssuePage));

export class PipelineGitHubIssues extends Context.Service<
  PipelineGitHubIssues,
  {
    /** Every open issue of this repository that carries `ELIGIBLE_LABEL`. */
    readonly listEligible: () => Effect.Effect<ReadonlyArray<PipelineIssue>, PipelineIssuesError>;
    /** One issue's title and body, read on its own. */
    readonly read: (number: number) => Effect.Effect<PipelineIssue, PipelineIssuesError>;
    readonly addLabel: (number: number, label: string) => Effect.Effect<void, PipelineIssuesError>;
  }
>()("t3/pipeline/GitHubIssues/PipelineGitHubIssues") {}

const make = Effect.gen(function* () {
  const rest = yield* GitHubRest.GitHubRest;

  const get = Effect.fn("PipelineGitHubIssues.get")(function* (path: string) {
    const response = yield* rest.rest({
      host: HOST,
      operation: "pipelineIssues",
      path,
      maxResponseBytes: 32 * 1024 * 1024,
    });
    if (response.truncated || response.invalidUtf8) {
      return yield* new PipelineIssuesIncompleteError({ reason: "truncated" });
    }
    return response.body;
  });

  const listEligible = Effect.fn("PipelineGitHubIssues.listEligible")(function* () {
    const root = `repos/${REPOSITORY.owner}/${REPOSITORY.name}/issues`;
    const issues: Array<PipelineIssue> = [];
    for (let page = 1; ; page++) {
      const body = yield* get(
        `${root}?state=open&labels=${encodeURIComponent(ELIGIBLE_LABEL)}&per_page=${PAGE_SIZE}&page=${page}`,
      );
      const decoded = yield* decodeIssuePage(body);
      for (const issue of decoded) {
        if (issue.pull_request !== undefined) continue;
        issues.push(toIssue(issue));
      }
      if (decoded.length < PAGE_SIZE) return issues;
      if (page * PAGE_SIZE >= MAX_ITEMS) {
        return yield* new PipelineIssuesIncompleteError({ reason: "capped" });
      }
    }
  });

  const read = Effect.fn("PipelineGitHubIssues.read")(function* (number: number) {
    const body = yield* get(`repos/${REPOSITORY.owner}/${REPOSITORY.name}/issues/${number}`);
    const decoded = yield* decodeIssuePage(`[${body}]`);
    const issue = decoded[0];
    if (issue === undefined || issue.pull_request !== undefined) {
      return yield* new GitHubRequestPolicy.GitHubApiNotFoundError({
        host: HOST,
        operation: "pipelineIssues",
      });
    }
    return toIssue(issue);
  });

  const addLabel = Effect.fn("PipelineGitHubIssues.addLabel")(function* (
    number: number,
    label: string,
  ) {
    yield* rest.rest({
      host: HOST,
      operation: "pipelineIssues.addLabel",
      method: "POST",
      path: `repos/${REPOSITORY.owner}/${REPOSITORY.name}/issues/${number}/labels`,
      body: { labels: [label] },
    });
  });

  return PipelineGitHubIssues.of({ listEligible, read, addLabel });
});

export const layer = Layer.effect(PipelineGitHubIssues, make);

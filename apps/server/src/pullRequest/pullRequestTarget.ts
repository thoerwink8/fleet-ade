import {
  isRetiredSourceControlKind,
  type OrchestrationProjectShell,
  type SourceControlProviderKind,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";
import { normalizeThreadPullRequestKey } from "../sourceControl/threadPullRequests.ts";

export interface PullRequestTarget {
  readonly url?: string | undefined;
  readonly repository?: string | undefined;
  readonly number?: number | undefined;
  readonly host?: string | undefined;
}

export class PullRequestUrlInvalidError extends Schema.TaggedError<PullRequestUrlInvalidError>()(
  "PullRequestUrlInvalidError",
  {},
) {
  override get message(): string {
    return "这不是可识别的拉取请求地址。请改为传入仓库和编号。";
  }
}

export class PullRequestTargetIncompleteError extends Schema.TaggedError<PullRequestTargetIncompleteError>()(
  "PullRequestTargetIncompleteError",
  {},
) {
  override get message(): string {
    return "请传入 url，或同时传入仓库和编号。";
  }
}

export class PullRequestHostRequiredError extends Schema.TaggedError<PullRequestHostRequiredError>()(
  "PullRequestHostRequiredError",
  {},
) {
  override get message(): string {
    return "这个会话的项目没有可识别的远程。请传入托管方或 url。";
  }
}

export class PullRequestUrlUnavailableError extends Schema.TaggedError<PullRequestUrlUnavailableError>()(
  "PullRequestUrlUnavailableError",
  {},
) {
  override get message(): string {
    return "这个会话的项目所在托管方没有已知的拉取请求地址格式。请传入 url。";
  }
}

export type PullRequestTargetError =
  | PullRequestUrlInvalidError
  | PullRequestTargetIncompleteError
  | PullRequestHostRequiredError
  | PullRequestUrlUnavailableError;

export interface ResolvedTarget {
  readonly host: string;
  readonly repository: string;
  readonly number: number;
  readonly url: string;
}

function projectHostAndProvider(project: OrchestrationProjectShell | undefined): {
  readonly host: string | null;
  readonly kind: SourceControlProviderKind | null;
} {
  const identity = project?.repositoryIdentity;
  const kind = identity?.provider ?? null;
  if (!identity || kind === null) return { host: null, kind: null };
  return {
    host: sourceControlDefinitions.changeRequestHost(identity, kind),
    kind,
  };
}

export const resolveTarget = Effect.fn("PullRequestsToolkit.resolveTarget")(function* (
  input: PullRequestTarget,
  project: OrchestrationProjectShell | undefined,
) {
  if (input.url !== undefined) {
    const parsed = sourceControlDefinitions.parseChangeRequestUrl(input.url)?.link;
    if (parsed === undefined) {
      return yield* new PullRequestUrlInvalidError({});
    }
    return {
      ...normalizeThreadPullRequestKey(parsed),
      url: input.url,
    } satisfies ResolvedTarget;
  }
  if (input.repository === undefined || input.number === undefined) {
    return yield* new PullRequestTargetIncompleteError({});
  }
  const projectHost = projectHostAndProvider(project);
  const host = (input.host ?? projectHost.host)?.toLowerCase();
  if (host === undefined) {
    return yield* new PullRequestHostRequiredError({});
  }
  const repository = input.repository.toLowerCase();
  // Without a URL, a public forge host says what shape its change request URLs take;
  // any other host is taken to run the project's own forge.
  const recognizedKind = sourceControlDefinitions.recognizeRemote(
    `https://${host}/${repository}`,
  )?.kind;
  const kind =
    recognizedKind !== undefined && isRetiredSourceControlKind(recognizedKind)
      ? recognizedKind
      : (sourceControlDefinitions.findByPublicHost(host)?.kind ?? projectHost.kind);
  const url =
    kind === null
      ? null
      : sourceControlDefinitions.get(kind).changeRequestUrl({
          host,
          repository,
          number: input.number,
          remoteUrl: project?.repositoryIdentity?.locator.remoteUrl,
        });
  if (url === null) {
    return yield* new PullRequestUrlUnavailableError({});
  }
  return {
    ...normalizeThreadPullRequestKey({ host, repository, number: input.number, url }),
    url,
  } satisfies ResolvedTarget;
});

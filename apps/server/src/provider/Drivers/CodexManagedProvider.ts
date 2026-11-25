import {
  ProviderDriverKind,
  ProviderSetupError,
  TextGenerationError,
  type CodexSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Option from "effect/Option";
import { ChildProcessSpawner } from "effect/process";
import { classifyTextGenerationCliFailure } from "@t3tools/provider-core/server/textGenerationUtils";
import { makeCodexTextGeneration } from "../../textGeneration/CodexTextGeneration.ts";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { chatGptModels } from "../CodexChatGptModels.ts";
import { makeCodexManagedRuntime } from "../CodexManagedRuntime.ts";
import { ProviderDriverError } from "../Errors.ts";
import { createCodexAdapterV2 } from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import {
  checkCodexProviderStatus,
  makePendingCodexProvider,
  probeCodexSkillsForCwd,
} from "../CodexProvider.ts";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import {
  type ProviderDriverCreateInput,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import { codexContinuationIdentity } from "./CodexHomeLayout.ts";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import { HttpClient } from "effect/http";
const DRIVER = ProviderDriverKind.make("codex");
const isTextGenerationError = Schema.is(TextGenerationError);
const isProviderSetupError = Schema.is(ProviderSetupError);

export const makeManagedCodexProvider = Effect.fn("makeManagedCodexProvider")(function* (
  input: ProviderDriverCreateInput<CodexSettings>,
) {
  const { instanceId, enabled, displayName, accentColor, config } = input;
  const http = yield* HttpClient.HttpClient;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const host = yield* ProviderHost.ProviderHost;
  const runtime = yield* makeCodexManagedRuntime({
    instanceId,
    enabled,
    config,
    environment: yield* mergeProviderInstanceEnvironment(input.environment),
  });
  const continuationIdentity = codexContinuationIdentity(runtime.homeLayout);
  const stamp = withInstanceIdentity({
    instanceId,
    driverKind: DRIVER,
    displayName,
    accentColor,
    continuationGroupKey: continuationIdentity.continuationKey,
  });
  const setup = { canAuthenticate: true, canInstall: true };
  const runtimePaths = {
    homePath: runtime.homeLayout.sharedHomePath,
    shadowHomePath: runtime.homeLayout.mode === "authOverlay" ? runtime.homePath : null,
  };
  const pending = makePendingCodexProvider({ ...config, enabled, customModels: [] }).pipe(
    Effect.map((draft) =>
      stamp({
        ...draft,
        models: [],
        setup,
        runtimePaths,
      }),
    ),
  );
  const check = Effect.gen(function* () {
    const base = yield* pending;
    if (!enabled) return base;
    const executable = yield* runtime.installation.resolve().pipe(Effect.option);
    if (Option.isNone(executable))
      return {
        ...base,
        installed: false,
        models: [],
        message: "请先完成 Codex 的设置。",
        auth: { status: "unauthenticated" as const },
      };
    const saved = yield* runtime.auth.read.pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isSome(saved) && !saved.value.scopes.includes("chatgpt.tokens.use.direct"))
      return {
        ...base,
        installed: true,
        version: executable.value.version,
        models: [],
        message:
          "已使用 ChatGPT 登录，但 token 共享处于关闭状态。请重新登录并启用 token 共享，或改用其他智能体。",
        auth: {
          status: "unauthenticated" as const,
          label: "ChatGPT",
          ...(saved.value.email?.trim() ? { email: saved.value.email.trim() } : {}),
        },
      };
    if (Option.isNone(saved))
      return {
        ...base,
        installed: true,
        version: executable.value.version,
        models: [],
        message: "请使用 ChatGPT 登录以使用 Codex。",
        auth: { status: "unauthenticated" as const },
      };
    const usageLimits = {
      checkedAt: base.checkedAt,
      windows: [],
      unavailable: {
        reason: "unsupported" as const,
        message: "ChatGPT 会在已连接的应用之间统计订阅用量。请用连接到 Codex 的账号打开用量设置。",
      },
      externalUsage: { label: "ChatGPT 用量", url: "https://chatgpt.com/#settings/Usage" },
    };
    const managedAuth = {
      subscriptionSharing: true,
      profileId: saved.value.clientId,
      status: "authenticated" as const,
      type: "chatgpt",
      label: "ChatGPT",
      ...(saved.value.email?.trim() ? { email: saved.value.email.trim() } : {}),
    };
    return yield* runtime.auth.controller.withAccess!(runtime.resolve).pipe(
      Effect.flatMap((effective) =>
        Effect.gen(function* () {
          const draft = yield* checkCodexProviderStatus(
            effective.config,
            undefined,
            effective.environment,
            managedAuth,
          );
          const credentials = yield* runtime.auth.access;
          // Another server can replace the saved profile while the native probe runs.
          // Never send that account's token with the launch profile's catalog labels.
          if (
            (yield* runtime.auth.profileKey(credentials)) !== effective.revision ||
            (yield* runtime.auth.profileKey(saved.value)) !== effective.revision
          )
            return yield* new ProviderSetupError({
              instanceId,
              operation: "models",
              detail: "检查 Codex 时 ChatGPT 连接已改变。请重试。",
            });
          const models = yield* chatGptModels(credentials.accessToken, draft.models).pipe(
            Effect.provideService(HttpClient.HttpClient, http),
          );
          return { ...draft, models };
        }),
      ),
      Effect.map((draft) =>
        stamp({
          ...draft,
          auth: managedAuth,
          version: draft.version ?? executable.value.version,
          usageLimits,
          models: draft.models.map((model) => ({
            ...model,
            ...(model.capabilities
              ? {
                  capabilities: {
                    ...model.capabilities,
                    optionDescriptors: (model.capabilities.optionDescriptors ?? []).filter(
                      (option) => option.id !== "serviceTier",
                    ),
                  },
                }
              : {}),
          })),
          setup,
          runtimePaths,
          ...(draft.slashCommands
            ? {
                slashCommands: draft.slashCommands.filter((command) => command.name !== "feedback"),
              }
            : {}),
        }),
      ),
      Effect.catch(() =>
        runtime.auth.read.pipe(
          Effect.orElseSucceed(() => Option.none()),
          Effect.map((current) => ({
            ...base,
            installed: true,
            version: executable.value.version,
            models: [],
            auth: {
              status:
                Option.isSome(current) && current.value.scopes.includes("chatgpt.tokens.use.direct")
                  ? ("authenticated" as const)
                  : ("unauthenticated" as const),
              label: "ChatGPT",
              ...(Option.isSome(current) &&
              current.value.scopes.includes("chatgpt.tokens.use.direct")
                ? { subscriptionSharing: true, profileId: current.value.clientId }
                : {}),
              ...(Option.isSome(current) && current.value.email?.trim()
                ? { email: current.value.email.trim() }
                : {}),
            },
            ...(Option.isSome(current) && current.value.scopes.includes("chatgpt.tokens.use.direct")
              ? { usageLimits }
              : {}),
            message: "现在无法检查 Codex。请重试，或在智能体设置中重新连接。",
          })),
        ),
      ),
      Effect.scoped,
    );
  }).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.provideService(FileSystem.FileSystem, fileSystem),
    Effect.provideService(Path.Path, path),
  );
  const snapshot = yield* makeManagedServerProvider({
    resolveMaintenance: () => Effect.succeed({ provider: DRIVER, packageName: null, update: null }),
    getSettings: host.settings.get,
    streamSettings: host.settings.changes,
    haveSettingsChanged: () => false,
    initialSnapshot: () => pending,
    checkProvider: check,
  }).pipe(
    Effect.mapError(
      (cause) =>
        new ProviderDriverError({
          driver: DRIVER,
          instanceId,
          detail: "无法准备托管的 Codex。",
          cause,
        }),
    ),
  );
  yield* runtime.auth.controller.subscribe("managed-codex-snapshot").pipe(
    Stream.filter((state) => ["idle", "succeeded", "failed", "cancelled"].includes(state.phase)),
    // Sign-out interrupts in-flight probes; keep listening for its subsequent idle refresh.
    Stream.runForEach(() => snapshot.refresh.pipe(Effect.ignoreCause({ log: true }))),
    Effect.forkScoped,
  );
  const resolveRuntime = runtime.auth.controller.withAccess!(runtime.resolve);
  // Launch settings bind the refresh command to the signed-in profile. The registry
  // already wraps openSession in withAccess, so resolve without re-entering it.
  const models = snapshot.getSnapshot.pipe(Effect.map((value) => value.models));
  const orchestrationAdapter = yield* createCodexAdapterV2(input, {
    onUsageLimits: (update) => snapshot.applyUsageLimits(update),
    models,
    resolveRuntime: runtime.resolve,
  }).pipe(
    Effect.mapError(
      (cause) =>
        new ProviderDriverError({
          driver: DRIVER,
          instanceId,
          detail: "无法构建 Codex 编排适配器。",
          cause,
        }),
    ),
  );
  const nativeGeneration = yield* makeCodexTextGeneration(
    config,
    undefined,
    models,
    resolveRuntime,
  );
  const protect = <A>(operation: string, effect: Effect.Effect<A, TextGenerationError>) =>
    runtime.auth.controller.withAccess!(effect).pipe(
      Effect.scoped,
      Effect.mapError((cause) => {
        if (isTextGenerationError(cause)) {
          return cause;
        }
        const detail = "detail" in cause ? cause.detail : "Codex 文本生成失败。";
        const reason = isProviderSetupError(cause)
          ? cause.operation === "install"
            ? "not_installed"
            : cause.operation === "runtime"
              ? "unavailable"
              : classifyTextGenerationCliFailure(detail)
          : classifyTextGenerationCliFailure(detail);
        return new TextGenerationError({
          operation,
          detail,
          ...(reason ? { reason } : {}),
        });
      }),
    );
  const generatePlainText = nativeGeneration.generatePlainText;
  const textGeneration: ProviderInstance["textGeneration"] = {
    generateCommitMessage: (value) =>
      protect("generateCommitMessage", nativeGeneration.generateCommitMessage(value)),
    generatePrContent: (value) =>
      protect("generatePrContent", nativeGeneration.generatePrContent(value)),
    generateBranchName: (value) =>
      protect("generateBranchName", nativeGeneration.generateBranchName(value)),
    generateThreadTitle: (value) =>
      protect("generateThreadTitle", nativeGeneration.generateThreadTitle(value)),
    ...(generatePlainText === undefined
      ? {}
      : {
          generatePlainText: (value) => protect("generatePlainText", generatePlainText(value)),
        }),
  };
  return {
    instanceId,
    driverKind: DRIVER,
    continuationIdentity,
    displayName,
    accentColor,
    enabled,
    snapshot,
    orchestrationAdapter,
    textGeneration,
    auth: runtime.auth.controller,
    snapshotForCwd: (cwd: string) =>
      enabled
        ? resolveRuntime.pipe(
            Effect.matchEffect({
              // Signed-out snapshots have an empty inventory; a signed-in runtime failure must fail the scan.
              onFailure: (cause) =>
                snapshot.getSnapshot.pipe(
                  Effect.filterOrFail(
                    (machine) => machine.auth.status === "unauthenticated",
                    () => cause,
                  ),
                ),
              onSuccess: (effective) =>
                probeCodexSkillsForCwd({
                  binaryPath: effective.config.binaryPath,
                  homePath: effective.config.homePath,
                  launchArgs: effective.config.launchArgs,
                  cwd,
                  environment: effective.environment,
                }).pipe(
                  Effect.flatMap((skills) =>
                    snapshot.getSnapshot.pipe(Effect.map((draft) => ({ ...draft, skills }))),
                  ),
                ),
            }),
            Effect.scoped,
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            // Fail instead of returning machine inventory, which the registry would publish as workspace inventory.
            Effect.mapError(
              (cause) =>
                new ProviderDriverError({
                  driver: DRIVER,
                  instanceId,
                  detail: `无法探测 '${cwd}' 的 Codex 技能`,
                  cause,
                }),
            ),
          )
        : snapshot.getSnapshot,
  } satisfies ProviderInstance;
});

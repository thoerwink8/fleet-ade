/**
 * managedLimits - what `limits.clients` and `limits.connect` in the managed policy allow, and the
 * one error every refusal uses so each transport can show the administrator's organization.
 *
 * @module managedLimits
 */
import type {
  ManagedPolicyClient,
  ManagedPolicyDocument,
  ServerAuthPolicy,
} from "@t3tools/contracts";
import {
  disableTailscaleServe,
  disableTailscaleServeTcp,
  readTailscaleServeRoutesTo,
  tailscaleServeOffArgs,
  readTailscaleStatus,
  type TailscaleServeRoute,
  type TailscaleStderrDiagnostic,
} from "@t3tools/tailscale";
import * as Effect from "effect/Effect";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import * as NetService from "@t3tools/shared/Net";

import { loopbackBindAddress } from "../auth/utils.ts";

type PolicyDocument = { readonly document: ManagedPolicyDocument | undefined };

export class ManagedPolicyRefusedError extends Schema.TaggedError<ManagedPolicyRefusedError>()(
  "ManagedPolicyRefusedError",
  {
    organization: Schema.String,
    /** What the policy does not allow, for example "T3 Connect". */
    action: Schema.String,
    /** What that means for this request, for example "so the server cannot listen on 0.0.0.0". */
    detail: Schema.optionalKey(Schema.String),
  },
) {
  override get message(): string {
    return `${this.organization} 的策略不允许${this.action}${this.detail === undefined ? "" : `，${this.detail}`}。`;
  }
}

const CLIENT_AUTH_POLICY: Record<ManagedPolicyClient, ServerAuthPolicy> = {
  desktop: "desktop-managed-local",
  "local-browser": "loopback-browser",
  remote: "remote-reachable",
};

const AUTH_POLICY_ACTION: Record<ServerAuthPolicy, string> = {
  "desktop-managed-local": "使用桌面应用",
  "loopback-browser": "本机浏览器访问",
  "remote-reachable": "远程客户端访问",
  "unsafe-no-auth": "无认证运行",
};

/** Whether the server may run with `authPolicy`. Any policy file rules out `unsafe-no-auth`. */
export function allowsAuthPolicy(policy: PolicyDocument, authPolicy: ServerAuthPolicy): boolean {
  if (policy.document === undefined) return true;
  if (authPolicy === "unsafe-no-auth") return false;
  const clients = policy.document.limits?.clients;
  return (
    clients === undefined || clients.some((client) => CLIENT_AUTH_POLICY[client] === authPolicy)
  );
}

/** Whether anything off this machine may pair, by LAN, Tailscale, or a minted link. */
export const allowsRemoteClients = (policy: PolicyDocument) =>
  allowsAuthPolicy(policy, "remote-reachable");

/** T3 Connect is a way for remote clients in, so a policy without `remote` turns it off too. */
export const allowsConnect = (policy: PolicyDocument) =>
  policy.document?.limits?.connect !== false && allowsRemoteClients(policy);

const refuse = (policy: PolicyDocument, action: string, detail?: string) =>
  new ManagedPolicyRefusedError({
    organization: policy.document?.organization ?? "你的组织",
    action,
    ...(detail === undefined ? {} : { detail }),
  });

export const refuseConnect = (policy: PolicyDocument) => refuse(policy, "T3 Connect");

// Node throws ENOTDIR, outside the spawner's error mapping, when PATH ends in a file.
const isMissingCli = (cause: unknown) =>
  (PlatformError.isPlatformError(cause) && cause.reason._tag === "NotFound") ||
  (cause instanceof Error && "code" in cause && cause.code === "ENOTDIR");

const NOTHING_FORWARDED: ReadonlyArray<TailscaleServeRoute> = [];

/** Tailscale answers that leave nothing forwarding here right now. */
const NOTHING_TO_CLOSE: ReadonlySet<TailscaleStderrDiagnostic | undefined> = new Set([
  "not-running",
  "not-logged-in",
]);

/**
 * Turns off the Tailscale Serve routes that forward to the server at `target`, such as one
 * `t3 pair --tailscale` left from before the policy, and keeps every other route. Runs before the
 * server binds, and fails unless a fresh read shows no route here, since `off` can exit 0 and
 * leave it. Without the CLI, or with Tailscale down or logged out, nothing forwards.
 */
export const closeTailscaleServeTo = Effect.fn("managedLimits.closeTailscaleServeTo")(function* (
  policy: PolicyDocument,
  target: { readonly host: string; readonly port: number },
) {
  if (allowsRemoteClients(policy)) return;
  // Another app holds the port, so its routes are not ours to remove. It could let go before the
  // bind, which would then take over those routes, so the server does not start.
  if (!(yield* (yield* NetService.NetService).canListenOnHost(target.port, target.host))) {
    return yield* refuseRemoteClients(
      policy,
      `因此服务器不会启动：无法绑定 ${target.host}:${target.port}；若其他应用占用该端口，服务器会接管它的 Tailscale Serve 路由`,
    );
  }
  const readRoutes = readTailscaleServeRoutesTo(target).pipe(
    Effect.catchTags({
      // Only a CLI that is not there; one that will not run might still front a daemon.
      TailscaleCommandSpawnError: (error) =>
        isMissingCli(error.cause) ? Effect.succeed(NOTHING_FORWARDED) : Effect.fail(error),
      TailscaleCommandExitError: (error) =>
        NOTHING_TO_CLOSE.has(error.stderrDiagnostic)
          ? Effect.succeed(NOTHING_FORWARDED)
          : Effect.fail(error),
    }),
    // Tailscale errors carry only labelled diagnostics, never raw stderr, so they are safe to log.
    Effect.tapError((cause) =>
      Effect.logWarning("Tailscale Serve could not be checked", { cause }),
    ),
    Effect.mapError((error) =>
      refuseRemoteClients(
        policy,
        error._tag === "TailscaleCommandTimeoutError"
          ? // Seen on a Mac where Tailscale is installed but was never set up.
            "因此服务器不会启动：需先确认 Tailscale Serve 状态，但 Tailscale 没有应答；请打开 Tailscale 完成设置，或移除它"
          : "因此服务器不会启动：需先确认 Tailscale Serve 状态",
      ),
    ),
  );
  const found = yield* readRoutes;
  if (found.length === 0) return;
  // `off` acts on the machine's current name, so a web route under a former name stays.
  const currentName = found.some((route) => route.mount !== undefined && route.owner === undefined)
    ? yield* readTailscaleStatus.pipe(
        Effect.map((status) => status.magicDnsName?.toLowerCase() ?? null),
        Effect.orElseSucceed(() => null),
      )
    : null;
  const formerName = (route: TailscaleServeRoute) =>
    route.owner === undefined &&
    route.host !== undefined &&
    currentName !== null &&
    route.host.toLowerCase() !== currentName;
  // A Service is shared across the tailnet, and a foreground route lives as long as its command.
  const removable = (route: TailscaleServeRoute) =>
    route.owner === undefined &&
    route.ambiguous === undefined &&
    (route.mount === undefined || (currentName !== null && !formerName(route)));
  for (const route of found.filter(removable)) {
    yield* (
      route.mount === undefined
        ? disableTailscaleServeTcp(route.servePort)
        : disableTailscaleServe(route)
    ).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Tailscale Serve route could not be turned off", { ...route, cause }),
      ),
    );
  }
  const left = yield* readRoutes;
  if (left.length > 0) {
    const describe = (route: TailscaleServeRoute) => {
      const where = `端口 ${route.servePort}${route.mount === undefined ? "" : ` 路径 ${route.mount}`}`;
      const off = tailscaleServeOffArgs(route);
      if (off === undefined) return `${where}；请停止运行它的 "tailscale serve" 命令`;
      if (formerName(route)) {
        return `${where}，位于 ${route.host}（此机器的旧名称），"tailscale serve ... off" 无法触及；请运行 "tailscale serve reset" 并重新设置其他路由`;
      }
      const command = `"tailscale ${off.join(" ")}"`;
      if (currentName === null && route.owner === undefined && route.host !== undefined) {
        return `${where}，位于 ${route.host}；若那是此机器的当前名称，用 ${command} 关闭它`;
      }
      return route.ambiguous !== undefined
        ? `${where}，其目标 ${route.ambiguous} 可能是此端口上的其他服务；请检查后用 ${command} 关闭它`
        : `${where}；用 ${command} 关闭它`;
    };
    return yield* refuseRemoteClients(
      policy,
      `因此服务器不会启动：Tailscale Serve 仍转发 ${left.map(describe).join(" 和 ")}`,
    );
  }
  yield* Effect.logInfo("Turned off Tailscale Serve the managed policy does not allow", {
    routes: found,
  });
});

export const refuseRemoteClients = (policy: PolicyDocument, detail?: string) =>
  refuse(policy, AUTH_POLICY_ACTION["remote-reachable"], detail);

/**
 * Fails when the server would accept clients the policy leaves out; otherwise returns the address
 * to bind. Runs before the server binds, so a refused configuration never listens, not even
 * briefly. Without `remote` that address is the loopback literal the check approved, never a name.
 */
export const checkServerReachability = Effect.fn("managedLimits.checkServerReachability")(
  function* (
    policy: PolicyDocument,
    input: {
      readonly authPolicy: ServerAuthPolicy;
      readonly host: string | undefined;
      readonly tailscaleServeEnabled: boolean;
      /** The background service chose `host` to reach private networks; the user did not. */
      readonly privateNetworkOnly?: boolean | undefined;
    },
  ) {
    const cannotListen = () =>
      refuseRemoteClients(
        policy,
        input.privateNetworkOnly === true
          ? "因此后台服务不能在私有网络上监听；请在其 service.env 中设置 T3CODE_HOST=127.0.0.1"
          : `因此服务器不能在 ${input.host === "" ? "所有接口" : (input.host ?? "此主机")} 上监听`,
      );
    if (!allowsAuthPolicy(policy, input.authPolicy)) {
      return yield* input.authPolicy === "remote-reachable"
        ? cannotListen()
        : refuse(policy, AUTH_POLICY_ACTION[input.authPolicy]);
    }
    if (allowsRemoteClients(policy)) return input.host ?? "127.0.0.1";
    if (input.tailscaleServeEnabled) {
      return yield* refuseRemoteClients(policy, "因此不能开启 Tailscale Serve");
    }
    return loopbackBindAddress(input.host) ?? (yield* cannotListen());
  },
);

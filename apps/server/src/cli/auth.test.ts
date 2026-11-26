import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { AuthAccessWriteScope, AuthSessionId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HttpClient, HttpClientResponse } from "effect/http";

import type * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import {
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
  registerInProcessOwner,
} from "../serverRuntimeState.ts";
import { revokeSessionLiveOrOffline } from "./auth.ts";

it.effect(
  "revokeSessionLiveOrOffline revokes through the live server when running and cleans up its temporary CLI session",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cli-auth-" });
      const statePath = path.join(dir, "server.runtime.json");

      const state = yield* makePersistedServerRuntimeState({
        config: {
          host: "192.0.2.2",
          privateNetworkOnly: false,
          devUrl: undefined,
        },
        port: 3773,
      });
      // The fixture stands in for this same process owning the home, the binding a real server
      // gets from acquireServerOwnership: a defined ownerId with a registered owner.
      yield* registerInProcessOwner(statePath, "4ec9f94a-0000-4000-8000-000000000000");
      yield* persistServerRuntimeState({
        path: statePath,
        state: { ...state, ownerId: "4ec9f94a-0000-4000-8000-000000000000" },
      });

      const revokedOffline: Array<AuthSessionId> = [];
      const liveRequests: Array<{
        readonly url: string;
        readonly authHeader: string | undefined;
        readonly body: string;
      }> = [];

      const environmentAuth = {
        issueSession: (input: { readonly scopes?: ReadonlyArray<string> }) =>
          Effect.map(DateTime.now, (now) => {
            assert.deepEqual(input.scopes, [AuthAccessWriteScope]);
            return {
              sessionId: AuthSessionId.make("cli-temp-session"),
              token: "cli-temp-token",
              method: "bearer-access-token" as const,
              scopes: [AuthAccessWriteScope],
              subject: "cli-issued-session",
              client: { label: "t3 auth cli", deviceType: "unknown" as const },
              expiresAt: DateTime.toUtc(now),
            };
          }),
        revokeSession: (sessionId: AuthSessionId) =>
          Effect.sync(() => {
            revokedOffline.push(sessionId);
            return true;
          }),
      } as unknown as EnvironmentAuth.EnvironmentAuth["Service"];

      const httpClientLayer = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => {
            const bodyText =
              request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
            liveRequests.push({
              url: request.url,
              authHeader: request.headers.authorization,
              body: bodyText,
            });
            return HttpClientResponse.fromWeb(
              request,
              new Response(JSON.stringify({ revoked: true }), {
                status: 200,
                headers: { "content-type": "application/json" },
              }),
            );
          }),
        ),
      );

      const targetSessionId = AuthSessionId.make("paired-remote-session");
      const revoked = yield* revokeSessionLiveOrOffline(
        environmentAuth,
        { serverRuntimeStatePath: statePath },
        targetSessionId,
      ).pipe(Effect.provide(httpClientLayer));

      assert.equal(revoked, true);
      assert.equal(liveRequests.length, 1);
      assert.equal(liveRequests[0]?.url, "http://192.0.2.2:3773/api/auth/clients/revoke");
      assert.equal(liveRequests[0]?.authHeader, "Bearer cli-temp-token");
      assert.deepEqual(JSON.parse(liveRequests[0]?.body ?? "{}"), {
        sessionId: "paired-remote-session",
      });
      assert.deepEqual(revokedOffline, [AuthSessionId.make("cli-temp-session")]);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "revokeSessionLiveOrOffline falls back to offline database revocation when no live server is recorded",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cli-auth-offline-" });
      const statePath = path.join(dir, "missing.runtime.json");

      const revokedOffline: Array<AuthSessionId> = [];
      const environmentAuth = {
        revokeSession: (sessionId: AuthSessionId) =>
          Effect.sync(() => {
            revokedOffline.push(sessionId);
            return true;
          }),
      } as unknown as EnvironmentAuth.EnvironmentAuth["Service"];

      const httpClientLayer = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 500 }))),
        ),
      );

      const targetSessionId = AuthSessionId.make("offline-session");
      const revoked = yield* revokeSessionLiveOrOffline(
        environmentAuth,
        { serverRuntimeStatePath: statePath },
        targetSessionId,
      ).pipe(Effect.provide(httpClientLayer));

      assert.equal(revoked, true);
      assert.deepEqual(revokedOffline, [targetSessionId]);
    }).pipe(Effect.provide(NodeServices.layer)),
);

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthTokenExchangeGrantType,
  AuthEnvironmentBootstrapTokenType,
  AuthAccessTokenType,
  EnvironmentAuthInvalidError,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Duration from "effect/Duration";
import * as TestClock from "effect/testing/TestClock";
import * as Clock from "effect/Clock";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpRouter from "effect/http/HttpRouter";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as AuthHttp from "./http.ts";

const DEV_TOKEN = "reusable-dev-auth-token-that-is-long-enough";
class AuthTestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.auth) {}

const layerConfig = Layer.effect(
  ServerConfig.ServerConfig,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    return {
      ...config,
      mode: "web",
      devUrl: new URL("http://127.0.0.1:5173"),
      devAuthToken: Redacted.make(DEV_TOKEN),
    } satisfies ServerConfig.ServerConfig["Service"];
  }),
).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-auth-http-test-" })));

const layerEnvironmentAuth = EnvironmentAuth.layer.pipe(
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ServerEnvironment.layerIdentity),
  Layer.provide(layerConfig),
);
const layerRoutes = HttpApiBuilder.layer(AuthTestApi).pipe(
  Layer.provide(AuthHttp.layer),
  Layer.provide(AuthHttp.layerAuthenticatedAuth),
  Layer.provideMerge(layerEnvironmentAuth),
  Layer.provide(layerConfig),
  Layer.provideMerge(
    HttpPlatform.layer.pipe(
      Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      Layer.provideMerge(Etag.layerWeak),
    ),
  ),
  Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const postJson = (path: string, body: unknown, headers?: Readonly<Record<string, string>>) =>
  new Request(`http://127.0.0.1${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: encodeJson(body),
  });

it.effect("sets the selected browser session cookies through the HTTP route", () =>
  Effect.gen(function* () {
    const random = yield* SecureRandom.SecureRandom;
    const unusedSecretStore = ServerSecretStore.ServerSecretStore.of({
      get: () => Effect.succeedNone,
      set: () => Effect.void,
      create: () => Effect.void,
      getOrCreateRandom: () => Effect.die("Not used by these routes."),
      remove: () => Effect.void,
    });
    const requestContext = Context.make(SecureRandom.SecureRandom, random).pipe(
      Context.add(ServerSecretStore.ServerSecretStore, unusedSecretStore),
    );
    return yield* Effect.acquireUseRelease(
      Effect.sync(
        () =>
          [
            HttpRouter.toWebHandler(layerRoutes, { disableLogger: true }),
            HttpRouter.toWebHandler(layerRoutes, { disableLogger: true }),
          ] as const,
      ),
      ([environmentA, environmentB]) =>
        Effect.promise(async () => {
          const devResponse = await environmentA.handler(
            postJson("/api/auth/browser-session", { credential: DEV_TOKEN }),
            requestContext,
          );
          expect(devResponse.status).toBe(200);
          const retiredScopeResponse = await environmentA.handler(
            new Request("http://127.0.0.1/oauth/token", {
              method: "POST",
              body: new URLSearchParams({
                grant_type: AuthTokenExchangeGrantType,
                subject_token: DEV_TOKEN,
                subject_token_type: AuthEnvironmentBootstrapTokenType,
                requested_token_type: AuthAccessTokenType,
                scope: "review:write",
              }),
            }),
            requestContext,
          );
          expect(retiredScopeResponse.status).toBe(400);
          expect(await retiredScopeResponse.json()).toMatchObject({ reason: "invalid_scope" });

          const devCookies = devResponse.headers.getSetCookie();
          const devCookie = devCookies.find((cookie) => cookie.startsWith("t3_dev_session_"));
          expect(devCookie).toContain("HttpOnly");
          expect(devCookie).toContain(`=${DEV_TOKEN};`);
          expect(devCookies).toContainEqual(
            expect.stringMatching(/^t3_session_[^=]*=;.*Max-Age=0/),
          );
          const devCookieHeader = devCookie?.split(";", 1)[0] ?? "";
          const environmentBSession = await environmentB.handler(
            new Request("http://127.0.0.1/api/auth/session", {
              headers: { cookie: devCookieHeader },
            }),
            requestContext,
          );
          expect(environmentBSession.status).toBe(200);
          expect(await environmentBSession.json()).toMatchObject({ authenticated: true });

          const pairingResponse = await environmentA.handler(
            postJson(
              "/api/auth/pairing-token",
              { scopes: ["orchestration:read"] },
              { cookie: devCookieHeader },
            ),
            requestContext,
          );
          expect(pairingResponse.status).toBe(200);
          const pairing = (await pairingResponse.json()) as { credential: string };
          const restrictedResponse = await environmentA.handler(
            postJson("/api/auth/browser-session", { credential: pairing.credential }),
            requestContext,
          );
          expect(restrictedResponse.status).toBe(200);
          const restrictedCookies = restrictedResponse.headers.getSetCookie();
          expect(restrictedCookies).toHaveLength(1);
          expect(restrictedCookies[0]).toMatch(/^t3_session_/);
          expect(restrictedCookies[0]).not.toContain("t3_dev_session_");
        }),
      ([environmentA, environmentB]) =>
        Effect.promise(() => Promise.all([environmentA.dispose(), environmentB.dispose()])),
    );
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect.each(["DPoP", "dpop"])("challenges a refused %s request with DPoP", (scheme) =>
  Effect.gen(function* () {
    const random = yield* SecureRandom.SecureRandom;
    const unusedSecretStore = ServerSecretStore.ServerSecretStore.of({
      get: () => Effect.succeedNone,
      set: () => Effect.void,
      create: () => Effect.void,
      getOrCreateRandom: () => Effect.die("Not used by these routes."),
      remove: () => Effect.void,
    });
    const requestContext = Context.make(SecureRandom.SecureRandom, random).pipe(
      Context.add(ServerSecretStore.ServerSecretStore, unusedSecretStore),
    );
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => HttpRouter.toWebHandler(layerRoutes, { disableLogger: true })),
      (environment) =>
        Effect.promise(async () => {
          const refused = await environment.handler(
            postJson(
              "/api/auth/pairing-token",
              { scopes: ["orchestration:read"] },
              { authorization: `${scheme} not-a-valid-token` },
            ),
            requestContext,
          );
          expect(refused.status).toBe(401);
          expect(refused.headers.get("www-authenticate")).toBe("DPoP");
        }),
      (environment) => Effect.promise(() => environment.dispose()),
    );
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect("does not route a retired guest redeem", () =>
  Effect.gen(function* () {
    const random = yield* SecureRandom.SecureRandom;
    const unusedSecretStore = ServerSecretStore.ServerSecretStore.of({
      get: () => Effect.succeedNone,
      set: () => Effect.void,
      create: () => Effect.void,
      getOrCreateRandom: () => Effect.die("Not used by these routes."),
      remove: () => Effect.void,
    });
    const requestContext = Context.make(SecureRandom.SecureRandom, random).pipe(
      Context.add(ServerSecretStore.ServerSecretStore, unusedSecretStore),
    );
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => HttpRouter.toWebHandler(layerRoutes, { disableLogger: true })),
      (environment) =>
        Effect.promise(async () => {
          const response = await environment.handler(
            postJson("/api/guest/redeem", { token: "retired" }),
            requestContext,
          );
          expect(response.status).toBe(404);
        }),
      (environment) => Effect.promise(() => environment.dispose()),
    );
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

const decodeAuthInvalid = Schema.decodeSync(Schema.fromJsonString(EnvironmentAuthInvalidError));

const postTokenExchange = (subjectToken: string) =>
  new Request("http://127.0.0.1/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: AuthTokenExchangeGrantType,
      subject_token: subjectToken,
      subject_token_type: AuthEnvironmentBootstrapTokenType,
      requested_token_type: AuthAccessTokenType,
    }),
  });

it.effect.each([{ endpoint: "browser-session" }, { endpoint: "oauth-token" }])(
  "reports pairing credential failure reasons on the $endpoint route",
  ({ endpoint }) =>
    Effect.gen(function* () {
      const random = yield* SecureRandom.SecureRandom;
      const unusedSecretStore = ServerSecretStore.ServerSecretStore.of({
        get: () => Effect.succeedNone,
        set: () => Effect.void,
        create: () => Effect.void,
        getOrCreateRandom: () => Effect.die("Not used by these routes."),
        remove: () => Effect.void,
      });
      const requestContext = Context.make(SecureRandom.SecureRandom, random).pipe(
        Context.add(ServerSecretStore.ServerSecretStore, unusedSecretStore),
      );
      return yield* Effect.acquireUseRelease(
        Effect.gen(function* () {
          let service: EnvironmentAuth.EnvironmentAuth["Service"] | undefined;
          const testClockContext = yield* Layer.build(TestClock.layer());
          const testClock = Context.get(testClockContext, Clock.Clock) as TestClock.TestClock;
          const routes = Layer.mergeAll(
            Layer.effectDiscard(
              EnvironmentAuth.EnvironmentAuth.pipe(
                Effect.tap((auth) => Effect.sync(() => (service = auth))),
              ),
            ),
            HttpApiBuilder.layer(AuthTestApi).pipe(
              Layer.provide(AuthHttp.layer),
              Layer.provide(AuthHttp.layerAuthenticatedAuth),
            ),
          ).pipe(
            Layer.provideMerge(layerEnvironmentAuth),
            Layer.provide(layerConfig),
            Layer.provideMerge(
              HttpPlatform.layer.pipe(
                Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
                Layer.provideMerge(Etag.layerWeak),
              ),
            ),
            Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
            Layer.provide(Layer.succeedContext(testClockContext)),
          );
          const web = HttpRouter.toWebHandler(routes, { disableLogger: true });
          return { web, auth: () => service!, testClock };
        }),
        ({ web, auth, testClock }) =>
          Effect.gen(function* () {
            const exchange = (credential: string) =>
              endpoint === "browser-session"
                ? Effect.promise(() =>
                    web.handler(
                      postJson("/api/auth/browser-session", { credential }),
                      requestContext,
                    ),
                  )
                : Effect.promise(() => web.handler(postTokenExchange(credential), requestContext));
            // Routes build lazily; one request materializes the captured auth service.
            yield* Effect.promise(() =>
              web.handler(new Request("http://127.0.0.1/api/auth/session"), requestContext),
            );
            const validCredential = yield* auth().issuePairingCredential();
            const valid = yield* exchange(validCredential.credential);
            expect(valid.status).toBe(200);
            const body = yield* Effect.promise(() => valid.json());
            if (endpoint === "browser-session") {
              expect(body).toMatchObject({ authenticated: true });
            } else {
              expect(body).toMatchObject({
                access_token: expect.any(String),
                issued_token_type: AuthAccessTokenType,
              });
            }

            // Missing and revoked stay indistinguishable: both report "invalid".
            const missing = yield* exchange("C8VNM2KLPW3R");
            expect(missing.status).toBe(401);
            expect(decodeAuthInvalid(yield* Effect.promise(() => missing.text()))).toMatchObject({
              reason: "invalid_credential",
              credentialFailureReason: "invalid",
            });

            const revoked = yield* Effect.gen(function* () {
              const issued = yield* auth().issuePairingCredential();
              yield* auth().revokePairingLink(issued.id);
              return yield* exchange(issued.credential);
            });
            expect(revoked.status).toBe(401);
            expect(decodeAuthInvalid(yield* Effect.promise(() => revoked.text()))).toMatchObject({
              reason: "invalid_credential",
              credentialFailureReason: "invalid",
            });

            const consumed = yield* Effect.gen(function* () {
              const issued = yield* auth().issuePairingCredential();
              yield* auth().exchangeBootstrapCredentialForAccessToken(
                issued.credential,
                undefined,
                { deviceType: "bot" },
              );
              return yield* exchange(issued.credential);
            });
            expect(consumed.status).toBe(401);
            expect(decodeAuthInvalid(yield* Effect.promise(() => consumed.text()))).toMatchObject({
              reason: "invalid_credential",
              credentialFailureReason: "consumed",
            });

            const expired = yield* Effect.gen(function* () {
              const issued = yield* auth().issuePairingCredential();
              yield* testClock.adjust(Duration.minutes(6));
              return yield* exchange(issued.credential);
            });
            expect(expired.status).toBe(401);
            expect(decodeAuthInvalid(yield* Effect.promise(() => expired.text()))).toMatchObject({
              reason: "invalid_credential",
              credentialFailureReason: "expired",
            });
          }),
        ({ web }) => Effect.promise(() => web.dispose()),
      );
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

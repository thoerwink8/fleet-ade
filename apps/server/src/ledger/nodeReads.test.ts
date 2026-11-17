// The node token is only stored as a sha256, the same way the ledger checks it.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { AuthOrchestrationReadScope, AuthSessionId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import { HttpRouter } from "effect/http";
import * as SqlClient from "effect/sql/SqlClient";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as NodeReads from "./nodeReads.ts";

const TOKEN = "ledger-test-token";
const TOKEN_HASH = NodeCrypto.createHash("sha256").update(TOKEN).digest("hex");

const withWeb = <A, E, R>(
  gate: { readonly login: boolean; readonly nowMillis: () => number },
  use: (
    handler: (request: Request) => Promise<Response>,
    sql: SqlClient.SqlClient,
  ) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* NodeReads.migrate;
    yield* sql`INSERT INTO node_keys (node_id, token_hash) VALUES ('test-node', ${TOKEN_HASH})`;
    const web = yield* Effect.sync(() =>
      HttpRouter.toWebHandler(
        NodeReads.layerFor(sql, gate).pipe(
          Layer.provideMerge(
            HttpPlatform.layer.pipe(
              Layer.provideMerge(NodeServices.layer),
              Layer.provideMerge(Etag.layerWeak),
            ),
          ),
          Layer.provideMerge(NodeServices.layer),
        ),
        { disableLogger: true },
      ),
    );
    return yield* Effect.acquireUseRelease(
      Effect.succeed(web),
      (value) => use(value.handler, sql),
      (value) => Effect.promise(() => value.dispose()),
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" })));

const send = (
  handler: (request: Request) => Promise<Response>,
  method: "GET" | "POST",
  path: string,
  options?: {
    readonly body?: unknown;
    readonly credential?: string | null;
    readonly session?: string;
  },
) =>
  Effect.promise(() =>
    handler(
      new Request(`http://127.0.0.1${path}`, {
        method,
        headers: {
          ...(options?.body === undefined ? {} : { "content-type": "application/json" }),
          ...(options?.credential ? { "X-Fleet-Node-Token": options.credential } : {}),
          ...(options?.session ? { authorization: `Bearer ${options.session}` } : {}),
        },
        ...(options?.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      }),
    ),
  );

const json = <A>(response: Response) => Effect.promise(() => response.json() as Promise<A>);

const fixedClock = (start = 0) => {
  let now = start;
  return {
    nowMillis: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
};

it.effect("同一 nodeId 两次 report，读口只剩后一次的 payload", () => {
  const clock = fixedClock();
  return withWeb({ login: true, nowMillis: clock.nowMillis }, (handler, sql) =>
    Effect.gen(function* () {
      expect(
        (yield* send(handler, "POST", "/api/nodes/report", {
          body: { marker: "first" },
          credential: TOKEN,
        })).status,
      ).toBe(200);
      clock.advance(21_000);
      expect(
        (yield* send(handler, "POST", "/api/nodes/report", {
          body: { marker: "second" },
          credential: TOKEN,
        })).status,
      ).toBe(200);
      expect(
        yield* json<{ id: string; payload: { marker: string } }>(
          yield* send(handler, "GET", "/api/nodes/test-node"),
        ),
      ).toEqual({ id: "test-node", payload: { marker: "second" } });
      expect(yield* sql<{ readonly payload: string }>`SELECT payload FROM node_reports`).toEqual([
        { payload: JSON.stringify({ marker: "second" }) },
      ]);
    }),
  );
});

it.effect("距第一次不足 20 秒的第二次 report 是 429，行仍是第一次", () => {
  const clock = fixedClock();
  return withWeb({ login: false, nowMillis: clock.nowMillis }, (handler, sql) =>
    Effect.gen(function* () {
      expect(
        (yield* send(handler, "POST", "/api/nodes/report", {
          body: { marker: "first" },
          credential: TOKEN,
        })).status,
      ).toBe(200);
      const again = yield* send(handler, "POST", "/api/nodes/report", {
        body: { marker: "second" },
        credential: TOKEN,
      });
      expect(again.status).toBe(429);
      expect(again.headers.get("retry-after")).toBe("20");
      expect(yield* sql<{ readonly payload: string }>`SELECT payload FROM node_reports`).toEqual([
        { payload: JSON.stringify({ marker: "first" }) },
      ]);
    }),
  );
});

it.effect("report 刚写过，sessions 仍能写成功（两个 20 秒槽分开）", () => {
  const clock = fixedClock();
  return withWeb({ login: true, nowMillis: clock.nowMillis }, (handler, sql) =>
    Effect.gen(function* () {
      expect(
        (yield* send(handler, "POST", "/api/nodes/report", {
          body: { marker: "report" },
          credential: TOKEN,
        })).status,
      ).toBe(200);
      expect(
        (yield* send(handler, "POST", "/api/nodes/sessions", {
          body: { marker: "sessions" },
          credential: TOKEN,
        })).status,
      ).toBe(200);
      expect(
        yield* json<{ nodes: ReadonlyArray<{ id: string; payload: { marker: string } | null }> }>(
          yield* send(handler, "GET", "/api/nodes/sessions"),
        ),
      ).toEqual({ nodes: [{ id: "test-node", payload: { marker: "sessions" } }] });
      expect(yield* sql`SELECT node_id FROM node_reports`).toEqual([{ node_id: "test-node" }]);
      expect(yield* sql`SELECT node_id FROM node_sessions`).toEqual([{ node_id: "test-node" }]);
    }),
  );
});

it.effect("GET /api/nodes/claims 不返回已过期的租约；响应里没有 executor、state、fencing", () => {
  const clock = fixedClock(0);
  return withWeb({ login: false, nowMillis: clock.nowMillis }, (handler, sql) =>
    Effect.gen(function* () {
      yield* sql`
        INSERT INTO node_claims (repo, issue, claimed_by, lease_until, executor, state, fencing)
        VALUES
          ('example/one', 7, 'ada', '1970-01-01T00:01:00.000Z', 'local', 'running', 'fence-a'),
          ('example/one', 9, 'ada', '1970-01-01T00:00:00.000Z', 'engine', 'done', 'fence-b')
      `;
      const response = yield* send(handler, "GET", "/api/nodes/claims", { credential: TOKEN });
      expect(response.status).toBe(200);
      const body = yield* json<{
        claims: ReadonlyArray<Record<string, unknown>>;
      }>(response);
      expect(body.claims).toEqual([
        {
          repo: "example/one",
          issue: 7,
          claimedBy: "ada",
          leaseUntil: "1970-01-01T00:01:00.000Z",
        },
      ]);
      expect(JSON.stringify(body)).not.toContain("executor");
      expect(JSON.stringify(body)).not.toContain("fencing");
      expect(JSON.stringify(body)).not.toContain("running");
      expect(Object.keys(body)).toEqual(["claims"]);
      expect(Object.keys(body.claims[0] ?? {}).sort()).toEqual([
        "claimedBy",
        "issue",
        "leaseUntil",
        "repo",
      ]);
    }),
  );
});

it.effect("库读失败是 503，响应体不是空的 claims 数组", () => {
  const clock = fixedClock();
  return withWeb({ login: false, nowMillis: clock.nowMillis }, (handler, sql) =>
    Effect.gen(function* () {
      yield* sql`DROP TABLE node_claims`;
      const response = yield* send(handler, "GET", "/api/nodes/claims", { credential: TOKEN });
      expect(response.status).toBe(503);
      const body = yield* json<{ error?: { code?: string }; claims?: unknown }>(response);
      expect(body.error?.code).toBe("local_claims_unreadable");
      expect(body).not.toEqual({ claims: [] });
      expect(body).not.toHaveProperty("claims");
    }),
  );
});

it.effect("有钥匙、没有快照的节点，详情是 node_never_reported；没有钥匙的 id 不是这个结果", () => {
  const clock = fixedClock();
  return withWeb({ login: true, nowMillis: clock.nowMillis }, (handler) =>
    Effect.gen(function* () {
      const keyed = yield* send(handler, "GET", "/api/nodes/test-node");
      expect(keyed.status).toBe(404);
      expect(yield* json<{ error: { code: string } }>(keyed)).toEqual({
        error: {
          code: "node_never_reported",
          message: "环境 test-node 配了通行证，但一次快照都没推来过",
        },
      });
      const missing = yield* send(handler, "GET", "/api/nodes/nobody");
      const missingBody = yield* json<{ error?: { code?: string } }>(missing);
      expect(missingBody.error?.code).not.toBe("node_never_reported");
      expect(missingBody.error?.code).toBe("node_not_found");
    }),
  );
});

it.effect("report、sessions、GET /api/nodes/claims 在没有或错误的节点证时是 401", () => {
  const clock = fixedClock();
  return withWeb({ login: false, nowMillis: clock.nowMillis }, (handler, sql) =>
    Effect.gen(function* () {
      for (const path of ["/api/nodes/report", "/api/nodes/sessions"] as const) {
        expect((yield* send(handler, "POST", path, { body: { marker: "x" } })).status).toBe(401);
        expect(
          (yield* send(handler, "POST", path, { body: { marker: "x" }, credential: "wrong-token" }))
            .status,
        ).toBe(401);
      }
      expect((yield* send(handler, "GET", "/api/nodes/claims")).status).toBe(401);
      expect(
        (yield* send(handler, "GET", "/api/nodes/claims", { credential: "wrong-token" })).status,
      ).toBe(401);
      expect(yield* sql`SELECT node_id FROM node_reports`).toEqual([]);
      expect(yield* sql`SELECT node_id FROM node_sessions`).toEqual([]);
    }),
  );
});

it.effect("三个登录读口不接受节点证，没有登录上下文时是 401", () => {
  const clock = fixedClock();
  return withWeb({ login: false, nowMillis: clock.nowMillis }, (handler) =>
    Effect.gen(function* () {
      for (const path of ["/api/nodes", "/api/nodes/sessions", "/api/nodes/test-node"] as const) {
        expect((yield* send(handler, "GET", path)).status).toBe(401);
        expect((yield* send(handler, "GET", path, { credential: TOKEN })).status).toBe(401);
      }
    }),
  );
});

it.effect("POST /api/nodes/claims 是唯一写口：404、409、503，leaseUntil 由服务端写下", () => {
  const clock = fixedClock(0);
  return withWeb({ login: false, nowMillis: clock.nowMillis }, (handler, sql) =>
    Effect.gen(function* () {
      const body = { action: "claim", repo: "example/one", issue: 7, title: "单 7" };
      const missing = yield* send(handler, "POST", "/api/nodes/claims", {
        credential: TOKEN,
        body,
      });
      expect(missing.status).toBe(404);
      expect((yield* json<{ error: { code: string } }>(missing)).error.code).toBe("unknown_repo");
      yield* sql`INSERT INTO repos (owner, name) VALUES ('example', 'one')`;
      const first = yield* send(handler, "POST", "/api/nodes/claims", {
        credential: TOKEN,
        body,
      });
      expect(first.status).toBe(200);
      expect(yield* json(first)).toEqual({
        ok: true,
        state: "running",
        executor: "local",
        leaseUntil: "1970-01-01T02:00:00.000Z",
      });
      const again = yield* send(handler, "POST", "/api/nodes/claims", {
        credential: TOKEN,
        body,
      });
      expect(again.status).toBe(409);
      expect((yield* json<{ error: { code: string } }>(again)).error.code).toBe("engine_has_it");
      expect(yield* sql`SELECT claimed_by, lease_until FROM node_claims`).toEqual([
        { claimed_by: "test-node", lease_until: "1970-01-01T02:00:00.000Z" },
      ]);
      yield* sql`DROP TABLE repos`;
      const unread = yield* send(handler, "POST", "/api/nodes/claims", {
        credential: TOKEN,
        body,
      });
      expect(unread.status).toBe(503);
      expect((yield* json<{ error: { code: string } }>(unread)).error.code).toBe(
        "local_claims_unreadable",
      );
      expect(yield* sql`SELECT claimed_by FROM node_claims`).toEqual([{ claimed_by: "test-node" }]);
    }),
  );
});

const SESSION = "ledger-test-session";
const LIMITED_SESSION = "ledger-limited-session";

const sessionAuth = Layer.mock(EnvironmentAuth.EnvironmentAuth, {
  authenticateHttpRequest: (request) =>
    request.headers.authorization === `Bearer ${SESSION}`
      ? Effect.succeed({
          sessionId: AuthSessionId.make("ledger-test"),
          subject: "ledger-test",
          method: "bearer-access-token",
          scopes: [AuthOrchestrationReadScope],
        })
      : request.headers.authorization === `Bearer ${LIMITED_SESSION}`
        ? Effect.succeed({
            sessionId: AuthSessionId.make("ledger-limited"),
            subject: "ledger-limited",
            method: "bearer-access-token",
            scopes: [],
          })
        : Effect.fail(new EnvironmentAuth.ServerAuthMissingCredentialError({})),
});

const withLive = <A, E, R>(
  use: (
    handler: (request: Request) => Promise<Response>,
    sql: SqlClient.SqlClient,
  ) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* NodeReads.migrate;
    yield* sql`INSERT INTO node_keys (node_id, token_hash) VALUES ('test-node', ${TOKEN_HASH})`;
    const web = yield* Effect.sync(() =>
      HttpRouter.toWebHandler(
        NodeReads.layerLive(sql).pipe(
          Layer.provide(sessionAuth),
          Layer.provideMerge(
            HttpPlatform.layer.pipe(
              Layer.provideMerge(NodeServices.layer),
              Layer.provideMerge(Etag.layerWeak),
            ),
          ),
          Layer.provideMerge(NodeServices.layer),
        ),
        { disableLogger: true },
      ),
    );
    return yield* Effect.acquireUseRelease(
      Effect.succeed(web),
      (value) => use(value.handler, sql),
      (value) => Effect.promise(() => value.dispose()),
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" })));

it.effect("已登录的请求能读到节点列表、会话列表和单节点", () =>
  withLive((handler) =>
    Effect.gen(function* () {
      expect(
        (yield* send(handler, "POST", "/api/nodes/report", {
          body: { marker: "snap" },
          credential: TOKEN,
        })).status,
      ).toBe(200);
      expect(
        (yield* send(handler, "POST", "/api/nodes/sessions", {
          body: { marker: "sess" },
          credential: TOKEN,
        })).status,
      ).toBe(200);
      const session = { session: SESSION };
      expect(yield* json(yield* send(handler, "GET", "/api/nodes", session))).toEqual({
        nodes: [{ id: "test-node", payload: { marker: "snap" } }],
      });
      expect(yield* json(yield* send(handler, "GET", "/api/nodes/sessions", session))).toEqual({
        nodes: [{ id: "test-node", payload: { marker: "sess" } }],
      });
      expect(yield* json(yield* send(handler, "GET", "/api/nodes/test-node", session))).toEqual({
        id: "test-node",
        payload: { marker: "snap" },
      });
    }),
  ),
);

it.effect("没登录读三个口是 401，只带节点证也是 401", () =>
  withLive((handler) =>
    Effect.gen(function* () {
      for (const path of ["/api/nodes", "/api/nodes/sessions", "/api/nodes/test-node"] as const) {
        const bare = yield* send(handler, "GET", path);
        expect(bare.status).toBe(401);
        expect((yield* json<{ error: { code: string } }>(bare)).error.code).toBe("login_required");
        const node = yield* send(handler, "GET", path, { credential: TOKEN });
        expect(node.status).toBe(401);
        expect((yield* json<{ error: { code: string } }>(node)).error.code).toBe("login_required");
      }
    }),
  ),
);

it.effect("有效但没有 orchestration:read 的凭证读三个口是 403", () =>
  withLive((handler) =>
    Effect.gen(function* () {
      for (const path of ["/api/nodes", "/api/nodes/sessions", "/api/nodes/test-node"] as const) {
        const response = yield* send(handler, "GET", path, { session: LIMITED_SESSION });
        expect(response.status).toBe(403);
        expect((yield* json<{ error: { code: string } }>(response)).error.code).toBe(
          "insufficient_scope",
        );
      }
    }),
  ),
);

// The node token is only stored as a sha256, the same way the handler checks it.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import { HttpRouter } from "effect/http";
import * as SqlClient from "effect/sql/SqlClient";

import * as Notes from "./notes.ts";

const TOKEN = "ledger-test-token";
const TOKEN_HASH = NodeCrypto.createHash("sha256").update(TOKEN).digest("hex");

const note = (overrides: Record<string, unknown> = {}) => ({
  repo: "example/one",
  kind: "progress.note",
  text: "test entry",
  source: { kind: "local-session", ref: "test-session" },
  idempotencyKey: "test-key-0001",
  ...overrides,
});

const withWeb = <A, E, R>(
  use: (
    handler: (request: Request) => Promise<Response>,
    sql: SqlClient.SqlClient,
  ) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* Notes.migrate;
    yield* sql`INSERT INTO repos (owner, name) VALUES ('example', 'one'), ('example', 'two')`;
    yield* sql`INSERT INTO node_keys (node_id, token_hash) VALUES ('test-node', ${TOKEN_HASH})`;
    const web = yield* Effect.sync(() =>
      HttpRouter.toWebHandler(
        Notes.layerFor(sql).pipe(
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

const post = (
  handler: (request: Request) => Promise<Response>,
  body: unknown,
  credential: string | null = TOKEN,
) =>
  Effect.promise(() =>
    handler(
      new Request("http://127.0.0.1/api/nodes/notes", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(credential === null ? {} : { "X-Fleet-Node-Token": credential }),
        },
        body: JSON.stringify(body),
      }),
    ),
  );

const readEvents = (handler: (request: Request) => Promise<Response>, query: string) =>
  Effect.promise(() =>
    handler(
      new Request(`http://127.0.0.1/api/nodes/events?${query}`, {
        headers: { "X-Fleet-Node-Token": TOKEN },
      }),
    ),
  );

const json = <A>(response: Response) => Effect.promise(() => response.json() as Promise<A>);

it.effect("没登记的仓是 404，且没有新行", () =>
  withWeb((handler, sql) =>
    Effect.gen(function* () {
      expect((yield* post(handler, note({ repo: "unknown/repo" }))).status).toBe(404);
      expect(yield* sql`SELECT id FROM audit_log`).toEqual([]);
    }),
  ),
);

it.effect("同一 repo 和 idempotencyKey 写两次 id 相同且第二次 created 为 false；换仓是另一行", () =>
  withWeb((handler, sql) =>
    Effect.gen(function* () {
      const first = yield* json<{ id: number; created: boolean }>(yield* post(handler, note()));
      expect(first).toEqual({ id: expect.any(Number), created: true });
      expect(yield* json(yield* post(handler, note({ text: "replacement" })))).toEqual({
        id: first.id,
        created: false,
      });
      const other = yield* json<{ id: number; created: boolean }>(
        yield* post(handler, note({ repo: "example/two" })),
      );
      expect(other.created).toBe(true);
      expect(other.id).not.toBe(first.id);
      expect(
        yield* sql<{ readonly text: string }>`
          SELECT json_extract(after, '$.text') AS text FROM audit_log ORDER BY id
        `,
      ).toEqual([{ text: "test entry" }, { text: "test entry" }]);
    }),
  ),
);

it.effect("kind 不在五种里是 400，没有新行", () =>
  withWeb((handler, sql) =>
    Effect.gen(function* () {
      expect((yield* post(handler, note({ kind: "issue.open" }))).status).toBe(400);
      expect(yield* sql`SELECT id FROM audit_log`).toEqual([]);
    }),
  ),
);

it.effect(
  "三行里 after=0&limit=2 只回最小两个 id 且升序；下一页不含该 id；没有更多行时 next 等于 after",
  () =>
    withWeb((handler, sql) =>
      Effect.gen(function* () {
        for (let index = 1; index <= 3; index += 1) {
          const response = yield* post(
            handler,
            note({
              idempotencyKey: `test-key-000${index}`,
              ...(index === 2 ? { issue: 51 } : {}),
            }),
          );
          expect(response.status).toBe(200);
        }
        yield* sql`
        INSERT INTO audit_log (actor_kind, actor_id, action, target, after, via)
        VALUES ('agent', 'test', 'login', 'progressive:one', '{}', 'agent')
      `;
        const first = yield* json<{ events: Array<{ id: number; target: string }>; next: number }>(
          yield* readEvents(handler, "after=0&limit=2"),
        );
        expect(first.events.map((event) => event.id)).toEqual([1, 2]);
        expect(first.events.map((event) => event.target)).toEqual([
          "progress:example/one",
          "issue:example/one#51",
        ]);
        expect(first.next).toBe(2);
        const second = yield* json<{ events: Array<{ id: number }>; next: number }>(
          yield* readEvents(handler, `after=${first.next}&limit=2`),
        );
        expect(second.events.map((event) => event.id)).toEqual([3]);
        expect(second.next).toBe(3);
        expect(yield* json(yield* readEvents(handler, "after=3&limit=2"))).toEqual({
          events: [],
          next: 3,
        });
      }),
    ),
);

it.effect("写失败和读失败都是 503，读失败的响应体不是空的 events 数组", () =>
  withWeb((handler, sql) =>
    Effect.gen(function* () {
      yield* sql`DROP TABLE audit_log`;
      expect((yield* post(handler, note())).status).toBe(503);
      const response = yield* readEvents(handler, "after=0&limit=2");
      expect(response.status).toBe(503);
      const body = yield* json<{ error?: { code?: string }; events?: unknown }>(response);
      expect(body.error?.code).toBe("issue_events_unreadable");
      expect(body).not.toHaveProperty("events");
    }),
  ),
);

it.effect("没有或错误的 X-Fleet-Node-Token 是 401，且没有新行", () =>
  withWeb((handler, sql) =>
    Effect.gen(function* () {
      expect((yield* post(handler, note(), null)).status).toBe(401);
      expect((yield* post(handler, note(), "wrong-token")).status).toBe(401);
      expect(yield* sql`SELECT id FROM audit_log`).toEqual([]);
    }),
  ),
);

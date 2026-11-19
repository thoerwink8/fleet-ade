import { AuthOrchestrationReadScope } from "@t3tools/contracts";

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as SqlClient from "effect/sql/SqlClient";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as NodeClaims from "./nodeClaims.ts";
import * as Notes from "./notes.ts";

/** Same gap the old node report and session posts used, on two separate slots. */
const GAP_MS = 20_000;

export interface NodeReadGate {
  /** Test double. The server mount uses `layerLive` and the environment session instead. */
  readonly login: boolean;
  /** Milliseconds. Tests inject this; `layerLive` uses `Date.now`. */
  readonly nowMillis: () => number;
}

class NodeReadRejected extends Schema.TaggedError<NodeReadRejected>()("NodeReadRejected", {
  status: Schema.Literals([400, 401, 403, 404, 409, 429, 503]),
  code: Schema.String,
  message: Schema.String,
  retryAfter: Schema.Number,
}) {}

const reject = (
  status: 400 | 401 | 403 | 404 | 409 | 429 | 503,
  code: string,
  message: string,
  retryAfter = 0,
) => new NodeReadRejected({ status, code, message, retryAfter });

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

const payloadOf = (raw: string) =>
  Effect.fromOption(decodeJson(raw)).pipe(
    Effect.mapError(() => reject(503, "node_snapshot_unreadable", "快照认不出，不当成没推过")),
  );

/** Overwrite rows for snapshots and sessions. Claims are only read; this file never inserts one. */
export const migrate = Effect.gen(function* () {
  yield* Notes.migrate;
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS node_reports (
      node_id TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      received_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS node_sessions (
      node_id TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      received_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS fleet_summary_meta (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      revision INTEGER NOT NULL
    )
  `;
  yield* sql`INSERT OR IGNORE INTO fleet_summary_meta (id, revision) VALUES (1, 0)`;
  yield* sql`
    CREATE TABLE IF NOT EXISTS fleet_summary_rows (
      row_id TEXT PRIMARY KEY,
      environment_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      repo TEXT,
      issue INTEGER,
      task_id TEXT,
      thread_id TEXT NOT NULL,
      title TEXT NOT NULL,
      phase TEXT NOT NULL,
      reason TEXT NOT NULL,
      needs_you INTEGER NOT NULL,
      last_progress TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      stale INTEGER NOT NULL DEFAULT 0,
      stale_reason TEXT,
      revision INTEGER NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS fleet_summary_changes (
      revision INTEGER PRIMARY KEY,
      event_type TEXT NOT NULL,
      row_id TEXT,
      payload TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_fleet_summary_rows_environment
    ON fleet_summary_rows (environment_id)
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS fleet_summary_registrations (
      thread_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      coordinator TEXT NOT NULL,
      repo TEXT,
      issue INTEGER,
      task_id TEXT,
      sent TEXT,
      deleting INTEGER NOT NULL DEFAULT 0
    )
  `;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      const claimColumns = (yield* sql`PRAGMA table_info(node_claims)`) as readonly {
        readonly name: string;
        readonly pk: number;
      }[];
      const backupColumns = (yield* sql`PRAGMA table_info(node_claims_before_fleet)`) as readonly {
        readonly name: string;
      }[];
      const primaryKey = claimColumns
        .filter((column) => column.pk > 0)
        .toSorted((left, right) => left.pk - right.pk)
        .map((column) => column.name);
      const currentNames = new Set(claimColumns.map((column) => column.name));
      const currentSchema =
        primaryKey.join(",") === "repo,issue,task_id" &&
        [
          "fleet_id",
          "attempt",
          "claim_idempotency_key",
          "renew_idempotency_key",
          "renew_lease_until",
          "release_idempotency_key",
        ].every((column) => currentNames.has(column));

      if (!currentSchema && claimColumns.length > 0 && backupColumns.length === 0) {
        yield* sql`ALTER TABLE node_claims RENAME TO node_claims_before_fleet`;
      }
      if (!currentSchema && claimColumns.length > 0 && backupColumns.length > 0) {
        yield* sql`DROP TABLE node_claims`;
      }
      yield* sql`
        CREATE TABLE IF NOT EXISTS node_claims (
          fleet_id TEXT NOT NULL DEFAULT 'legacy',
          repo TEXT NOT NULL,
          issue INTEGER NOT NULL,
          task_id TEXT NOT NULL DEFAULT 'root',
          claimed_by TEXT NOT NULL,
          holder_environment TEXT,
          lease_until TEXT NOT NULL,
          executor TEXT,
          state TEXT NOT NULL DEFAULT 'running',
          fencing TEXT,
          attempt INTEGER NOT NULL DEFAULT 1,
          claim_idempotency_key TEXT,
          renew_idempotency_key TEXT,
          renew_lease_until TEXT,
          release_idempotency_key TEXT,
          PRIMARY KEY (repo, issue, task_id)
        )
      `;

      const sourceColumns = (yield* sql`PRAGMA table_info(node_claims_before_fleet)`) as readonly {
        readonly name: string;
      }[];
      if (sourceColumns.length > 0) {
        const sourceNames = new Set(sourceColumns.map((column) => column.name));
        const fleetId = sourceNames.has("fleet_id") ? sql`fleet_id` : sql`'legacy'`;
        const taskId = sourceNames.has("task_id") ? sql`task_id` : sql`'root'`;
        const attempt = sourceNames.has("attempt") ? sql`attempt` : sql`1`;
        const claimKey = sourceNames.has("idempotency_key")
          ? sql`idempotency_key`
          : sourceNames.has("claim_idempotency_key")
            ? sql`claim_idempotency_key`
            : sql`NULL`;
        const renewKey = sourceNames.has("renew_idempotency_key")
          ? sql`renew_idempotency_key`
          : sql`NULL`;
        const renewUntil = sourceNames.has("renew_lease_until")
          ? sql`renew_lease_until`
          : sql`NULL`;
        const releaseKey = sourceNames.has("release_idempotency_key")
          ? sql`release_idempotency_key`
          : sql`NULL`;
        yield* sql`
          INSERT INTO node_claims (
            fleet_id, repo, issue, task_id, claimed_by, holder_environment, lease_until, executor,
            state, fencing, attempt, claim_idempotency_key, renew_idempotency_key,
            renew_lease_until, release_idempotency_key
          )
          SELECT fleet_id, repo, issue, task_id, claimed_by, holder_environment, lease_until,
            executor, state, fencing, attempt, claim_idempotency_key, renew_idempotency_key,
            renew_lease_until, release_idempotency_key
          FROM (
            SELECT ${fleetId} AS fleet_id, repo, issue, ${taskId} AS task_id, claimed_by,
              ${sourceNames.has("holder_environment") ? sql`holder_environment` : sql`NULL`} AS holder_environment,
              lease_until, executor, COALESCE(state, 'running') AS state, fencing,
              ${attempt} AS attempt, ${claimKey} AS claim_idempotency_key,
              ${renewKey} AS renew_idempotency_key, ${renewUntil} AS renew_lease_until,
              ${releaseKey} AS release_idempotency_key,
              ROW_NUMBER() OVER (
                PARTITION BY repo, issue, ${taskId}
                ORDER BY ${attempt} DESC, state = 'running' DESC, lease_until DESC
              ) AS rank
            FROM node_claims_before_fleet
          )
          WHERE rank = 1
          ON CONFLICT(repo, issue, task_id) DO NOTHING
        `;
        yield* sql`DROP TABLE node_claims_before_fleet`;
      }
      yield* sql`
        CREATE INDEX IF NOT EXISTS idx_node_claims_holder
        ON node_claims (claimed_by, state)
      `;
      const migrated = (yield* sql`PRAGMA table_info(node_claims)`) as readonly {
        readonly name: string;
      }[];
      if (!migrated.some((column) => column.name === "holder_environment")) {
        yield* sql`ALTER TABLE node_claims ADD COLUMN holder_environment TEXT`;
      }
    }),
  );
});

const authed = (sql: SqlClient.SqlClient, request: HttpServerRequest.HttpServerRequest) =>
  Notes.authenticateNode(sql, request).pipe(
    Effect.mapError((error) => reject(error.status, error.code, error.message)),
  );

const saveNode = Effect.fn("NodeReads.save")(function* (
  sql: SqlClient.SqlClient,
  kind: "report" | "sessions",
  nodeId: string,
  payload: string,
  receivedAt: string,
) {
  const unwritable = reject(
    503,
    kind === "report" ? "node_report_unwritable" : "node_sessions_unwritable",
    kind === "report" ? "快照没写上（库写失败）" : "本机会话没写上（库写失败）",
  );
  const written = yield* (
    kind === "report"
      ? sql<{ readonly node_id: string }>`
        INSERT INTO node_reports (node_id, payload, received_at)
        VALUES (${nodeId}, ${payload}, ${receivedAt})
        ON CONFLICT(node_id) DO UPDATE SET
          payload = excluded.payload,
          received_at = excluded.received_at
        RETURNING node_id
      `
      : sql<{ readonly node_id: string }>`
        INSERT INTO node_sessions (node_id, payload, received_at)
        VALUES (${nodeId}, ${payload}, ${receivedAt})
        ON CONFLICT(node_id) DO UPDATE SET
          payload = excluded.payload,
          received_at = excluded.received_at
        RETURNING node_id
      `
  ).pipe(Effect.mapError(() => unwritable));
  if (written[0] === undefined) return yield* unwritable;
  return receivedAt;
});

const routes = (
  sql: SqlClient.SqlClient,
  nowMillis: () => number,
  requireLogin: Effect.Effect<void, NodeReadRejected, HttpServerRequest.HttpServerRequest>,
) => {
  const reportGap = new Map<string, number>();
  const sessionGap = new Map<string, number>();

  const respond = (
    effect: Effect.Effect<
      unknown,
      NodeReadRejected,
      HttpServerRequest.HttpServerRequest | HttpRouter.RouteContext
    >,
  ) =>
    effect.pipe(
      Effect.match({
        onFailure: (error) =>
          HttpServerResponse.jsonUnsafe(
            { error: { code: error.code, message: error.message } },
            {
              status: error.status,
              headers: {
                "cache-control": "no-store",
                ...(error.status === 429 ? { "retry-after": String(error.retryAfter) } : {}),
              },
            },
          ),
        onSuccess: (body) =>
          HttpServerResponse.jsonUnsafe(body, {
            status: 200,
            headers: { "cache-control": "no-store" },
          }),
      }),
    );

  const postKind = (kind: "report" | "sessions") =>
    respond(
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const nodeId = yield* authed(sql, request);
        const slot = kind === "report" ? reportGap : sessionGap;
        const now = nowMillis();
        const before = slot.get(nodeId);
        if (before !== undefined && now - before < GAP_MS) {
          const retryAfter = Math.ceil((GAP_MS - (now - before)) / 1000);
          const which = kind === "report" ? "" : "本机会话";
          return yield* reject(
            429,
            "too_frequent",
            `同一个环境 20 秒内只收一次${which}，${retryAfter} 秒后再推`,
            retryAfter,
          );
        }
        slot.set(nodeId, now);
        const undo = () => {
          if (before === undefined) slot.delete(nodeId);
          else slot.set(nodeId, before);
        };
        const body = yield* request.json.pipe(
          Effect.mapError(() => {
            undo();
            return reject(400, "invalid_body", "请求体不是 JSON");
          }),
        );
        if (typeof body !== "object" || body === null || Array.isArray(body)) {
          undo();
          return yield* reject(400, "invalid_body", "请求体不是对象");
        }
        const receivedAt = DateTime.formatIso(DateTime.makeUnsafe(now));
        yield* saveNode(sql, kind, nodeId, encodeJson(body), receivedAt).pipe(
          Effect.tapError(() => Effect.sync(undo)),
        );
        return { ok: true as const, receivedAt };
      }),
    );

  const listRows = (table: "node_reports" | "node_sessions", unread: NodeReadRejected) => {
    const listed =
      table === "node_reports"
        ? sql<{ readonly node_id: string; readonly payload: string }>`
            SELECT node_id, payload FROM node_reports
          `.pipe(Effect.mapError(() => unread))
        : sql<{ readonly node_id: string; readonly payload: string }>`
            SELECT node_id, payload FROM node_sessions
          `.pipe(Effect.mapError(() => unread));
    return listed;
  };

  const listKeyed = (table: "node_reports" | "node_sessions", code: string, message: string) =>
    respond(
      Effect.gen(function* () {
        yield* requireLogin;
        const unread = reject(503, code, message);
        const rows = yield* listRows(table, unread);
        const keys = yield* sql<{ readonly node_id: string }>`
          SELECT node_id FROM node_keys WHERE revoked_at IS NULL
        `.pipe(Effect.mapError(() => unread));
        const byId = new Map<string, unknown | null>();
        for (const key of keys) byId.set(key.node_id, null);
        for (const row of rows) {
          byId.set(row.node_id, yield* payloadOf(row.payload));
        }
        const nodes = [...byId.entries()]
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([id, payload]) => ({ id, payload }));
        return { nodes };
      }),
    );

  const detail = respond(
    Effect.gen(function* () {
      yield* requireLogin;
      const params = yield* HttpRouter.params;
      const nodeId = params.nodeId;
      if (nodeId === undefined || !/^[a-z][a-z0-9-]{0,39}$/.test(nodeId)) {
        return yield* reject(404, "node_not_found", "没有这个环境");
      }
      const unread = reject(
        503,
        "node_snapshot_unreadable",
        "读不到节点快照（库读失败），不把库故障当成没有这个节点",
      );
      const rows = yield* sql<{ readonly payload: string }>`
        SELECT payload FROM node_reports WHERE node_id = ${nodeId} LIMIT 1
      `.pipe(Effect.mapError(() => unread));
      const row = rows[0];
      if (row !== undefined) return { id: nodeId, payload: yield* payloadOf(row.payload) };
      const keys = yield* sql<{ readonly node_id: string }>`
        SELECT node_id FROM node_keys
        WHERE node_id = ${nodeId} AND revoked_at IS NULL
        LIMIT 1
      `.pipe(Effect.mapError(() => unread));
      if (keys[0] !== undefined) {
        return yield* reject(
          404,
          "node_never_reported",
          `环境 ${nodeId} 配了通行证，但一次快照都没推来过`,
        );
      }
      return yield* reject(404, "node_not_found", "没有这个环境");
    }),
  );

  const claims = respond(
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      yield* authed(sql, request);
      const rows = yield* sql<{
        readonly repo: string;
        readonly issue: number;
        readonly claimedBy: string;
        readonly leaseUntil: string;
      }>`
        SELECT repo, issue, claimed_by AS claimedBy, lease_until AS leaseUntil
        FROM node_claims
        WHERE fleet_id = 'legacy' AND task_id = 'root' AND state = 'running'
      `.pipe(
        Effect.mapError(() =>
          reject(
            503,
            "local_claims_unreadable",
            "读不到本机租约（库读失败），不拿空列表冒充「没人领着」",
          ),
        ),
      );
      const now = nowMillis();
      const active = rows.flatMap((row) => {
        const until = Date.parse(row.leaseUntil);
        if (Number.isNaN(until) || until <= now) return [];
        return [
          {
            repo: row.repo,
            issue: row.issue,
            claimedBy: row.claimedBy,
            leaseUntil: row.leaseUntil,
          },
        ];
      });
      active.sort((a, b) => a.repo.localeCompare(b.repo) || a.issue - b.issue);
      return { claims: active };
    }),
  );

  const postClaims = respond(
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const nodeId = yield* authed(sql, request);
      const body = yield* request.json.pipe(
        Effect.mapError(() => reject(400, "invalid_body", "请求体不是 JSON")),
      );
      const parsed = NodeClaims.parseClaimRequest(body);
      if (parsed === undefined) return yield* reject(400, "invalid_body", "请求体不符合领单格式");
      const nowMs = nowMillis();
      const outcome = yield* NodeClaims.apply(
        sql,
        parsed.action === "claim"
          ? {
              action: "claim",
              repo: parsed.repo,
              issue: parsed.issue,
              title: parsed.title,
              claimedBy: nodeId,
              leaseUntil: NodeClaims.leaseUntilFrom(nowMs),
            }
          : parsed.action === "renew"
            ? {
                action: "renew",
                repo: parsed.repo,
                issue: parsed.issue,
                claimedBy: nodeId,
                leaseUntil: NodeClaims.leaseUntilFrom(nowMs),
              }
            : {
                action: "finish",
                repo: parsed.repo,
                issue: parsed.issue,
                outcome: parsed.outcome,
                reason: parsed.reason,
                claimedBy: nodeId,
              },
        nowMs,
      ).pipe(
        Effect.mapError(() =>
          reject(
            503,
            "local_claims_unreadable",
            "读不到本机租约（库读失败），不拿空列表冒充「没人领着」",
          ),
        ),
      );
      if (outcome.status !== 200) {
        return yield* reject(
          outcome.status,
          outcome.code,
          outcome.code === "unknown_repo"
            ? `${parsed.repo} 不是登记的仓，登记不了`
            : outcome.code === "not_claimed"
              ? `${parsed.repo}#${parsed.issue} 现在不是这台领着的`
              : `另一执行方手上有这张单`,
        );
      }
      return {
        ok: true as const,
        state: "running",
        executor: "local" as const,
        leaseUntil: outcome.leaseUntil,
      };
    }),
  );

  return Layer.mergeAll(
    HttpRouter.add("POST", "/api/nodes/report", postKind("report")),
    HttpRouter.add("POST", "/api/nodes/sessions", postKind("sessions")),
    HttpRouter.add("GET", "/api/nodes/claims", claims),
    HttpRouter.add("POST", "/api/nodes/claims", postClaims),
    HttpRouter.add(
      "GET",
      "/api/nodes",
      listKeyed(
        "node_reports",
        "nodes_unreadable",
        "读不到节点列表（库读失败），不拿空列表冒充没有环境",
      ),
    ),
    HttpRouter.add(
      "GET",
      "/api/nodes/sessions",
      listKeyed(
        "node_sessions",
        "local_sessions_unreadable",
        "读不到本机会话（库读失败），不拿空列表冒充没有会话",
      ),
    ),
    HttpRouter.add("GET", "/api/nodes/:nodeId", detail),
  );
};

const forcedLogin = (login: boolean): Effect.Effect<void, NodeReadRejected> =>
  login ? Effect.void : Effect.fail(reject(401, "login_required", "要登录，不认节点证"));

const requireSession = Effect.fn("NodeReads.requireSession")(function* (
  auth: EnvironmentAuth.EnvironmentAuth["Service"],
) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const principal = yield* auth
    .authenticateHttpRequest(request)
    .pipe(
      Effect.mapError((error) =>
        EnvironmentAuth.isServerAuthCredentialError(error)
          ? reject(401, "login_required", "要登录，不认节点证")
          : reject(503, "login_unreadable", "登录态读不了，不当成没登录"),
      ),
    );
  if (!principal.scopes.includes(AuthOrchestrationReadScope)) {
    return yield* reject(403, "insufficient_scope", "要有 orchestration:read 才能读节点");
  }
});

export const layerFor = (sql: SqlClient.SqlClient, gate: NodeReadGate) =>
  routes(sql, gate.nowMillis, forcedLogin(gate.login));

export const layerLive = (sql: SqlClient.SqlClient) =>
  Layer.unwrap(
    Effect.map(EnvironmentAuth.EnvironmentAuth, (auth) =>
      routes(sql, Date.now, requireSession(auth)),
    ),
  );

// Node's hash and fixed-time compare are the check the node token already uses.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeReads from "./nodeReads.ts";
import * as LedgerDb from "./LedgerDb.ts";

const HEADER = "x-fleet-node-token";
const NOTE_KINDS = [
  "progress.note",
  "decision.handoff",
  "report.daily",
  "report.guards",
  "directive",
] as const;
const DIRECTIVE_CATEGORIES = ["ai", "product", "task", "once", "ops", "discuss"] as const;
const SOURCE_KINDS = [
  "local-session",
  "harness-commander",
  "harness-chat",
  "mirasim",
  "engine",
  "api",
] as const;
const KIND_LIST = NOTE_KINDS.map((kind) => `'${kind}'`).join(", ");
const MAX_TOKEN_CHARS = 256;
const TEXT_MAX = 20_000;
const MEANING_MAX = 2_000;
const EVENTS_DEFAULT_LIMIT = 100;
const EVENTS_MAX_LIMIT = 500;

type NoteKind = (typeof NOTE_KINDS)[number];

interface NoteBody {
  readonly kind: NoteKind;
  readonly repo: string;
  readonly issue?: number;
  readonly text: string;
  readonly source: { readonly kind: (typeof SOURCE_KINDS)[number]; readonly ref: string };
  readonly idempotencyKey: string;
  readonly meaning?: string;
  readonly category?: (typeof DIRECTIVE_CATEGORIES)[number];
  readonly owner?: string;
  readonly spokenAt?: string;
}

export class LedgerRejected extends Schema.TaggedError<LedgerRejected>()("LedgerRejected", {
  status: Schema.Literals([400, 401, 404, 503]),
  code: Schema.String,
  message: Schema.String,
}) {}

const reject = (status: 400 | 401 | 404 | 503, code: string, message: string) =>
  new LedgerRejected({ status, code, message });

const isLedgerRejected = Schema.is(LedgerRejected);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

const bodyOf = (input: unknown): Record<string, unknown> | LedgerRejected => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return reject(400, "invalid_body", "请求体不是对象");
  }
  return input as Record<string, unknown>;
};

const inList = <A extends string>(values: readonly A[], value: unknown): value is A =>
  typeof value === "string" && values.some((item) => item === value);

const optionalText = (
  body: Record<string, unknown>,
  key: string,
  max: number,
): string | undefined | LedgerRejected => {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length < 1 || value.length > max) {
    return reject(400, "invalid_body", `${key} 不符合`);
  }
  return value;
};

/** Strict body: an unknown kind or an extra field is rejected before any write. */
const parseNote = (input: unknown): NoteBody | LedgerRejected => {
  const body = bodyOf(input);
  if (isLedgerRejected(body)) return body;
  const allowed = [
    "kind",
    "repo",
    "issue",
    "text",
    "source",
    "idempotencyKey",
    "meaning",
    "category",
    "owner",
    "spokenAt",
  ];
  if (Object.keys(body).some((key) => !allowed.includes(key))) {
    return reject(400, "invalid_body", "请求体有不认识的字段");
  }
  if (!inList(NOTE_KINDS, body.kind)) return reject(400, "invalid_body", "kind 不认识");
  if (typeof body.repo !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(body.repo)) {
    return reject(400, "invalid_body", "repo 要是 owner/name");
  }
  if (typeof body.text !== "string" || body.text.length < 1 || body.text.length > TEXT_MAX) {
    return reject(400, "invalid_body", "text 不符合");
  }
  if (typeof body.idempotencyKey !== "string" || !/^[\w.:-]{8,128}$/.test(body.idempotencyKey)) {
    return reject(400, "invalid_body", "idempotencyKey 不符合");
  }
  const source = bodyOf(body.source);
  if (isLedgerRejected(source)) return reject(400, "invalid_body", "source 不符合");
  if (Object.keys(source).some((key) => key !== "kind" && key !== "ref")) {
    return reject(400, "invalid_body", "source 不符合");
  }
  if (!inList(SOURCE_KINDS, source.kind)) return reject(400, "invalid_body", "source.kind 不认识");
  if (typeof source.ref !== "string" || source.ref.length < 1 || source.ref.length > 200) {
    return reject(400, "invalid_body", "source.ref 不符合");
  }
  let issue: number | undefined;
  if (body.issue !== undefined) {
    if (typeof body.issue !== "number" || !Number.isInteger(body.issue) || body.issue < 1) {
      return reject(400, "invalid_body", "issue 要是正整数");
    }
    issue = body.issue;
  }
  const meaning = optionalText(body, "meaning", MEANING_MAX);
  if (isLedgerRejected(meaning)) return meaning;
  const owner = optionalText(body, "owner", 128);
  if (isLedgerRejected(owner)) return owner;
  const spokenAt = optionalText(body, "spokenAt", 64);
  if (isLedgerRejected(spokenAt)) return spokenAt;
  const category = body.category;
  if (category !== undefined && !inList(DIRECTIVE_CATEGORIES, category)) {
    return reject(400, "invalid_body", "category 不认识");
  }
  if (body.kind === "directive") {
    if (issue === undefined) return reject(400, "invalid_body", "directive 要挂一张单");
    if (meaning === undefined) return reject(400, "invalid_body", "directive 要给不带原话的意思");
    if (category === undefined) return reject(400, "invalid_body", "directive 要给类别");
  } else if (
    meaning !== undefined ||
    category !== undefined ||
    owner !== undefined ||
    spokenAt !== undefined
  ) {
    return reject(400, "invalid_body", "只有 directive 能带引导字段");
  }
  return {
    kind: body.kind,
    repo: body.repo,
    ...(issue === undefined ? {} : { issue }),
    text: body.text,
    source: { kind: source.kind, ref: source.ref },
    idempotencyKey: body.idempotencyKey,
    ...(meaning === undefined ? {} : { meaning }),
    ...(category === undefined ? {} : { category }),
    ...(owner === undefined ? {} : { owner }),
    ...(spokenAt === undefined ? {} : { spokenAt }),
  };
};

const parseEventsQuery = (
  url: string,
): { readonly after: number; readonly limit: number } | LedgerRejected => {
  const params = new URL(url, "http://127.0.0.1").searchParams;
  const read = (name: string, fallback: number, min: number, max?: number) => {
    const raw = params.get(name);
    if (raw === null || raw === "") return fallback;
    if (!/^\d+$/.test(raw)) return undefined;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < min) return undefined;
    return max === undefined ? value : Math.min(value, max);
  };
  const after = read("after", 0, 0);
  const limit = read("limit", EVENTS_DEFAULT_LIMIT, 1, EVENTS_MAX_LIMIT);
  if (after === undefined || limit === undefined)
    return reject(400, "invalid_query", "after 或 limit 不符合");
  return { after, limit };
};

const nodeIdForToken = (
  keys: ReadonlyArray<{ readonly node_id: string; readonly token_hash: string }>,
  token: string,
): string | undefined => {
  if (token === "" || token.length > MAX_TOKEN_CHARS) return undefined;
  const presented = NodeCrypto.createHash("sha256").update(token).digest();
  let found: string | undefined;
  for (const key of keys) {
    if (!/^[0-9a-f]{64}$/.test(key.token_hash)) continue;
    const stored = Buffer.from(key.token_hash, "hex");
    if (stored.length === presented.length && NodeCrypto.timingSafeEqual(stored, presented)) {
      found ??= key.node_id;
    }
  }
  return found;
};

/** Append-only audit_log. The partial index predicate is the events query's WHERE. */
export const migrate = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS repos (
      owner TEXT NOT NULL,
      name TEXT NOT NULL,
      PRIMARY KEY (owner, name)
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS node_keys (
      node_id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      revoked_at TEXT
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      actor_kind TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      action TEXT NOT NULL,
      target TEXT NOT NULL,
      before TEXT,
      after TEXT,
      reason TEXT,
      via TEXT NOT NULL,
      ok INTEGER NOT NULL DEFAULT 1 CHECK (ok IN (0, 1)),
      error TEXT
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS audit_log_ledger_events_idx ON audit_log (id)
    WHERE target GLOB 'issue:*' OR target GLOB 'progress:*'
  `;
  yield* sql.unsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS audit_log_ledger_note_key_idx
    ON audit_log (
      json_extract(after, '$.repo'),
      json_extract(after, '$.idempotencyKey')
    )
    WHERE action IN (${KIND_LIST})
  `);
});

export const authenticateNode = Effect.fn("LedgerNotes.authenticate")(function* (
  sql: SqlClient.SqlClient,
  request: HttpServerRequest.HttpServerRequest,
) {
  const keys = yield* sql<{ readonly node_id: string; readonly token_hash: string }>`
    SELECT node_id, token_hash FROM node_keys WHERE revoked_at IS NULL
  `.pipe(
    Effect.mapError(() =>
      reject(503, "node_keys_unreadable", "读不到机器通行证，不把库故障当成通行证不对"),
    ),
  );
  if (keys.length === 0) {
    return yield* reject(503, "node_keys_not_wired", "这台还没发过机器通行证，不收过程记录");
  }
  const token = request.headers[HEADER];
  if (typeof token !== "string") {
    return yield* reject(401, "node_token_missing", "要带通行证：请求头 X-Fleet-Node-Token");
  }
  const nodeId = nodeIdForToken(keys, token.trim());
  if (nodeId === undefined) return yield* reject(401, "node_token_invalid", "通行证不对");
  return nodeId;
});

const findRepo = Effect.fn("LedgerNotes.findRepo")(function* (
  sql: SqlClient.SqlClient,
  repo: string,
) {
  const [owner, name] = repo.split("/");
  const rows = yield* sql<{ readonly owner: string; readonly name: string }>`
      SELECT owner, name FROM repos
      WHERE lower(owner) = lower(${owner}) AND lower(name) = lower(${name})
      LIMIT 1
    `.pipe(
    Effect.mapError(() => reject(503, "ledger_unwritable", "写不进账本（库写失败），这条过程没记")),
  );
  const found = rows[0];
  if (found === undefined)
    return yield* reject(404, "unknown_repo", `${repo} 不是登记过的仓，记不了过程`);
  return `${found.owner}/${found.name}`;
});

const appendNote = Effect.fn("LedgerNotes.append")(function* (
  sql: SqlClient.SqlClient,
  input: {
    readonly nodeId: string;
    readonly repo: string;
    readonly note: NoteBody;
  },
) {
  const at = DateTime.formatIso(yield* DateTime.now);
  const target =
    input.note.issue === undefined
      ? `progress:${input.repo}`
      : `issue:${input.repo}#${input.note.issue}`;
  const after = encodeJson({
    nodeId: input.nodeId,
    repo: input.repo,
    ...(input.note.issue === undefined ? {} : { number: input.note.issue }),
    text: input.note.text,
    ...(input.note.kind === "directive"
      ? {
          meaning: input.note.meaning,
          category: input.note.category,
          ...(input.note.owner === undefined ? {} : { owner: input.note.owner }),
          ...(input.note.spokenAt === undefined ? {} : { spokenAt: input.note.spokenAt }),
        }
      : {}),
    source: input.note.source,
    idempotencyKey: input.note.idempotencyKey,
  });
  const unwritable = reject(503, "ledger_unwritable", "写不进账本（库写失败），这条过程没记");
  const inserted = yield* sql<{ readonly id: number }>`
    INSERT OR IGNORE INTO audit_log (at, actor_kind, actor_id, action, target, after, via, ok)
    VALUES (
      ${at},
      'agent',
      ${`node:${input.nodeId}`},
      ${input.note.kind},
      ${target},
      ${after},
      'agent',
      1
    )
    RETURNING id
  `.pipe(Effect.mapError(() => unwritable));
  const created = inserted[0];
  if (created !== undefined) return { id: created.id, created: true };
  const existing = yield* sql<{ readonly id: number }>`
    SELECT id FROM audit_log
    WHERE action IN ('progress.note', 'decision.handoff', 'report.daily', 'report.guards', 'directive')
      AND json_extract(after, '$.repo') = ${input.repo}
      AND json_extract(after, '$.idempotencyKey') = ${input.note.idempotencyKey}
    LIMIT 1
  `.pipe(Effect.mapError(() => unwritable));
  const prior = existing[0];
  if (prior === undefined) return yield* unwritable;
  return { id: prior.id, created: false };
});

const listEvents = Effect.fn("LedgerNotes.list")(function* (
  sql: SqlClient.SqlClient,
  query: {
    readonly after: number;
    readonly limit: number;
  },
) {
  const rows = yield* sql<{
    readonly id: number;
    readonly at: string;
    readonly actorKind: string;
    readonly actorId: string;
    readonly action: string;
    readonly target: string;
    readonly after: string | null;
    readonly ok: number;
  }>`
    SELECT id, at, actor_kind AS actorKind, actor_id AS actorId, action, target, after, ok
    FROM audit_log
    WHERE id > ${query.after}
      AND (target GLOB 'issue:*' OR target GLOB 'progress:*')
    ORDER BY id ASC
    LIMIT ${query.limit}
  `.pipe(
    Effect.mapError(() =>
      reject(
        503,
        "issue_events_unreadable",
        "读不到开单账本（库读失败），不拿空列表冒充「没有新事件」",
      ),
    ),
  );
  const events = [];
  for (const row of rows) {
    const decoded = row.after === null ? Option.some(null) : decodeJson(row.after);
    if (Option.isNone(decoded)) {
      return yield* reject(
        503,
        "issue_events_unreadable",
        "读不到开单账本（库读失败），不拿空列表冒充「没有新事件」",
      );
    }
    const after = decoded.value;
    events.push({
      id: row.id,
      at: row.at,
      actorKind: row.actorKind,
      actorId: row.actorId,
      action: row.action,
      target: row.target,
      after,
      ok: row.ok === 1,
    });
  }
  return { events, next: events.at(-1)?.id ?? query.after };
});

const respond = (
  effect: Effect.Effect<unknown, LedgerRejected, HttpServerRequest.HttpServerRequest>,
) =>
  effect.pipe(
    Effect.match({
      onFailure: (error) =>
        HttpServerResponse.jsonUnsafe(
          { error: { code: error.code, message: error.message } },
          { status: error.status, headers: { "cache-control": "no-store" } },
        ),
      onSuccess: (body) =>
        HttpServerResponse.jsonUnsafe(body, {
          status: 200,
          headers: { "cache-control": "no-store" },
        }),
    }),
  );

const routes = (sql: SqlClient.SqlClient) => {
  const postNote = respond(
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const nodeId = yield* authenticateNode(sql, request);
      const body = yield* request.json.pipe(
        Effect.mapError(() => reject(400, "invalid_body", "请求体不是 JSON")),
      );
      const note = parseNote(body);
      if (isLedgerRejected(note)) return yield* note;
      const repo = yield* findRepo(sql, note.repo);
      return yield* appendNote(sql, { nodeId, repo, note });
    }),
  );
  const getEvents = respond(
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      yield* authenticateNode(sql, request);
      const query = parseEventsQuery(request.url);
      if (isLedgerRejected(query)) return yield* query;
      return yield* listEvents(sql, query);
    }),
  );
  return Layer.mergeAll(
    HttpRouter.add("POST", "/api/nodes/notes", postNote),
    HttpRouter.add("GET", "/api/nodes/events", getEvents),
  );
};

export const layerFor = routes;

/** Mount note routes and node snapshot reads on the shared ledger. */
export const routeLayer = Layer.unwrap(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* NodeReads.migrate;
    return Layer.mergeAll(routes(sql), NodeReads.layerLive(sql));
  }),
).pipe(Layer.provide(LedgerDb.layer));

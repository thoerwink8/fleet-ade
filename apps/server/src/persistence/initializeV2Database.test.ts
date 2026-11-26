// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "./Sqlite.ts";
import { runMigrations } from "./Migrations.ts";
import { initializeV2Database, ProcessIdentityProbe } from "./initializeV2Database.ts";
import { processIdentity } from "../legacyServerOwner.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as LegacyV1ThreadImporter from "../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";

it.effect(
  "snapshots V1, imports transcripts lazily, and preserves both databases across switches",
  () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-v1-v2-"));
    const sourcePath = NodePath.join(directory, "state.sqlite");
    const destinationPath = NodePath.join(directory, "statev2.sqlite");
    const threadId = ThreadId.make("legacy-thread");
    const seed = Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 52 });
      yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
      VALUES ('project', 'Project', '/tmp/project', '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`;
      yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, created_at, updated_at)
      VALUES (${threadId}, 'project', 'V1 thread', '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', 'default', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`;
      for (let index = 0; index < 6; index++) {
        yield* sql`INSERT INTO projection_thread_messages (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
        VALUES (${`message-${index}`}, ${threadId}, ${index % 2 ? "assistant" : "user"}, ${`Text ${index}`}, 0, ${`2026-01-0${index + 1}T00:00:00.000Z`}, ${`2026-01-0${index + 1}T00:00:00.000Z`})`;
      }
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: sourcePath })));

    return Effect.gen(function* () {
      yield* seed;
      const original = NodeFS.readFileSync(sourcePath);
      const config = yield* ServerConfig.ServerConfig;
      const layerDatabase = SqlitePersistence.layerConfig.pipe(
        Layer.provide(ServerConfig.layer({ ...config, dbPath: destinationPath })),
      );
      const layerStores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
        Layer.provideMerge(layerDatabase),
      );
      const layerSink = EventSink.layer.pipe(Layer.provide(layerStores));
      const layerImporter = LegacyV1ThreadImporter.layer.pipe(
        Layer.provideMerge(Layer.mergeAll(layerStores, layerSink)),
      );
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const legacy = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
        yield* legacy.reconcileShells;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const shell = yield* projections.getThreadProjection(threadId);
        assert.equal(shell.thread.id, threadId);
        assert.deepEqual(
          shell.messages.map((message) => message.text),
          ["Text 4", "Text 5"],
        );
        const pending =
          yield* sql`SELECT transcript_imported_at FROM orchestration_v2_legacy_imports`;
        assert.equal(pending[0]?.transcript_imported_at, null);
        yield* legacy.ensureTranscript(threadId);
        const transcript = yield* projections.getThreadProjection(threadId);
        assert.deepEqual(
          transcript.messages.map((message) => message.text),
          ["Text 0", "Text 1", "Text 2", "Text 3", "Text 4", "Text 5"],
        );
        const imported =
          yield* sql`SELECT imported_message_count, transcript_imported_at FROM orchestration_v2_legacy_imports`;
        assert.equal(imported[0]?.imported_message_count, 6);
        assert.isNotNull(imported[0]?.transcript_imported_at);
        yield* sql`CREATE TABLE v2_work (text TEXT)`;
        yield* sql`INSERT INTO v2_work VALUES ('Keep V2 work')`;
      }).pipe(Effect.provide(layerImporter));
      assert.deepEqual(NodeFS.readFileSync(sourcePath), original);
      const v1 = new NodeSqlite.DatabaseSync(sourcePath);
      try {
        assert.equal(
          v1.prepare("SELECT MAX(migration_id) AS id FROM effect_sql_migrations").get()?.id,
          52,
        );
        assert.equal(
          v1
            .prepare(
              "SELECT count(*) AS count FROM sqlite_master WHERE name = 'orchestration_v2_legacy_imports'",
            )
            .get()?.count,
          0,
        );
        v1.exec("UPDATE projection_threads SET title = 'Continued in V1'");
      } finally {
        v1.close();
      }
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        assert.equal((yield* sql`SELECT text FROM v2_work`)[0]?.text, "Keep V2 work");
        assert.equal((yield* sql`SELECT title FROM projection_threads`)[0]?.title, "V1 thread");
      }).pipe(Effect.provide(layerDatabase));
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(directory, directory).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
      Effect.ensuring(
        Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
      ),
    );
  },
);

it.effect("includes committed WAL data and does not publish a failed snapshot", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-v2-snapshot-"));
  const sourcePath = NodePath.join(directory, "state.sqlite");
  const destinationPath = NodePath.join(directory, "statev2.sqlite");
  return Effect.gen(function* () {
    NodeFS.writeFileSync(sourcePath, "invalid SQLite");
    const failure = yield* Effect.flip(initializeV2Database(destinationPath));
    assert.isFalse(Predicate.isTagged(failure.cause, "V2DatabaseImportError"));
    assert.isFalse(NodeFS.existsSync(destinationPath));
    NodeFS.unlinkSync(sourcePath);
    const source = new NodeSqlite.DatabaseSync(sourcePath);
    try {
      source.exec(
        "PRAGMA journal_mode=WAL; CREATE TABLE messages(text TEXT); INSERT INTO messages VALUES ('committed'); BEGIN; INSERT INTO messages VALUES ('uncommitted');",
      );
      yield* initializeV2Database(destinationPath);
      const copy = new NodeSqlite.DatabaseSync(destinationPath, { readOnly: true });
      try {
        assert.deepEqual(
          copy
            .prepare("SELECT text FROM messages")
            .all()
            .map((row) => row.text),
          ["committed"],
        );
      } finally {
        copy.close();
      }
      source.exec("ROLLBACK");
    } finally {
      source.close();
    }
  }).pipe(
    Effect.provide(NodeServices.layer),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true }))),
  );
});

it.effect("starts fresh without V1 and never imports over existing V2 state", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-v2-fresh-"));
  const destinationPath = NodePath.join(directory, "userdata", "statev2.sqlite");
  return Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const layerDatabase = SqlitePersistence.layerConfig.pipe(
      Layer.provide(ServerConfig.layer({ ...config, dbPath: destinationPath })),
    );
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE v2_work (text TEXT)`;
      yield* sql`INSERT INTO v2_work VALUES ('fresh V2 work')`;
    }).pipe(Effect.provide(layerDatabase));
    const sourcePath = NodePath.join(NodePath.dirname(destinationPath), "state.sqlite");
    assert.isFalse(NodeFS.existsSync(sourcePath));
    NodeFS.writeFileSync(sourcePath, "This source must never be opened once V2 exists");
    yield* initializeV2Database(destinationPath);
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      assert.equal((yield* sql`SELECT text FROM v2_work`)[0]?.text, "fresh V2 work");
    }).pipe(Effect.provide(layerDatabase));
  }).pipe(
    Effect.provide(
      ServerConfig.layerTest(directory, directory).pipe(Layer.provideMerge(NodeServices.layer)),
    ),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true }))),
  );
});

it.effect("removes copies left by a killed start, but not one that is still running", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-v2-abandoned-"));
  const killed = NodeChildProcess.spawnSync(process.execPath, ["-e", ""]).pid;
  const running = `.v2-import-${process.pid}-Kq81Zx`;
  const unrelated = ".v2-import-not-a-copy";
  return Effect.gen(function* () {
    for (const name of [`.v2-import-${killed}-Wm3nPa`, ".v2-import-Q3xZ9a"]) {
      NodeFS.mkdirSync(NodePath.join(directory, name));
      NodeFS.writeFileSync(NodePath.join(directory, name, "snapshot.sqlite"), "partial copy");
    }
    // A live copy proves its owner with the identity the importer recorded at creation.
    NodeFS.mkdirSync(NodePath.join(directory, running));
    NodeFS.writeFileSync(NodePath.join(directory, running, "snapshot.sqlite"), "partial copy");
    // oxlint-disable-next-line t3code/no-global-process-runtime -- The probe must interrogate the real host, not a test platform.
    const ownIdentity = yield* Effect.promise(() => processIdentity(process.pid, process.platform));
    assert(ownIdentity !== undefined, "the test host must answer the process start-time probe");
    NodeFS.writeFileSync(
      NodePath.join(directory, running, "owner.json"),
      JSON.stringify({ pid: process.pid, processIdentity: ownIdentity }),
    );
    NodeFS.mkdirSync(NodePath.join(directory, unrelated));
    const destinationPath = NodePath.join(directory, "statev2.sqlite");
    NodeFS.writeFileSync(destinationPath, "existing V2 database");
    yield* initializeV2Database(destinationPath);
    assert.deepEqual(
      NodeFS.readdirSync(directory).sort(),
      [running, unrelated, "statev2.sqlite"].sort(),
    );
    assert.equal(NodeFS.readFileSync(destinationPath, "utf8"), "existing V2 database");
  }).pipe(
    Effect.provide(NodeServices.layer),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true }))),
  );
});

it.effect(
  "keeps a live copy regardless of file times, removes identity mismatches and dead PIDs",
  () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-v2-reused-pid-"));
    return Effect.gen(function* () {
      // Staged before the child process starts: after the rename the copy predates its PID owner,
      // the same shape a rolled-back or low-precision creation time produces.
      const keepStaging = NodePath.join(directory, ".v2-import-000000-Zx81Qm");
      NodeFS.mkdirSync(keepStaging);
      NodeFS.writeFileSync(NodePath.join(keepStaging, "snapshot.sqlite"), "partial copy");
      const child = NodeChildProcess.spawn(process.execPath, ["-e", "process.stdin.resume()"], {
        stdio: ["pipe", "ignore", "ignore"],
        windowsHide: true,
      });
      try {
        assert(child.pid !== undefined);
        const childIdentity = yield* Effect.promise(() =>
          // oxlint-disable-next-line t3code/no-global-process-runtime -- The probe must interrogate the real host, not a test platform.
          processIdentity(child.pid!, process.platform),
        );
        assert(
          childIdentity !== undefined,
          "the test host must answer the process start-time probe",
        );
        const writeCopy = (name: string, owner: unknown) => {
          NodeFS.mkdirSync(NodePath.join(directory, name));
          NodeFS.writeFileSync(NodePath.join(directory, name, "snapshot.sqlite"), "partial copy");
          if (owner !== undefined) {
            NodeFS.writeFileSync(
              NodePath.join(directory, name, "owner.json"),
              JSON.stringify(owner),
            );
          }
        };

        // The copy predates the process — a creation-time comparison would call the process a
        // reuse — but the recorded identity matches exactly, so the live import survives.
        NodeFS.writeFileSync(
          NodePath.join(keepStaging, "owner.json"),
          JSON.stringify({ pid: child.pid, processIdentity: childIdentity }),
        );
        const keepName = `.v2-import-${child.pid}-Zx81Qm`;
        NodeFS.renameSync(keepStaging, NodePath.join(directory, keepName));

        // A live PID whose real identity differs from the recorded one never wrote this copy.
        const mismatchName = `.v2-import-${child.pid}-Ab3dEf`;
        writeCopy(mismatchName, { pid: child.pid, processIdentity: "some other boot entirely" });

        // The same live PID without identity proof (old format) is kept: reuse cannot be ruled out.
        const legacyName = `.v2-import-${child.pid}-Lg71Po`;
        writeCopy(legacyName, undefined);

        const destinationPath = NodePath.join(directory, "statev2.sqlite");
        NodeFS.writeFileSync(destinationPath, "existing V2 database");
        yield* initializeV2Database(destinationPath);

        const remaining = NodeFS.readdirSync(directory);
        assert.include(
          remaining,
          keepName,
          "an identity match proves the writer still runs, whatever the file times say",
        );
        assert.include(
          remaining,
          legacyName,
          "a live PID without identity proof cannot be told apart from the writer",
        );
        assert.notInclude(
          remaining,
          mismatchName,
          "an identity mismatch proves the PID was reused, so the copy is abandoned",
        );

        // A dead PID is abandoned even when its copy carried a complete identity record.
        const deadName = `.v2-import-2147483647-Dd42Tx`;
        writeCopy(deadName, { pid: 2_147_483_647, processIdentity: childIdentity });
        yield* initializeV2Database(destinationPath);
        assert.notInclude(NodeFS.readdirSync(directory), deadName);

        // When the probe cannot answer, live copies stay: cleanup never guesses a reuse.
        const probeFailName = `.v2-import-${child.pid}-Pf19Wz`;
        writeCopy(probeFailName, { pid: child.pid, processIdentity: childIdentity });
        yield* Effect.provideService(
          initializeV2Database(destinationPath),
          ProcessIdentityProbe,
          () => Promise.resolve(undefined),
        );
        assert.include(NodeFS.readdirSync(directory), probeFailName);
      } finally {
        child.kill();
      }
    }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.ensuring(
        Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
      ),
    );
  },
);

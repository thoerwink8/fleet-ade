import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
  SshConnectionProfile,
  SshConnectionRegistration,
} from "../connection/catalog.ts";
import {
  BearerConnectionTarget,
  ConnectionTransientError,
  PrimaryConnectionTarget,
  SshConnectionTarget,
} from "../connection/model.ts";
import {
  PullRequestRoutingPermissions,
  makePullRequestRoutingPermissions,
} from "../connection/pullRequestRoutingPermissions.ts";
import {
  ConnectionCatalogDocument,
  EMPTY_CONNECTION_CATALOG_DOCUMENT,
  catalogRoutes,
  setRoutesInCatalog,
  registerConnectionInCatalog,
  removeConnectionFromCatalog,
  setConnectionEnabledInCatalog,
} from "./storageDocument.ts";

const decodeConnectionCatalogDocument = Schema.decodeUnknownEffect(ConnectionCatalogDocument);

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const decodeCatalogDocument = Schema.decodeUnknownSync(ConnectionCatalogDocument);

const REMOTE_TARGET = new BearerConnectionTarget({
  environmentId: ENVIRONMENT_ID,
  label: "Remote",
  connectionId: "remote-1",
});
const REMOTE_PROFILE = new BearerConnectionProfile({
  connectionId: REMOTE_TARGET.connectionId,
  environmentId: ENVIRONMENT_ID,
  label: REMOTE_TARGET.label,
  httpBaseUrl: "https://other.example.test",
  wsBaseUrl: "wss://other.example.test",
});
const BEARER_TARGET = new BearerConnectionTarget({
  environmentId: ENVIRONMENT_ID,
  label: "Remote",
  connectionId: "bearer-1",
});
const BEARER_PROFILE = new BearerConnectionProfile({
  connectionId: BEARER_TARGET.connectionId,
  environmentId: ENVIRONMENT_ID,
  label: BEARER_TARGET.label,
  httpBaseUrl: "https://remote.example.test",
  wsBaseUrl: "wss://remote.example.test",
});
const BEARER_CREDENTIAL = new BearerConnectionCredential({
  token: "bearer-token",
});
const bearerRegistration = () =>
  new BearerConnectionRegistration({
    target: BEARER_TARGET,
    profile: BEARER_PROFILE,
    credential: BEARER_CREDENTIAL,
  });
// Relay-era access token; stored documents may still carry such rows.
const REMOTE_TOKEN = {
  environmentId: ENVIRONMENT_ID,
  accessToken: "dpop-token",
  expiresAtEpochMs: 1_000_000,
};

describe("ConnectionCatalogDocument", () => {
  it.effect("persists explicit GitHub trust and forgets it when a connection is removed", () =>
    Effect.gen(function* () {
      let document = EMPTY_CONNECTION_CATALOG_DOCUMENT;
      const entry = { target: BEARER_TARGET, profile: Option.some(BEARER_PROFILE), enabled: true };
      const storage = {
        read: Effect.sync(() => document.githubRoutingPermissions ?? []),
        write: (githubRoutingPermissions: NonNullable<typeof document.githubRoutingPermissions>) =>
          Effect.gen(function* () {
            document = yield* decodeConnectionCatalogDocument({
              ...document,
              githubRoutingPermissions,
            }).pipe(Effect.orDie);
          }),
      };
      const permissions = yield* makePullRequestRoutingPermissions(storage);
      expect(yield* permissions.get(entry)).toBe("off");
      yield* permissions.set(entry, "read");
      const restarted = yield* makePullRequestRoutingPermissions(storage);
      expect(yield* restarted.get(entry)).toBe("read");

      const changedEndpoint = {
        ...entry,
        profile: Option.some(
          new BearerConnectionProfile({
            ...BEARER_PROFILE,
            httpBaseUrl: "https://different.example.test",
          }),
        ),
      };
      expect(yield* restarted.get(changedEndpoint)).toBe("off");
      expect(
        yield* restarted.get({
          ...entry,
          profile: Option.some(
            new BearerConnectionProfile({
              ...BEARER_PROFILE,
              wsBaseUrl: "wss://different.example.test",
            }),
          ),
        }),
      ).toBe("off");
      yield* restarted.set(entry, "read-write");
      expect(yield* restarted.get(entry)).toBe("read-write");
      yield* restarted.forget(ENVIRONMENT_ID);
      expect(yield* restarted.get(entry)).toBe("off");
      const afterRemoval = yield* makePullRequestRoutingPermissions(storage);
      expect(yield* afterRemoval.get(entry)).toBe("off");

      yield* permissions.set(entry, "read");
      document = removeConnectionFromCatalog(document, ENVIRONMENT_ID);
      const afterCatalogRemoval = yield* makePullRequestRoutingPermissions(storage);
      expect(yield* afterCatalogRemoval.get(entry)).toBe("off");
    }),
  );

  it.effect("requires explicit trust for primary, remote, and SSH connections independently", () =>
    Effect.gen(function* () {
      const permissions = yield* makePullRequestRoutingPermissions({
        read: Effect.succeed([]),
        write: () => Effect.void,
      });
      const entries = [
        {
          target: new PrimaryConnectionTarget({
            environmentId: ENVIRONMENT_ID,
            label: "本地",
            httpBaseUrl: "http://localhost:3000",
            wsBaseUrl: "ws://localhost:3000",
          }),
          profile: Option.none(),
          enabled: true,
        },
        { target: REMOTE_TARGET, profile: Option.some(REMOTE_PROFILE), enabled: true },
        {
          enabled: true,
          target: new SshConnectionTarget({
            environmentId: ENVIRONMENT_ID,
            label: "SSH",
            connectionId: "ssh-1",
          }),
          profile: Option.some(
            new SshConnectionProfile({
              environmentId: ENVIRONMENT_ID,
              label: "SSH",
              connectionId: "ssh-1",
              target: { alias: "work", hostname: "work.example.test", username: "maria", port: 22 },
            }),
          ),
        },
      ];
      for (const entry of entries) {
        expect(yield* permissions.get(entry)).toBe("off");
        yield* permissions.set(entry, "read");
        expect(yield* permissions.get(entry)).toBe("read");
        yield* permissions.set(entry, "off");
        expect(yield* permissions.get(entry)).toBe("off");
      }
    }),
  );

  it.effect("does not enable GitHub routing when permission persistence fails", () =>
    Effect.gen(function* () {
      const entry = { target: BEARER_TARGET, profile: Option.some(BEARER_PROFILE), enabled: true };
      expect(yield* (yield* PullRequestRoutingPermissions).get(entry)).toBe("off");
      const permissions = yield* makePullRequestRoutingPermissions({
        read: Effect.succeed([]),
        write: () =>
          Effect.fail(
            new ConnectionTransientError({
              reason: "remote-unavailable",
              detail: "storage unavailable",
            }),
          ),
      });
      yield* permissions.set(entry, "read-write").pipe(Effect.flip);
      expect(yield* permissions.get(entry)).toBe("off");
    }),
  );

  it("replaces a registered connection's records", () => {
    const registered = registerConnectionInCatalog(
      {
        ...EMPTY_CONNECTION_CATALOG_DOCUMENT,
        remoteDpopTokens: [REMOTE_TOKEN],
      },
      bearerRegistration(),
    );
    expect(registered.targets).toEqual([BEARER_TARGET]);
    expect(registered.profiles).toEqual([BEARER_PROFILE]);
    expect(registered.credentials).toHaveLength(1);
    expect(registered.remoteDpopTokens).toEqual([REMOTE_TOKEN]);
  });

  it("removes every catalog record owned by an explicit disconnect", () => {
    const registered = registerConnectionInCatalog(
      {
        ...EMPTY_CONNECTION_CATALOG_DOCUMENT,
        remoteDpopTokens: [REMOTE_TOKEN],
      },
      bearerRegistration(),
    );

    expect(removeConnectionFromCatalog(registered, ENVIRONMENT_ID)).toEqual(
      EMPTY_CONNECTION_CATALOG_DOCUMENT,
    );
  });

  it("decodes a document written before the disabled list existed", () => {
    const decoded = decodeCatalogDocument({
      schemaVersion: 1,
      targets: [],
      profiles: [],
      credentials: [],
      remoteDpopTokens: [],
    });

    expect(decoded.disabledEnvironmentIds).toEqual([]);
  });

  it("drops a saved T3 Connect target a newer document cannot express", () => {
    const decoded = decodeCatalogDocument({
      schemaVersion: 1,
      targets: [
        { _tag: "RelayConnectionTarget", environmentId: ENVIRONMENT_ID, label: "Remote" },
        {
          _tag: "BearerConnectionTarget",
          environmentId: ENVIRONMENT_ID,
          label: "Remote",
          connectionId: "bearer-1",
        },
      ],
      profiles: [],
      credentials: [],
      remoteDpopTokens: [],
    });

    expect(decoded.targets).toEqual([BEARER_TARGET]);
  });

  it("switches a saved environment off and back on without touching its records", () => {
    const registered = registerConnectionInCatalog(
      EMPTY_CONNECTION_CATALOG_DOCUMENT,
      bearerRegistration(),
    );

    const disabled = setConnectionEnabledInCatalog(registered, ENVIRONMENT_ID, false);
    expect(disabled.disabledEnvironmentIds).toEqual([ENVIRONMENT_ID]);
    expect(disabled.targets).toEqual(registered.targets);
    expect(disabled.credentials).toEqual(registered.credentials);
    expect(
      setConnectionEnabledInCatalog(disabled, ENVIRONMENT_ID, false).disabledEnvironmentIds,
    ).toEqual([ENVIRONMENT_ID]);

    expect(
      setConnectionEnabledInCatalog(disabled, ENVIRONMENT_ID, true).disabledEnvironmentIds,
    ).toEqual([]);
    expect(
      registerConnectionInCatalog(disabled, bearerRegistration()).disabledEnvironmentIds,
    ).toEqual([ENVIRONMENT_ID]);
    expect(removeConnectionFromCatalog(disabled, ENVIRONMENT_ID).disabledEnvironmentIds).toEqual(
      [],
    );
  });

  it("persists the normalized SSH profile and its paired token beside its target", () => {
    const target = new SshConnectionTarget({
      environmentId: ENVIRONMENT_ID,
      label: "SSH",
      connectionId: "ssh-1",
    });
    const profile = new SshConnectionProfile({
      connectionId: target.connectionId,
      environmentId: target.environmentId,
      label: target.label,
      target: {
        alias: "devbox",
        hostname: "devbox.example.test",
        username: "developer",
        port: 22,
      },
    });
    const document = registerConnectionInCatalog(
      EMPTY_CONNECTION_CATALOG_DOCUMENT,
      new SshConnectionRegistration({ target, profile, credential: BEARER_CREDENTIAL }),
    );

    expect(document.targets).toEqual([target]);
    expect(document.profiles).toEqual([profile]);
    expect(document.credentials).toEqual([
      { connectionId: target.connectionId, credential: BEARER_CREDENTIAL },
    ]);
    // Removing the route forgets its token too.
    expect(removeConnectionFromCatalog(document, ENVIRONMENT_ID).credentials).toEqual([]);
  });

  it("keeps every route of an environment and drops only a removed route's records", () => {
    const remoteProfile = new BearerConnectionProfile({
      ...BEARER_PROFILE,
      connectionId: REMOTE_TARGET.connectionId,
      httpBaseUrl: "https://remote.other.test",
      wsBaseUrl: "wss://remote.other.test",
    });
    const remoteCredential = new BearerConnectionCredential({ token: "remote-token" });
    const withBoth = registerConnectionInCatalog(
      registerConnectionInCatalog(EMPTY_CONNECTION_CATALOG_DOCUMENT, bearerRegistration()),
      new BearerConnectionRegistration({
        target: REMOTE_TARGET,
        profile: remoteProfile,
        credential: remoteCredential,
      }),
      [BEARER_TARGET, REMOTE_TARGET],
    );
    expect(catalogRoutes(withBoth, ENVIRONMENT_ID)).toEqual([BEARER_TARGET, REMOTE_TARGET]);
    expect(withBoth.credentials).toHaveLength(2);

    const remoteOnly = setRoutesInCatalog(withBoth, ENVIRONMENT_ID, [REMOTE_TARGET]);
    expect(remoteOnly.targets).toEqual([REMOTE_TARGET]);
    expect(remoteOnly.profiles).toEqual([remoteProfile]);
    expect(remoteOnly.credentials).toHaveLength(1);

    const bearerOnly = setRoutesInCatalog(withBoth, ENVIRONMENT_ID, [BEARER_TARGET]);
    expect(bearerOnly.credentials).toHaveLength(1);
    expect(bearerOnly.profiles).toEqual([BEARER_PROFILE]);
  });

  it("keeps an environment's position in the catalog when its routes change", () => {
    const other = new BearerConnectionTarget({
      environmentId: EnvironmentId.make("environment-2"),
      label: "其他",
      connectionId: "other-1",
    });
    const document = {
      ...EMPTY_CONNECTION_CATALOG_DOCUMENT,
      targets: [REMOTE_TARGET, other],
    };
    expect(
      setRoutesInCatalog(document, ENVIRONMENT_ID, [BEARER_TARGET, REMOTE_TARGET]).targets,
    ).toEqual([BEARER_TARGET, REMOTE_TARGET, other]);
  });
});

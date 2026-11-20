import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
// @effect-diagnostics nodeBuiltinImport:off -- ledger resides under the server state directory.
import * as NodePath from "node:path";

import * as ServerConfig from "../config.ts";

export const layer = Layer.unwrap(
  Effect.map(ServerConfig.ServerConfig, ({ stateDir }) =>
    NodeSqliteClient.layer({ filename: NodePath.join(stateDir, "ledger.sqlite") }),
  ),
);

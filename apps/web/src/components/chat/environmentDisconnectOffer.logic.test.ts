import { EnvironmentId } from "@t3tools/contracts";
import {
  BearerConnectionTarget,
  PrimaryConnectionTarget,
  SshConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { describe, expect, it } from "vite-plus/test";

import { canOfferEnvironmentDisconnect } from "./environmentDisconnectOffer.logic";

const environmentId = EnvironmentId.make("env-1");
const label = "办公室电脑";

describe("canOfferEnvironmentDisconnect", () => {
  it.each([
    [
      "before the delay",
      false,
      new BearerConnectionTarget({ environmentId, label, connectionId: "remote" }),
      false,
    ],
    ["without a machine", true, null, false],
    [
      "this app's own machine",
      true,
      new PrimaryConnectionTarget({
        environmentId,
        label,
        httpBaseUrl: "http://127.0.0.1",
        wsBaseUrl: "ws://127.0.0.1",
      }),
      false,
    ],
    [
      "the desktop's local machine",
      true,
      new BearerConnectionTarget({ environmentId, label, connectionId: "local:backend" }),
      false,
    ],
    [
      "a remote machine",
      true,
      new BearerConnectionTarget({ environmentId, label, connectionId: "remote" }),
      true,
    ],
    [
      "a machine reached over ssh",
      true,
      new SshConnectionTarget({ environmentId, label, connectionId: "ssh-1" }),
      true,
    ],
  ])("%s", (_label, delayElapsed, target, expected) => {
    expect(canOfferEnvironmentDisconnect({ delayElapsed, target })).toBe(expected);
  });
});

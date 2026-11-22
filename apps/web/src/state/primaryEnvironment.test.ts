import { isClientHostEnvironment } from "./clientHostEnvironment";
import {
  PrimaryConnectionTarget,
  SshConnectionTarget,
  RelayConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

const PRIMARY = EnvironmentId.make("primary");
const SERVICE = EnvironmentId.make("service");
const REMOTE = EnvironmentId.make("remote");

it("recognizes the desktop host service and direct browser loopback, excluding remote primaries", () => {
  const target = (httpBaseUrl: string) =>
    new PrimaryConnectionTarget({
      environmentId: PRIMARY,
      label: "本地",
      httpBaseUrl,
      wsBaseUrl: "ws://localhost/ws",
    });
  expect(isClientHostEnvironment(SERVICE, "service", null, true)).toBe(true);
  expect(isClientHostEnvironment(REMOTE, "service", target("https://remote.example"), false)).toBe(
    false,
  );
  expect(isClientHostEnvironment(PRIMARY, null, target("http://localhost:3000"), false)).toBe(true);
  expect(isClientHostEnvironment(PRIMARY, null, target("http://127.0.0.1:3000"), false)).toBe(true);
  expect(isClientHostEnvironment(PRIMARY, null, target("https://remote.example"), true)).toBe(true);
  expect(isClientHostEnvironment(REMOTE, null, null, true)).toBe(false);
  for (const target of [
    new SshConnectionTarget({ environmentId: REMOTE, label: "SSH", connectionId: "ssh-1" }),
    new RelayConnectionTarget({ environmentId: REMOTE, label: "Relay" }),
  ]) {
    expect(isClientHostEnvironment(REMOTE, "service", target, true)).toBe(false);
  }
});

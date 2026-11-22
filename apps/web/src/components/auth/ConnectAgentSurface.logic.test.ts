import { expect, it } from "vite-plus/test";
import { AuthMcpClientAccess } from "@t3tools/contracts";

import {
  agentRedirectUrl,
  resolveApprovalDecision,
  resolveMcpAccess,
} from "./ConnectAgentSurface.logic";

it("checks a typed code even in a signed-in browser, and approves without one at Read only", () => {
  const signedOut = {
    clientName: "Poke",
    redirectHost: "poke.com",
    environmentHost: "prod-a1.relay.example.invalid",
  };
  const details = { ...signedOut, csrfToken: "csrf", oneClickAccess: AuthMcpClientAccess.literals };
  const access = resolveMcpAccess(null, false);

  // A typed code starts at Auto, and an expired one must fail rather than fall back to this session.
  expect(
    resolveApprovalDecision({
      code: " 7K2P9QXR4MZT ",
      access: resolveMcpAccess(null, true),
      details,
    }),
  ).toEqual({ _tag: "pairing-code", access: "auto", code: "7K2P9QXR4MZT" });
  expect(resolveApprovalDecision({ code: "auto-q8rz3nwd5ktc", access, details })).toEqual({
    _tag: "pairing-code",
    access: "auto",
    code: "auto-q8rz3nwd5ktc",
  });
  expect(resolveApprovalDecision({ code: "", access, details })).toEqual({
    _tag: "browser-session",
    access: "read-only",
    csrfToken: "csrf",
  });
  expect(resolveApprovalDecision({ code: "", access, details: signedOut })).toBeNull();
});

it("follows only https or loopback http redirects to an agent", () => {
  expect(agentRedirectUrl("https://www.cursor.com/cb?code=x")).toBe(
    "https://www.cursor.com/cb?code=x",
  );
  expect(agentRedirectUrl("http://localhost:51234/callback?code=x")).toBe(
    "http://localhost:51234/callback?code=x",
  );
  for (const url of [
    "javascript:alert(document.domain)",
    "data:text/html,hi",
    "http://evil.example/cb",
    "not a url",
  ]) {
    expect(agentRedirectUrl(url), url).toBeNull();
  }
});

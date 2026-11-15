// Git credential helper + gh token source (`get|store|erase|token`) for thoerwink8/fleet-ade only.
// Mints 1h GitHub App installation tokens from /etc/fleet-ade/github-app.json; never answers other remotes.
// Must stay dependency-free because it runs under /home/ade/.local Node.

import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const OWNER = "thoerwink8";
const REPO = "fleet-ade";
const CREDENTIALS_PATH = process.env.FLEET_ADE_GITHUB_APP_JSON ?? "/etc/fleet-ade/github-app.json";
const CACHE_PATH =
  process.env.FLEET_ADE_GITHUB_APP_TOKEN_CACHE ??
  NodePath.join(
    process.env.XDG_CACHE_HOME ?? NodePath.join(process.env.HOME ?? "/home/ade", ".cache"),
    "fleet-ade",
    "github-app-token.json",
  );
const API = "https://api.github.com";
// Renew when less than this is left, so a token handed out never dies mid-push.
const MIN_REMAINING_MS = 10 * 60 * 1000;

const base64url = (input) => Buffer.from(input).toString("base64url");

function appJwt() {
  const {
    id,
    client_id: clientId,
    pem,
  } = JSON.parse(NodeFS.readFileSync(CREDENTIALS_PATH, "utf8"));
  const issuer = clientId ?? id;
  if (!issuer || typeof pem !== "string") {
    throw new Error(`${CREDENTIALS_PATH} must contain id or client_id, and pem`);
  }
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(
    JSON.stringify({ iat: now - 60, exp: now + 540, iss: String(issuer) }),
  )}`;
  const signature = NodeCrypto.createSign("RSA-SHA256")
    .update(unsigned)
    .sign(pem)
    .toString("base64url");
  return `${unsigned}.${signature}`;
}

async function github(path, jwt, init = {}) {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${jwt}`,
      "x-github-api-version": "2022-11-28",
      "user-agent": "fleet-ade-git-credential",
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(`GitHub ${init.method ?? "GET"} ${path} failed: HTTP ${response.status}`);
  }
  return response.json();
}

function readCachedToken() {
  try {
    const { token, expiresAt } = JSON.parse(NodeFS.readFileSync(CACHE_PATH, "utf8"));
    if (typeof token === "string" && Date.parse(expiresAt) - Date.now() > MIN_REMAINING_MS) {
      return token;
    }
  } catch {
    // No usable cache: mint a new token.
  }
  return undefined;
}

async function installationToken() {
  const cached = readCachedToken();
  if (cached) return cached;

  const jwt = appJwt();
  const installation = await github(`/repos/${OWNER}/${REPO}/installation`, jwt);
  const minted = await github(`/app/installations/${installation.id}/access_tokens`, jwt, {
    method: "POST",
    body: JSON.stringify({ repositories: [REPO] }),
  });

  NodeFS.mkdirSync(NodePath.dirname(CACHE_PATH), { recursive: true, mode: 0o700 });
  const tmpPath = `${CACHE_PATH}.${process.pid}.tmp`;
  NodeFS.writeFileSync(
    tmpPath,
    JSON.stringify({ token: minted.token, expiresAt: minted.expires_at }),
    {
      mode: 0o600,
    },
  );
  NodeFS.renameSync(tmpPath, CACHE_PATH);
  return minted.token;
}

function readStdin() {
  try {
    return NodeFS.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function parseAttributes(text) {
  const attributes = {};
  for (const line of text.split("\n")) {
    const separator = line.indexOf("=");
    if (separator > 0) attributes[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return attributes;
}

function isFleetAdeRequest({ protocol, host, path }) {
  if (protocol !== "https" || host !== "github.com" || !path) return false;
  const normalized = path.replace(/\.git$/, "");
  return normalized === `${OWNER}/${REPO}`;
}

async function main() {
  const command = process.argv[2];
  if (command === "token") {
    process.stdout.write(`${await installationToken()}\n`);
    return;
  }
  if (command === "erase") {
    // git erases a credential the server rejected; drop the cache so the next call mints a new one.
    const request = parseAttributes(readStdin());
    if (isFleetAdeRequest(request)) NodeFS.rmSync(CACHE_PATH, { force: true });
    return;
  }
  if (command === "get") {
    const request = parseAttributes(readStdin());
    if (!isFleetAdeRequest(request)) return;
    const token = await installationToken();
    process.stdout.write(`username=x-access-token\npassword=${token}\n`);
    return;
  }
  // `store` and unknown commands: nothing to do, the token is always re-minted from the App.
}

main().catch((error) => {
  process.stderr.write(`fleet-ade git credential helper: ${error.message}\n`);
  process.exit(1);
});

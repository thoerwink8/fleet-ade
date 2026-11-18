#!/usr/bin/env bash
# France VPS headless ADE installer (WireGuard-only, isolated `ade` user, Node 26 in ~/.local).
# Usage:
#   sudo bash scripts/deploy/france-install.sh <40-char-commit-sha> \
#     [--repo-url https://github.com/thoerwink8/fleet-ade.git] \
#     [--wg-iface wg-fleet] \
#     --wg-subnet <cidr> \
#     --wg-host <ip> \
#     [--port 3773] \
#     [--max-sessions 2] \
#     [--github-app-source <github-app-manifest.json>]   # only needed while /etc/fleet-ade/github-app.json does not exist

set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "ERROR: run as root (for example: sudo bash $0 <commit-sha>)." >&2
  exit 1
fi

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <40-char-commit-sha> [--repo-url <url>] [--wg-iface <iface>] [--wg-subnet <cidr>] [--wg-host <ip>] [--port <port>] [--max-sessions <n>]" >&2
  exit 1
fi

COMMIT_SHA="$1"
shift

if [[ ! "${COMMIT_SHA}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "ERROR: expected a 40-character lowercase hex commit SHA, got: ${COMMIT_SHA}" >&2
  exit 1
fi

REPO_URL="https://github.com/thoerwink8/fleet-ade.git"
WG_IFACE="wg-fleet"
WG_SUBNET="${FLEET_ADE_WG_SUBNET:-}"
WG_HOST="${FLEET_ADE_WG_HOST:-}"
ADE_PORT="3773"
MAX_SESSIONS="2"
ADE_USER="ade"
ADE_HOME="/home/${ADE_USER}"
ADE_ROOT="/var/lib/fleet-ade"
APP_DIR="${ADE_ROOT}/app"
DATA_HOME="${ADE_ROOT}/home"
REPOS_DIR="${ADE_ROOT}/repos"
NODE_VERSION="26.12.1"
PNPM_VERSION="12.14.0"
GITHUB_APP_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo-url)
      REPO_URL="$2"
      shift 2
      ;;
    --wg-iface)
      WG_IFACE="$2"
      shift 2
      ;;
    --wg-subnet)
      WG_SUBNET="$2"
      shift 2
      ;;
    --wg-host)
      WG_HOST="$2"
      shift 2
      ;;
    --port)
      ADE_PORT="$2"
      shift 2
      ;;
    --max-sessions)
      MAX_SESSIONS="$2"
      shift 2
      ;;
    --github-app-source)
      GITHUB_APP_ARGS=(--source "$2")
      shift 2
      ;;
    *)
      echo "ERROR: unknown argument: $1" >&2
      exit 1
      ;;
  esac
done
if [[ -z "${WG_SUBNET}" || -z "${WG_HOST}" ]]; then
  echo "ERROR: --wg-subnet and --wg-host are required (or set FLEET_ADE_WG_SUBNET and FLEET_ADE_WG_HOST)." >&2
  exit 1
fi

ARCH="$(uname -m)"
if [[ "${ARCH}" != "x86_64" ]]; then
  echo "ERROR: expected x86_64 host, got ${ARCH}" >&2
  exit 1
fi

if ! ip -4 addr show dev "${WG_IFACE}" | grep -Fq "inet ${WG_HOST}/"; then
  echo "ERROR: WireGuard address ${WG_HOST} is not present on interface ${WG_IFACE}." >&2
  exit 1
fi

SYSTEM_NODE_BEFORE="$(/usr/bin/node --version 2>/dev/null || echo none)"
echo "[1/9] Ensuring dedicated system user '${ADE_USER}' and directories..."
if ! id -u "${ADE_USER}" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "${ADE_HOME}" --shell /bin/bash "${ADE_USER}"
fi
chmod 0750 "${ADE_HOME}"
chown "${ADE_USER}:${ADE_USER}" "${ADE_HOME}"

install -d -m 0750 -o "${ADE_USER}" -g "${ADE_USER}" \
  "${ADE_HOME}/.local" \
  "${ADE_HOME}/.local/bin" \
  "${ADE_HOME}/.local/share" \
  "${ADE_HOME}/.cache" \
  "${ADE_HOME}/.cache/corepack" \
  "${ADE_HOME}/.ssh" \
  "${ADE_ROOT}" \
  "${APP_DIR}" \
  "${DATA_HOME}" \
  "${DATA_HOME}/userdata" \
  "${REPOS_DIR}"
chmod 0700 "${ADE_HOME}/.ssh"
install -d -m 0750 -o root -g "${ADE_USER}" /etc/fleet-ade

cat >/etc/fleet-ade/service.env <<EOF
FLEET_ADE_WG_HOST=${WG_HOST}
FLEET_ADE_PORT=${ADE_PORT}
FLEET_ADE_MAX_CONCURRENT_SESSIONS=${MAX_SESSIONS}
EOF
chown root:"${ADE_USER}" /etc/fleet-ade/service.env
chmod 0640 /etc/fleet-ade/service.env

echo "[2/9] Installing Node v${NODE_VERSION} + pnpm@${PNPM_VERSION} under ${ADE_HOME}/.local (leaving system Node untouched)..."
NODE_DIR="${ADE_HOME}/.local/node-v${NODE_VERSION}-linux-x64"
NODE_LINK="${ADE_HOME}/.local/node"
if [[ ! -x "${NODE_DIR}/bin/node" ]]; then
  TMP_TAR="$(mktemp /tmp/node-v${NODE_VERSION}-XXXXXX.tar.xz)"
  TMP_SHA="$(mktemp /tmp/node-v${NODE_VERSION}-SHASUMS-XXXXXX.txt)"
  trap 'rm -f "${TMP_TAR}" "${TMP_SHA}"' EXIT
  curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" -o "${TMP_TAR}"
  curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" -o "${TMP_SHA}"
  EXPECTED_SHA="$(awk "/  node-v${NODE_VERSION}-linux-x64\\.tar\\.xz\$/ { print \$1 }" "${TMP_SHA}")"
  if [[ -z "${EXPECTED_SHA}" ]]; then
    echo "ERROR: SHA256 entry for node-v${NODE_VERSION}-linux-x64.tar.xz not found." >&2
    exit 1
  fi
  echo "${EXPECTED_SHA}  ${TMP_TAR}" | sha256sum -c -
  tar -xJf "${TMP_TAR}" -C "${ADE_HOME}/.local"
  chown -R "${ADE_USER}:${ADE_USER}" "${NODE_DIR}"
  rm -f "${TMP_TAR}" "${TMP_SHA}"
  trap - EXIT
fi
ln -sfn "${NODE_DIR}" "${NODE_LINK}"
chown -h "${ADE_USER}:${ADE_USER}" "${NODE_LINK}"

PNPM_PREFIX="${ADE_HOME}/.local/pnpm-${PNPM_VERSION}"
install -d -m 0750 -o "${ADE_USER}" -g "${ADE_USER}" "${PNPM_PREFIX}"
if [[ ! -x "${PNPM_PREFIX}/bin/pnpm" ]]; then
  sudo -u "${ADE_USER}" env \
    HOME="${ADE_HOME}" \
    PATH="${NODE_LINK}/bin:/usr/local/bin:/usr/bin:/bin" \
    npm_config_update_notifier=false \
    "${NODE_LINK}/bin/npm" install --global --allow-scripts=pnpm --prefix "${PNPM_PREFIX}" "pnpm@${PNPM_VERSION}"
fi

cat >"${ADE_HOME}/.local/bin/pnpm" <<EOF
#!/usr/bin/env bash
set -euo pipefail
export PATH="/home/ade/.local/node/bin:/home/ade/.local/bin:\${PATH:-/usr/local/bin:/usr/bin:/bin}"
exec ${PNPM_PREFIX}/bin/pnpm "\$@"
EOF
chown "${ADE_USER}:${ADE_USER}" "${ADE_HOME}/.local/bin/pnpm"
chmod 0755 "${ADE_HOME}/.local/bin/pnpm"

if ! grep -Fq 'FLEET_ADE_PATH_SETUP' "${ADE_HOME}/.profile" 2>/dev/null; then
  cat >>"${ADE_HOME}/.profile" <<'EOF'

# FLEET_ADE_PATH_SETUP
export PATH="/home/ade/.local/bin:/home/ade/.local/node/bin:/home/ade/.grok/bin:${PATH}"
EOF
  chown "${ADE_USER}:${ADE_USER}" "${ADE_HOME}/.profile"
fi
chown -R "${ADE_USER}:${ADE_USER}" "${ADE_HOME}/.cache" "${ADE_HOME}/.local"

SYSTEM_NODE_AFTER="$(/usr/bin/node --version 2>/dev/null || echo none)"
if [[ "${SYSTEM_NODE_BEFORE}" != "${SYSTEM_NODE_AFTER}" ]]; then
  echo "ERROR: /usr/bin/node changed unexpectedly (${SYSTEM_NODE_BEFORE} -> ${SYSTEM_NODE_AFTER})!" >&2
  exit 1
fi

echo "[3/9] Ensuring isolated Grok CLI in ${ADE_HOME}/.grok (without copying any other user's credentials)..."
if [[ ! -x "${ADE_HOME}/.grok/bin/grok" ]]; then
  sudo -u "${ADE_USER}" env \
    HOME="${ADE_HOME}" \
    PATH="${ADE_HOME}/.local/bin:${NODE_LINK}/bin:/usr/local/bin:/usr/bin:/bin" \
    bash -lc "curl -fsSL https://x.ai/cli/install.sh | bash"
fi
install -d -m 0750 -o "${ADE_USER}" -g "${ADE_USER}" "${ADE_HOME}/.grok"
if [[ ! -f "${ADE_HOME}/.grok/config.toml" ]]; then
  cat >"${ADE_HOME}/.grok/config.toml" <<'EOF'
[folder_trust]
enabled = false

[features]
ask_user_question = false
EOF
  chown "${ADE_USER}:${ADE_USER}" "${ADE_HOME}/.grok/config.toml"
  chmod 0640 "${ADE_HOME}/.grok/config.toml"
fi

echo "[4/9] Setting up GitHub App credentials, then fetching commit ${COMMIT_SHA}..."
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bash "${SCRIPT_DIR}/france-github-app.sh" "${GITHUB_APP_ARGS[@]}"
sudo -u "${ADE_USER}" bash -lc "
  set -euo pipefail
  touch '${ADE_HOME}/.ssh/known_hosts'
  chmod 0600 '${ADE_HOME}/.ssh/known_hosts'
  if ! ssh-keygen -F github.com -f '${ADE_HOME}/.ssh/known_hosts' >/dev/null 2>&1; then
    ssh-keyscan -t ed25519,rsa github.com >> '${ADE_HOME}/.ssh/known_hosts' 2>/dev/null
  fi
  if [[ ! -d '${APP_DIR}/.git' ]]; then
    git init '${APP_DIR}'
    git -C '${APP_DIR}' remote add origin '${REPO_URL}'
  else
    git -C '${APP_DIR}' remote set-url origin '${REPO_URL}'
  fi
  git -C '${APP_DIR}' fetch --no-tags --depth 1 origin '${COMMIT_SHA}'
  git -C '${APP_DIR}' checkout --force --detach FETCH_HEAD
  ACTUAL_SHA=\"\$(git -C '${APP_DIR}' rev-parse HEAD)\"
  if [[ \"\${ACTUAL_SHA}\" != '${COMMIT_SHA}' ]]; then
    echo \"ERROR: checked out \${ACTUAL_SHA}, expected ${COMMIT_SHA}\" >&2
    exit 1
  fi
"

echo "[5/9] Building Fleet ADE inside transient systemd cgroup (outside user-0.slice 3G cap)..."
systemd-run --wait --pipe --collect \
  --unit="fleet-ade-build-$(date +%s)" \
  -p Slice=ade-build.slice \
  -p CPUAccounting=yes \
  -p MemoryAccounting=yes \
  -p CPUWeight=20 \
  -p IOWeight=20 \
  -p CPUQuota=200% \
  -p MemoryHigh=3584M \
  -p MemoryMax=4096M \
  -p Nice=15 \
  --uid="${ADE_USER}" \
  --gid="${ADE_USER}" \
  --working-directory="${APP_DIR}" \
  -E HOME="${ADE_HOME}" \
  -E PATH="${ADE_HOME}/.local/bin:${NODE_LINK}/bin:${APP_DIR}/node_modules/.bin:/usr/local/bin:/usr/bin:/bin" \
  -E XDG_DATA_HOME="${ADE_HOME}/.local/share" \
  -E XDG_CACHE_HOME="${ADE_HOME}/.cache" \
  -E COREPACK_HOME="${ADE_HOME}/.cache/corepack" \
  -E COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  -E COREPACK_ENABLE_AUTO_PIN=0 \
  -E CI=true \
  -E T3CODE_TELEMETRY_ENABLED=false \
  -E OTEL_SDK_DISABLED=true \
  -E T3CODE_OTEL_SDK_DISABLED=true \
  -E DO_NOT_TRACK=1 \
  /bin/bash -lc "pnpm store prune && pnpm install --frozen-lockfile && ./node_modules/.bin/vp run --filter t3 build"

echo "[6/9] Installing t3 CLI wrapper and merging headless server settings..."
cat >"${ADE_HOME}/.local/bin/t3" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
export T3CODE_HOME="${T3CODE_HOME:-/var/lib/fleet-ade/home}"
export T3CODE_TELEMETRY_ENABLED=false
export OTEL_SDK_DISABLED=true
export T3CODE_OTEL_SDK_DISABLED=true
export DO_NOT_TRACK=1
exec /home/ade/.local/node/bin/node /var/lib/fleet-ade/app/apps/server/dist/bin.mjs "$@"
EOF
chown "${ADE_USER}:${ADE_USER}" "${ADE_HOME}/.local/bin/t3"
chmod 0755 "${ADE_HOME}/.local/bin/t3"

sudo -u "${ADE_USER}" "${NODE_LINK}/bin/node" - "${DATA_HOME}/userdata/settings.json" "${MAX_SESSIONS}" "${ADE_HOME}/.grok/bin/grok" <<'NODE'
const fs = require("node:fs");
const [settingsPath, maxSessionsRaw, grokBinaryPath] = process.argv.slice(2);
const maxConcurrentSessions = Number.parseInt(maxSessionsRaw, 10);
let current = {};
if (fs.existsSync(settingsPath)) {
  const text = fs.readFileSync(settingsPath, "utf8").trim();
  if (text.length > 0) {
    current = JSON.parse(text);
  }
}
const existingInstances =
  current.providerInstances && typeof current.providerInstances === "object"
    ? current.providerInstances
    : {};
const existingGrok =
  existingInstances.grok && typeof existingInstances.grok === "object"
    ? existingInstances.grok
    : {};
const next = {
  ...current,
  linkedEnvironmentsEnabled: true,
  maxConcurrentSessions,
  enableProviderUpdateChecks: false,
  providerInstances: {
    ...existingInstances,
    grok: {
      ...existingGrok,
      driver: "grok",
      enabled: true,
      config: {
        ...(existingGrok.config && typeof existingGrok.config === "object"
          ? existingGrok.config
          : {}),
        binaryPath: grokBinaryPath,
      },
    },
    claudeAgent: {
      driver: "claudeAgent",
      enabled: false,
      config: {},
    },
    codex: {
      driver: "codex",
      enabled: false,
      config: {},
    },
  },
};
fs.writeFileSync(settingsPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o640 });
NODE

echo "[7/9] Installing systemd units (ade.slice + fleet-ade.service + cleanup timer + journald cap)..."
install -m 0644 "${APP_DIR}/scripts/deploy/ade.slice" /etc/systemd/system/ade.slice
install -m 0644 "${APP_DIR}/scripts/deploy/fleet-ade.service" /etc/systemd/system/fleet-ade.service
install -m 0644 "${APP_DIR}/scripts/deploy/fleet-ade-disk-cleanup.service" /etc/systemd/system/fleet-ade-disk-cleanup.service
install -m 0644 "${APP_DIR}/scripts/deploy/fleet-ade-disk-cleanup.timer" /etc/systemd/system/fleet-ade-disk-cleanup.timer
install -d -m 0755 /usr/local/lib/fleet-ade
install -m 0755 "${APP_DIR}/scripts/deploy/france-disk-cleanup.sh" /usr/local/lib/fleet-ade/france-disk-cleanup.sh
install -d -m 0755 /etc/systemd/journald.conf.d
cat >/etc/systemd/journald.conf.d/99-fleet-ade.conf <<'EOF'
[Journal]
SystemMaxUse=500M
EOF
systemctl daemon-reload
systemctl restart systemd-journald
systemctl enable --now fleet-ade-disk-cleanup.timer
systemctl enable ade.slice fleet-ade.service

echo "[8/9] Restricting firewall port ${ADE_PORT}/tcp strictly to WireGuard interface ${WG_IFACE}..."
ufw allow in on "${WG_IFACE}" from "${WG_SUBNET}" to "${WG_HOST}" port "${ADE_PORT}" proto tcp comment "fleet-ade WireGuard only"

echo "[9/9] Starting fleet-ade.service and verifying listener..."
systemctl restart ade.slice
systemctl restart fleet-ade.service

for _ in $(seq 1 30); do
  if curl -fsS --max-time 2 "http://${WG_HOST}:${ADE_PORT}/.well-known/t3/environment" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

systemctl --no-pager --full status fleet-ade.service | sed -n '1,18p'
LISTENERS="$(ss -H -ltn "sport = :${ADE_PORT}")"
echo "Listeners on :${ADE_PORT}:"
echo "${LISTENERS}"
if [[ "$(echo "${LISTENERS}" | wc -l)" -ne 1 ]] || ! echo "${LISTENERS}" | grep -Fq "${WG_HOST}:${ADE_PORT}"; then
  echo "ERROR: fleet-ade is not bound exclusively to ${WG_HOST}:${ADE_PORT}!" >&2
  exit 1
fi

echo "SUCCESS: fleet-ade commit ${COMMIT_SHA} is live on ${WG_HOST}:${ADE_PORT} (system node remains ${SYSTEM_NODE_AFTER})."

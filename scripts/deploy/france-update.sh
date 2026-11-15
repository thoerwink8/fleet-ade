#!/usr/bin/env bash
# France VPS headless ADE updater: fetch exact commit -> build in isolated cgroup -> restart service.
# Usage:
#   sudo bash scripts/deploy/france-update.sh <40-char-commit-sha>

set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "ERROR: run as root (for example: sudo bash $0 <commit-sha>)." >&2
  exit 1
fi

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <40-char-commit-sha>" >&2
  exit 1
fi

COMMIT_SHA="$1"
if [[ ! "${COMMIT_SHA}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "ERROR: expected a 40-character lowercase hex commit SHA, got: ${COMMIT_SHA}" >&2
  exit 1
fi

ADE_USER="ade"
ADE_HOME="/home/${ADE_USER}"
APP_DIR="/var/lib/fleet-ade/app"
NODE_LINK="${ADE_HOME}/.local/node"

if [[ ! -d "${APP_DIR}/.git" ]]; then
  echo "ERROR: ${APP_DIR} is not initialized. Run france-install.sh first." >&2
  exit 1
fi

# shellcheck disable=SC1091
if [[ -f /etc/fleet-ade/service.env ]]; then
  source /etc/fleet-ade/service.env
fi
if [[ -z "${FLEET_ADE_WG_HOST:-}" ]]; then
  echo "ERROR: FLEET_ADE_WG_HOST is required (set it in /etc/fleet-ade/service.env)." >&2
  exit 1
fi
WG_HOST="${FLEET_ADE_WG_HOST}"
ADE_PORT="${FLEET_ADE_PORT:-3773}"

PREV_SHA="$(sudo -u "${ADE_USER}" git -C "${APP_DIR}" rev-parse HEAD)"
echo "[1/4] Fetching commit ${COMMIT_SHA} (previous: ${PREV_SHA})..."
sudo -u "${ADE_USER}" bash -lc "
  set -euo pipefail
  git -C '${APP_DIR}' fetch --no-tags --depth 1 origin '${COMMIT_SHA}'
  git -C '${APP_DIR}' checkout --force --detach FETCH_HEAD
  ACTUAL_SHA=\"\$(git -C '${APP_DIR}' rev-parse HEAD)\"
  if [[ \"\${ACTUAL_SHA}\" != '${COMMIT_SHA}' ]]; then
    echo \"ERROR: checked out \${ACTUAL_SHA}, expected ${COMMIT_SHA}\" >&2
    exit 1
  fi
"

echo "[2/4] Ensuring pnpm@12.14.0 & building in transient ade-build.slice..."
PNPM_VERSION="12.14.0"
PNPM_PREFIX="${ADE_HOME}/.local/pnpm-${PNPM_VERSION}"
install -d -m 0750 -o "${ADE_USER}" -g "${ADE_USER}" \
  "${ADE_HOME}/.local" \
  "${ADE_HOME}/.local/bin" \
  "${ADE_HOME}/.cache" \
  "${PNPM_PREFIX}"
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
  -E CI=true \
  -E T3CODE_TELEMETRY_ENABLED=false \
  -E OTEL_SDK_DISABLED=true \
  -E T3CODE_OTEL_SDK_DISABLED=true \
  -E DO_NOT_TRACK=1 \
  /bin/bash -lc "pnpm install --frozen-lockfile && ./node_modules/.bin/vp run --filter t3 build"

echo "[3/4] Refreshing wrappers, GitHub App credential helper & systemd unit definitions and restarting fleet-ade.service..."

# Run the new commit's copy: it replays the credential helper, gh wrapper and git config.
bash "${APP_DIR}/scripts/deploy/france-github-app.sh"

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

if ! grep -Fq 'FLEET_ADE_PATH_SETUP' "${ADE_HOME}/.profile" 2>/dev/null; then
  cat >>"${ADE_HOME}/.profile" <<'EOF'

# FLEET_ADE_PATH_SETUP
export COREPACK_HOME="${COREPACK_HOME:-/home/ade/.cache/corepack}"
export PATH="/home/ade/.local/bin:/home/ade/.local/node/bin:/home/ade/.grok/bin:${PATH}"
EOF
  chown "${ADE_USER}:${ADE_USER}" "${ADE_HOME}/.profile"
fi
chown -R "${ADE_USER}:${ADE_USER}" "${ADE_HOME}/.cache" "${ADE_HOME}/.local/bin"

install -m 0644 "${APP_DIR}/scripts/deploy/ade.slice" /etc/systemd/system/ade.slice
install -m 0644 "${APP_DIR}/scripts/deploy/fleet-ade.service" /etc/systemd/system/fleet-ade.service
systemctl daemon-reload
systemctl restart fleet-ade.service

echo "[4/4] Verifying readiness on http://${WG_HOST}:${ADE_PORT}..."
READY=0
for _ in $(seq 1 30); do
  if curl -fsS --max-time 2 "http://${WG_HOST}:${ADE_PORT}/.well-known/t3/environment" >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 1
done

if [[ "${READY}" -ne 1 ]]; then
  echo "ERROR: fleet-ade failed readiness check after update to ${COMMIT_SHA}." >&2
  journalctl -u fleet-ade.service -n 40 --no-pager >&2 || true
  exit 1
fi

LISTENERS="$(ss -H -ltn "sport = :${ADE_PORT}")"
if [[ "$(echo "${LISTENERS}" | wc -l)" -ne 1 ]] || ! echo "${LISTENERS}" | grep -Fq "${WG_HOST}:${ADE_PORT}"; then
  echo "ERROR: unexpected listener state on :${ADE_PORT}: ${LISTENERS}" >&2
  exit 1
fi

echo "SUCCESS: fleet-ade updated ${PREV_SHA} -> ${COMMIT_SHA} and listening strictly on ${WG_HOST}:${ADE_PORT}."

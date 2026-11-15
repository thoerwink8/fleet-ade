#!/usr/bin/env bash
# France VPS: give the `ade` user its own GitHub App credentials so it can fetch and push
# thoerwink8/fleet-ade as the App bot (installation tokens, never a personal token).
# Idempotent: france-install.sh and france-update.sh both run it, so a re-install or an update
# replays exactly this setup.
#
# Usage (root):
#   bash scripts/deploy/france-github-app.sh [--source <app-json>]
#
# /etc/fleet-ade/github-app.json (root:ade 0640) is the credential. It is created once from
# --source (a GitHub App manifest JSON); only the fields the helper needs (id, client_id, slug,
# pem) are copied, never webhook or client secrets. If the file already exists, --source is
# ignored. No secret value is ever printed.

set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "ERROR: run as root." >&2
  exit 1
fi

SOURCE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --source)
      SOURCE="$2"
      shift 2
      ;;
    *)
      echo "ERROR: unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ADE_USER="ade"
ADE_HOME="/home/${ADE_USER}"
NODE="${ADE_HOME}/.local/node/bin/node"
APP_JSON="/etc/fleet-ade/github-app.json"
HELPER_SRC="${SCRIPT_DIR}/git-credential-fleet-ade-app.mjs"
HELPER_LIB_DIR="${ADE_HOME}/.local/share/fleet-ade"
HELPER_MJS="${HELPER_LIB_DIR}/git-credential-fleet-ade-app.mjs"
HELPER_BIN="${ADE_HOME}/.local/bin/git-credential-fleet-ade-app"
GH_WRAPPER="${ADE_HOME}/.local/bin/gh"
REPO_URL_PREFIX="https://github.com/thoerwink8/fleet-ade"

if [[ ! -x "${NODE}" ]]; then
  echo "ERROR: ${NODE} is missing; run france-install.sh first." >&2
  exit 1
fi
if [[ ! -f "${HELPER_SRC}" ]]; then
  echo "ERROR: ${HELPER_SRC} is missing." >&2
  exit 1
fi

install -d -m 0750 -o root -g "${ADE_USER}" /etc/fleet-ade

echo "[github-app 1/3] Credential file ${APP_JSON}..."
if [[ ! -f "${APP_JSON}" ]]; then
  if [[ -z "${SOURCE}" ]]; then
    echo "ERROR: ${APP_JSON} does not exist; pass --source <github-app-json> once to create it." >&2
    exit 1
  fi
  umask 0137
  "${NODE}" - "${SOURCE}" "${APP_JSON}" <<'NODE'
const fs = require("node:fs");
const [source, destination] = process.argv.slice(2);
const app = JSON.parse(fs.readFileSync(source, "utf8"));
for (const key of ["id", "slug", "pem"]) {
  if (!app[key]) throw new Error(`source JSON has no ${key}`);
}
const subset = { id: app.id, client_id: app.client_id, slug: app.slug, pem: app.pem };
fs.writeFileSync(destination, `${JSON.stringify(subset, null, 2)}\n`, { mode: 0o640 });
NODE
fi
chown root:"${ADE_USER}" "${APP_JSON}"
chmod 0640 "${APP_JSON}"
stat -c '%U:%G %a %n' "${APP_JSON}"

echo "[github-app 2/3] Installing credential helper and gh wrapper under ${ADE_HOME}/.local..."
install -d -m 0750 -o "${ADE_USER}" -g "${ADE_USER}" "${ADE_HOME}/.local/bin" "${ADE_HOME}/.local/share" "${HELPER_LIB_DIR}"
install -m 0644 -o "${ADE_USER}" -g "${ADE_USER}" "${HELPER_SRC}" "${HELPER_MJS}"

cat >"${HELPER_BIN}" <<EOF
#!/usr/bin/env bash
set -euo pipefail
exec ${NODE} ${HELPER_MJS} "\$@"
EOF
chown "${ADE_USER}:${ADE_USER}" "${HELPER_BIN}"
chmod 0755 "${HELPER_BIN}"

# `gh` has no credential-helper hook, so a wrapper earlier in PATH supplies the same App token
# through GH_TOKEN. The token is limited to the fleet-ade repository by the helper.
cat >"${GH_WRAPPER}" <<EOF
#!/usr/bin/env bash
set -euo pipefail
if [[ -z "\${GH_TOKEN:-}" ]]; then
  GH_TOKEN="\$(${HELPER_BIN} token)"
  export GH_TOKEN
fi
exec /usr/bin/gh "\$@"
EOF
chown "${ADE_USER}:${ADE_USER}" "${GH_WRAPPER}"
chmod 0755 "${GH_WRAPPER}"

echo "[github-app 3/3] Configuring git for ${ADE_USER} (credentials only for ${REPO_URL_PREFIX}, commits as the App bot)..."
read -r APP_ID APP_SLUG < <("${NODE}" -e 'const a=require(process.argv[1]);console.log(a.id,a.slug)' "${APP_JSON}")
GIT_CONFIG_FILE="${ADE_HOME}/.gitconfig"
git_ade() {
  sudo -u "${ADE_USER}" env HOME="${ADE_HOME}" git config --file "${GIT_CONFIG_FILE}" "$@"
}
for url in "${REPO_URL_PREFIX}" "${REPO_URL_PREFIX}.git"; do
  git_ade --unset-all "credential.${url}.helper" || true
  git_ade --add "credential.${url}.helper" ""
  git_ade --add "credential.${url}.helper" "${HELPER_BIN}"
  git_ade "credential.${url}.useHttpPath" true
done
git_ade user.name "${APP_SLUG}[bot]"
git_ade user.email "${APP_ID}+${APP_SLUG}[bot]@users.noreply.github.com"
chmod 0640 "${GIT_CONFIG_FILE}"

echo "OK: ${ADE_USER} pushes to ${REPO_URL_PREFIX} as ${APP_SLUG}[bot] with installation tokens."

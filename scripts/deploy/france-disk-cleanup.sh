#!/usr/bin/env bash
# Weekly cleanup for rebuildable France VPS artifacts that have no producer
# limit of their own. Run as root. Each step matches a measured pile
# (2026-11-18): release backups under /var/lib/fleet-ade/backup-* (3.3–4.5 GiB
# each; deploy itself keeps 2), closed pipeline worktrees, /tmp files older
# than 7 days (1.7 GiB of build leftovers), apt cache, ade and root pnpm
# stores (2.5 GiB and 0.7 GiB), root npm cache (3.1 GiB), and the
# fleet-agent-carpool pnpm store (5.9 GiB). Journal vacuum matches the 500M
# cap. It does not touch Postgres, ADE userdata, magpie data, or the
# fleet-dao engine archive (that archive has its own 20 GiB retention).
set -euo pipefail

ROOT=/var/lib/fleet-ade
ADE_HOME=/home/ade
CARPOOL_HOME=/home/fleet-agent-carpool
KEEP_RELEASE_BACKUPS=2
TMP_AGE_DAYS=7

require_root() {
  if [[ ${EUID} -ne 0 ]]; then
    echo 'ERROR: run as root.' >&2
    exit 1
  fi
}

prune_release_backups() {
  local root=$1 keep=${2:-2} path
  find "${root}" -mindepth 1 -maxdepth 1 -type d -name 'backup-*' -printf '%T@ %p\n' 2>/dev/null \
    | sort -rn | tail -n "+$((keep + 1))" | cut -d' ' -f2- \
    | while IFS= read -r path; do
      echo "Removing old release backup ${path}..."
      rm -rf -- "${path}"
    done
}

cleanup_pipeline_worktrees() {
  local repo_root="${ROOT}/repos/fleet-ade" worktree branch pr_json
  [[ -d "${repo_root}/.git" ]] || return 0
  git -C "${repo_root}" -c safe.directory="${repo_root}" worktree list --porcelain | awk '/^worktree / {print substr($0, 10)}' \
    | while IFS= read -r worktree; do
      [[ -n "${worktree}" && "${worktree}" != "${repo_root}" ]] || continue
      branch=$(git -C "${worktree}" -c safe.directory="${repo_root}" branch --show-current 2>/dev/null || true)
      pr_json=$(sudo -u ade env PATH="${ADE_HOME}/.local/bin:${ADE_HOME}/.local/node/bin:/usr/bin:/bin" \
        gh pr list --repo thoerwink8/fleet-ade --state all --head "${branch}" --json state --limit 1 2>/dev/null || true)
      if printf '%s' "${pr_json}" | grep -Eq '"state":"(MERGED|CLOSED)"'; then
        echo "Removing closed pipeline worktree ${worktree} (${branch})..."
        git -C "${repo_root}" -c safe.directory="${repo_root}" worktree remove --force "${worktree}"
      fi
    done
  git -C "${repo_root}" -c safe.directory="${repo_root}" worktree prune
}

cleanup_old_tmp() {
  find /tmp -xdev -mindepth 1 -maxdepth 1 -mtime +"${TMP_AGE_DAYS}" -exec rm -rf -- {} +
}

cleanup_caches() {
  prune_pnpm_store "${ADE_HOME}"
  prune_pnpm_store "${CARPOOL_HOME}"
  if [[ -x /usr/local/bin/pnpm ]]; then
    /usr/local/bin/pnpm store prune || true
  elif [[ -x /usr/bin/pnpm ]]; then
    pnpm store prune || true
  fi
  if [[ -x /usr/bin/npm ]]; then
    npm cache clean --force || true
  fi
  if [[ -x /usr/bin/apt-get ]]; then
    apt-get clean
  fi
}

prune_pnpm_store() {
  local home=$1 pnpm owner
  [[ -d "${home}" ]] || return 0
  pnpm="$(find_pnpm "${home}")"
  [[ -n "${pnpm}" ]] || return 0
  owner="$(stat -c %U "${home}")"
  sudo -u "${owner}" env HOME="${home}" XDG_CACHE_HOME="${home}/.cache" "${pnpm}" store prune || true
}

find_pnpm() {
  local home=$1 candidate
  for candidate in "${home}/.local/bin/pnpm" "${home}/.local/share/pnpm/pnpm" /usr/local/bin/pnpm; do
    if [[ -x "${candidate}" ]]; then
      printf '%s\n' "${candidate}"
      return 0
    fi
  done
  return 0
}

require_root
prune_release_backups "${ROOT}" "${KEEP_RELEASE_BACKUPS}"
cleanup_pipeline_worktrees
cleanup_old_tmp
cleanup_caches
journalctl --vacuum-size=500M

echo 'Disk cleanup complete.'

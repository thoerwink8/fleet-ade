#!/usr/bin/env bash
# Weekly cleanup for rebuildable France VPS artifacts. Run as root.
set -euo pipefail

ROOT=/var/lib/fleet-ade
ADE_HOME=/home/ade
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
      [[ -n "${worktree}" ]] || continue
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
  if [[ -x "${ADE_HOME}/.local/bin/pnpm" ]]; then
    sudo -u ade env HOME="${ADE_HOME}" XDG_CACHE_HOME="${ADE_HOME}/.cache" "${ADE_HOME}/.local/bin/pnpm" store prune
  fi
  if [[ -x /usr/bin/apt-get ]]; then
    apt-get clean
  fi
}

require_root
prune_release_backups "${ROOT}" "${KEEP_RELEASE_BACKUPS}"
cleanup_pipeline_worktrees
cleanup_old_tmp
cleanup_caches
journalctl --vacuum-size=500M

echo 'Disk cleanup complete.'

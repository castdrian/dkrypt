#!/usr/bin/env bash
set -euo pipefail

mode="${1:-}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  printf '%s\n' 'Usage:' '  scripts/host-migration.sh export <age-recipient> <bundle.age>' '  scripts/host-migration.sh restore <age-identity-file> <bundle.age> <empty-destination>'
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || { printf 'Required command is missing: %s\n' "$1" >&2; exit 1; }
}

if [[ "$mode" == "export" ]]; then
  recipient="${2:-}"
  bundle="${3:-}"
  [[ -n "$recipient" && -n "$bundle" ]] || { usage >&2; exit 2; }
  require_command age
  require_command docker
  require_command git
  require_command gzip
  [[ -f "$root/docker-compose.yml" && -f "$root/.env" ]] || { printf '%s\n' 'Run export from a dkrypt source checkout containing docker-compose.yml and .env.' >&2; exit 1; }
  [[ -z "$(git -C "$root" status --porcelain)" ]] || { printf '%s\n' 'Commit or move all working-tree changes before creating a migration snapshot.' >&2; exit 1; }
  for volume in dkrypt_state dkrypt_ipa-tmp dkrypt_device_ssh; do
    docker volume inspect "$volume" >/dev/null
  done
  printf '%s' 'This briefly stops dkrypt to snapshot SQLite and its persistent volumes. Continue? [y/N] '
  read -r answer
  [[ "$answer" == 'y' || "$answer" == 'Y' ]] || exit 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/dkrypt-migration.XXXXXX")"
  chmod 700 "$work"
  was_running=0
  if docker compose --project-name dkrypt -f "$root/docker-compose.yml" --env-file "$root/.env" ps --status running --services | awk '$1 == "api" { found = 1 } END { exit !found }'; then was_running=1; fi
  cleanup_export() {
    status=$?
    trap - EXIT
    if [[ "$was_running" == 1 ]] && ! docker compose --project-name dkrypt -f "$root/docker-compose.yml" --env-file "$root/.env" start api >/dev/null; then status=1; fi
    rm -rf "$work" || status=1
    exit "$status"
  }
  trap cleanup_export EXIT
  docker compose --project-name dkrypt -f "$root/docker-compose.yml" --env-file "$root/.env" stop api
  git -C "$root" archive --format=tar HEAD | gzip -n > "$work/source.tar.gz"
  install -m 600 "$root/.env" "$work/runtime.env"
  for pair in 'dkrypt_state:state.tar' 'dkrypt_ipa-tmp:artifacts.tar' 'dkrypt_device_ssh:device-ssh.tar'; do
    volume="${pair%%:*}"
    file="${pair#*:}"
    docker run --rm --user 0:0 -v "$volume:/data:ro" alpine:3.22 tar -C /data -cf - . > "$work/$file"
  done
  tar -C "$work" -czf "$work/migration.tar.gz" source.tar.gz runtime.env state.tar artifacts.tar device-ssh.tar
  mkdir -p "$(dirname "$bundle")"
  age --encrypt --recipient "$recipient" --output "$bundle" "$work/migration.tar.gz"
  chmod 600 "$bundle"
  printf 'Encrypted migration bundle created at %s\n' "$bundle"
  printf '%s\n' 'The source service has been restarted. Transfer the encrypted bundle and stop the source service before starting the restored host.'
elif [[ "$mode" == "restore" ]]; then
  identity="${2:-}"
  bundle="${3:-}"
  destination="${4:-}"
  [[ -n "$identity" && -n "$bundle" && -n "$destination" ]] || { usage >&2; exit 2; }
  require_command age
  require_command docker
  require_command tar
  [[ -f "$identity" && -f "$bundle" ]] || { printf '%s\n' 'The age identity and encrypted bundle must both exist.' >&2; exit 1; }
  mkdir -p "$destination"
  destination="$(cd "$destination" && pwd -P)"
  [[ "$destination" != / && "$destination" != "$HOME" && "$destination" != "$root" ]] || { printf '%s\n' 'Choose a dedicated empty directory outside the filesystem root, home directory, and source checkout.' >&2; exit 1; }
  [[ -z "$(find "$destination" -mindepth 1 -maxdepth 1 -print -quit)" ]] || { printf '%s\n' 'Choose an empty destination directory.' >&2; exit 1; }
  work="$(mktemp -d "${TMPDIR:-/tmp}/dkrypt-restore.XXXXXX")"
  chmod 700 "$work"
  restore_complete=0
  restore_started=0
  created_volumes=()
  cleanup_restore() {
    status=$?
    trap - EXIT
    if [[ "$restore_complete" != 1 ]]; then
      if [[ "$restore_started" == 1 ]]; then docker compose --project-name dkrypt -f "$destination/docker-compose.yml" --env-file "$destination/.env" down >/dev/null 2>&1 || true; fi
      for volume in "${created_volumes[@]}"; do docker volume rm "$volume" >/dev/null 2>&1 || true; done
      find "$destination" -mindepth 1 -maxdepth 1 -exec rm -rf {} + || true
    fi
    rm -rf "$work" || status=1
    exit "$status"
  }
  trap cleanup_restore EXIT
  age --decrypt --identity "$identity" --output "$work/migration.tar.gz" "$bundle"
  tar -xzf "$work/migration.tar.gz" -C "$work"
  for volume in dkrypt_state dkrypt_ipa-tmp dkrypt_device_ssh; do
    if docker volume inspect "$volume" >/dev/null 2>&1; then
      printf 'Refusing to merge into existing Docker volume %s. Rename or back up the volume before restoring.\n' "$volume" >&2
      exit 1
    fi
  done
  printf '%s' 'Confirm dkrypt is stopped on the original host and this host should take over? [y/N] '
  read -r answer
  [[ "$answer" == 'y' || "$answer" == 'Y' ]] || exit 1
  mkdir -p "$destination"
  tar -xzf "$work/source.tar.gz" -C "$destination"
  install -m 600 "$work/runtime.env" "$destination/.env"
  for pair in 'dkrypt_state:state.tar' 'dkrypt_ipa-tmp:artifacts.tar' 'dkrypt_device_ssh:device-ssh.tar'; do
    volume="${pair%%:*}"
    file="${pair#*:}"
    docker volume create "$volume" >/dev/null
    created_volumes+=("$volume")
    docker run --rm -i --user 0:0 -v "$volume:/data" alpine:3.22 tar -C /data -xf - < "$work/$file"
  done
  cd "$destination"
  restore_started=1
  docker compose --project-name dkrypt -f docker-compose.yml --env-file .env up -d --build
  if ! docker exec dkrypt bun -e "fetch('http://127.0.0.1:8080/v1/health',{headers:{authorization:'Bearer '+process.env.API_KEY}}).then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then
    docker compose --project-name dkrypt -f docker-compose.yml --env-file .env stop api
    printf '%s\n' 'Restored service did not pass the authenticated health check. It has been stopped; the source host remains available for recovery.' >&2
    exit 1
  fi
  restore_complete=1
  printf 'dkrypt restored and passed its health check at %s\n' "$destination"
else
  usage >&2
  exit 2
fi

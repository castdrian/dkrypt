#!/bin/sh
set -eu

usage() {
  printf '%s\n' 'Usage: scripts/dkrypt-update.sh <image@sha256:digest> [--yes]' >&2
  exit 2
}

target_image=${1:-}
[ -n "$target_image" ] || usage
if [ "${2:-}" != "" ] && [ "${2:-}" != '--yes' ]; then usage; fi
skip_confirmation=${2:-}

case "$target_image" in
  *@sha256:*)
    image_repository=${target_image%@sha256:*}
    image_digest=${target_image##*@sha256:}
    ;;
  *)
    printf '%s\n' 'Use an immutable image reference ending in @sha256:<64 lowercase hex characters>.' >&2
    exit 2
    ;;
esac

case "$image_repository" in
  ''|*[!A-Za-z0-9._/:@-]*)
    printf '%s\n' 'The image repository contains unsupported characters.' >&2
    exit 2
    ;;
esac
if [ "${#image_digest}" -ne 64 ]; then
  printf '%s\n' 'The image digest must contain 64 lowercase hexadecimal characters.' >&2
  exit 2
fi
case "$image_digest" in
  *[!0123456789abcdef]*)
    printf '%s\n' 'The image digest must contain 64 lowercase hexadecimal characters.' >&2
    exit 2
    ;;
esac

script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repository_directory=$(CDPATH= cd -- "$script_directory/.." && pwd)
cd "$repository_directory"

if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  printf '%s\n' 'Docker Compose v2 is required.' >&2
  exit 1
fi
docker compose config --quiet

container_id=$(docker compose ps --quiet api)
if [ -z "$container_id" ]; then
  printf '%s\n' 'The dkrypt API container must be running before an update.' >&2
  exit 1
fi
old_image_id=$(docker inspect --format '{{.Image}}' "$container_id")
rollback_image="dkrypt-rollback:$(date +%Y%m%d%H%M%S)-$$"
docker image tag "$old_image_id" "$rollback_image"

if [ "$skip_confirmation" != '--yes' ]; then
  if [ ! -r /dev/tty ]; then
    printf '%s\n' 'An interactive terminal or --yes is required.' >&2
    exit 1
  fi
  printf 'Update dkrypt to %s and restart the service? [y/N] ' "$target_image" > /dev/tty
  IFS= read -r answer < /dev/tty
  case "$answer" in y|Y|yes|YES) ;; *) printf '%s\n' 'Update cancelled.'; exit 0 ;; esac
fi

backup_name="update-rollback-$(date +%Y%m%d%H%M%S)-$$.sqlite"
backup_script='import { chmodSync, chownSync, mkdirSync, statSync } from "node:fs"; import path from "node:path"; import { Database } from "bun:sqlite"; const stateDir = path.resolve(process.env.STATE_DIR || "/data/state"); const databaseName = process.env.STATE_DATABASE_FILE || "dkrypt.sqlite"; const databasePath = path.resolve(stateDir, databaseName); if (databasePath !== stateDir && !databasePath.startsWith(stateDir + path.sep)) throw new Error("Database file must stay inside STATE_DIR"); const backupDirectory = path.join(stateDir, "backups"); mkdirSync(backupDirectory, { recursive: true, mode: 0o700 }); chownSync(backupDirectory, 10001, 10001); chmodSync(backupDirectory, 0o700); const backupPath = path.join(backupDirectory, Bun.argv[1]); const database = new Database(databasePath, { create: false, strict: true }); try { database.exec("PRAGMA busy_timeout = 10000;"); database.query("PRAGMA wal_checkpoint(FULL)").get(); database.query("VACUUM INTO ?").run(backupPath); } finally { database.close(); } const backup = new Database(backupPath, { create: false, readonly: true, strict: true }); try { const check = backup.query("PRAGMA integrity_check").get(); if (check?.integrity_check !== "ok") throw new Error("Rollback copy failed SQLite integrity check"); } finally { backup.close(); } chownSync(backupPath, 10001, 10001); chmodSync(backupPath, 0o600); process.stdout.write(backupPath);'
backup_path=$(docker exec "$container_id" bun -e "$backup_script" "$backup_name")
if [ -z "$backup_path" ]; then
  printf '%s\n' 'Could not create a verified SQLite rollback copy; update cancelled.' >&2
  exit 1
fi

compose_target() {
  DKRYPT_IMAGE="$target_image" docker compose "$@"
}

wait_for_healthy() {
  tries=0
  while [ "$tries" -lt 45 ]; do
    current_container=$(compose_target ps --quiet api)
    if [ -n "$current_container" ]; then
      current_health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$current_container")
      if [ "$current_health" = 'healthy' ]; then return 0; fi
      if [ "$current_health" = 'unhealthy' ] || [ "$current_health" = 'none' ]; then return 1; fi
    fi
    tries=$((tries + 1))
    sleep 2
  done
  return 1
}

rollback() {
  printf '%s\n' 'The new image did not become healthy; restoring the previous image and SQLite state.' >&2
  compose_target stop api >/dev/null 2>&1 || true
  if ! DKRYPT_IMAGE="$rollback_image" docker compose run --rm --no-deps --entrypoint bun api -e 'import { chmodSync, chownSync, copyFileSync, existsSync, renameSync, rmSync } from "node:fs"; import path from "node:path"; import { Database } from "bun:sqlite"; const stateDir = path.resolve(process.env.STATE_DIR || "/data/state"); const backupPath = path.resolve(Bun.argv[1]); const backupRoot = path.join(stateDir, "backups") + path.sep; if (!backupPath.startsWith(backupRoot) || !existsSync(backupPath)) throw new Error("Verified rollback copy is unavailable"); const databaseName = process.env.STATE_DATABASE_FILE || "dkrypt.sqlite"; const databasePath = path.resolve(stateDir, databaseName); if (databasePath !== stateDir && !databasePath.startsWith(stateDir + path.sep)) throw new Error("Database file must stay inside STATE_DIR"); const backup = new Database(backupPath, { create: false, readonly: true, strict: true }); try { const check = backup.query("PRAGMA integrity_check").get(); if (check?.integrity_check !== "ok") throw new Error("Rollback copy failed SQLite integrity check"); } finally { backup.close(); } const temporaryPath = databasePath + ".rollback"; copyFileSync(backupPath, temporaryPath); chownSync(temporaryPath, 10001, 10001); chmodSync(temporaryPath, 0o660); rmSync(databasePath + "-wal", { force: true }); rmSync(databasePath + "-shm", { force: true }); renameSync(temporaryPath, databasePath); process.stdout.write("SQLite state restored");' "$backup_path"; then
    printf 'Automatic SQLite restore failed. Verified copy remains at %s\n' "$backup_path" >&2
    return 1
  fi
  if ! DKRYPT_IMAGE="$rollback_image" docker compose up --detach --no-build --pull never --no-deps api; then
    printf 'Previous image could not be restarted. Verified copy remains at %s\n' "$backup_path" >&2
    return 1
  fi
  if ! wait_for_healthy; then
    printf 'Previous image did not become healthy. Verified copy remains at %s\n' "$backup_path" >&2
    return 1
  fi
  printf 'Rollback succeeded. Previous image and SQLite state are healthy; verified copy retained at %s\n' "$backup_path" >&2
  return 0
}

if ! compose_target pull api; then
  printf '%s\n' 'The selected image could not be pulled; the running service was left unchanged.' >&2
  exit 1
fi

if ! compose_target up --detach --no-build --no-deps api; then
  rollback || true
  exit 1
fi

if ! wait_for_healthy; then
  rollback || true
  exit 1
fi

printf 'dkrypt is healthy on %s. Verified pre-update SQLite copy retained at %s\n' "$target_image" "$backup_path"

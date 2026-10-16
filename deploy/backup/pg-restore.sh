#!/usr/bin/env bash
# Restore a CodeJudge database dump made by pg-backup.sh.
#
#   pg-restore.sh <s3://bucket/prefix/codejudge-….dump | file:///dir/codejudge-….dump | latest> [--into-live]
#
# Default: restores into a NEW database codejudge_restore_<timestamp> and
# prints row counts next to the live database's, so a backup can be checked
# without touching production. --into-live replaces the live database: stop
# the API and the worker first (docker compose stop api; systemctl stop
# judge-worker); you are asked to type the database name to confirm.
#
#   BACKUP_DEST, CODEJUDGE_COMPOSE as in pg-backup.sh ("latest" needs BACKUP_DEST).
set -euo pipefail

src=${1:?usage: pg-restore.sh <dump URL | latest> [--into-live]}
mode=${2:-}
COMPOSE=${CODEJUDGE_COMPOSE:-"docker compose -f /opt/codejudge/current/app/deploy/compose.prod.yaml --env-file /etc/codejudge/prod.env"}
read -r -a compose <<<"$COMPOSE"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
log() { printf '%s pg-restore: %s\n' "$(date -u +%FT%TZ)" "$*" >&2; }
psql_c() { "${compose[@]}" exec -T postgres sh -c "PGPASSWORD=\"\$POSTGRES_PASSWORD\" psql -h 127.0.0.1 -U \"\$POSTGRES_USER\" -v ON_ERROR_STOP=1 -At $*" </dev/null; }

if [ "$src" = latest ]; then
  : "${BACKUP_DEST:?set BACKUP_DEST to resolve latest}"
  case "$BACKUP_DEST" in
    s3://*) src="${BACKUP_DEST%/}/$(aws s3 ls "${BACKUP_DEST%/}/" | awk '/codejudge-.*\.dump$/ {print $4}' | sort | tail -1)" ;;
    file://*) src="file://$(ls -1 "${BACKUP_DEST#file://}"/codejudge-*.dump | sort | tail -1)" ;;
  esac
fi
name=$(basename "$src")
log "fetching $src"
case "$src" in
  s3://*)
    aws s3 cp "$src" "$tmp/$name" --only-show-errors
    want=$(aws s3api head-object --bucket "$(echo "${src#s3://}" | cut -d/ -f1)" --key "$(echo "${src#s3://}" | cut -d/ -f2-)" --query 'Metadata.sha256' --output text)
    ;;
  file://*)
    cp "${src#file://}" "$tmp/$name"
    want=$(cut -d' ' -f1 "${src#file://}.sha256")
    ;;
  *) log "unsupported source $src"; exit 2 ;;
esac
got=$(sha256sum "$tmp/$name" | cut -d' ' -f1)
if [ "$got" != "$want" ]; then
  log "sha256 mismatch: got $got, recorded $want"
  exit 1
fi
log "sha256 ok ($got)"

# Commands that need no input read /dev/null: "exec -T" would otherwise
# swallow stdin (and with it the confirmation below).
live=$("${compose[@]}" exec -T postgres sh -c 'echo "$POSTGRES_DB"' </dev/null | tr -d '\r')
if [ "$mode" = --into-live ]; then
  target=$live
  printf 'This DROPS and replaces database "%s". Type its name to continue: ' "$target" >&2
  read -r answer
  [ "$answer" = "$target" ] || { log "aborted"; exit 1; }
  psql_c "-d postgres -c 'DROP DATABASE IF EXISTS \"$target\" WITH (FORCE)'" >/dev/null
else
  target="codejudge_restore_$(date -u +%Y%m%d%H%M%S)"
fi
psql_c "-d postgres -c 'CREATE DATABASE \"$target\"'" >/dev/null
log "restoring into $target"
"${compose[@]}" exec -T postgres sh -c \
  "PGPASSWORD=\"\$POSTGRES_PASSWORD\" pg_restore -h 127.0.0.1 -U \"\$POSTGRES_USER\" -d \"$target\" --no-owner --no-privileges --exit-on-error" \
  <"$tmp/$name"

counts() {
  psql_c "-d \"$1\" -c \"SELECT 'schema_migrations', count(*) FROM schema_migrations UNION ALL SELECT 'problems', count(*) FROM problems UNION ALL SELECT 'problem_samples', count(*) FROM problem_samples UNION ALL SELECT 'users', count(*) FROM users UNION ALL SELECT 'sessions', count(*) FROM sessions UNION ALL SELECT 'submissions', count(*) FROM submissions UNION ALL SELECT 'submission_tests', count(*) FROM submission_tests\""
}
log "row counts (restored | live):"
paste -d'|' <(counts "$target") <(counts "$live" | cut -d'|' -f2) | tr -d '\r' | column -t -s'|' >&2 || true
echo "$target"

#!/usr/bin/env bash
# Nightly logical backup of the CodeJudge database to S3 (run by
# deploy/systemd/pg-backup.timer).
#
#   BACKUP_DEST=s3://<bucket>/<prefix>   where dumps go (required); file:///dir for local tests
#   CODEJUDGE_COMPOSE="docker compose -f /opt/codejudge/current/app/deploy/compose.prod.yaml --env-file /etc/codejudge/prod.env"
#                                        how to reach the postgres service (default: production)
#   AWS_REGION                           for s3:// (credentials: the EC2 instance role; no keys on disk)
#
# pg_dump runs inside the postgres container (same major version as the
# server, no client on the host), custom format (compressed, selective
# restore). The dump is checked with pg_restore --list before upload and its
# SHA-256 is stored as object metadata and checked again on restore.
#
# After an S3 upload it publishes CodeJudge/BackupSucceeded = 1, the metric the
# BackupMissing alarm (infra/) watches; if that fails the unit fails too.
set -euo pipefail

: "${BACKUP_DEST:?set BACKUP_DEST (s3://bucket/prefix or file:///dir)}"
COMPOSE=${CODEJUDGE_COMPOSE:-"docker compose -f /opt/codejudge/current/app/deploy/compose.prod.yaml --env-file /etc/codejudge/prod.env"}
read -r -a compose <<<"$COMPOSE"

stamp=$(date -u +%Y%m%dT%H%M%SZ)
name="codejudge-${stamp}.dump"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
log() { printf '%s pg-backup: %s\n' "$(date -u +%FT%TZ)" "$*" >&2; }

log "dumping to $name"
"${compose[@]}" exec -T postgres sh -c \
  'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --compress=6 --no-owner --no-privileges' \
  </dev/null >"$tmp/$name"

# A truncated or corrupt archive fails here, before anything is uploaded.
entries=$("${compose[@]}" exec -T postgres pg_restore --list <"$tmp/$name" | grep -c ' TABLE DATA ' || true)
size=$(stat -c %s "$tmp/$name" 2>/dev/null || wc -c <"$tmp/$name")
sha=$(sha256sum "$tmp/$name" | cut -d' ' -f1)
if [ "$entries" -lt 1 ]; then
  log "dump has no table data entries; refusing to upload"
  exit 1
fi
log "dump ok: $size bytes, $entries tables with data, sha256 $sha"

case "$BACKUP_DEST" in
  s3://*)
    aws s3 cp "$tmp/$name" "${BACKUP_DEST%/}/$name" \
      --sse AES256 --metadata "sha256=$sha" --only-show-errors
    if ! aws cloudwatch put-metric-data --namespace CodeJudge --metric-name BackupSucceeded --unit Count --value 1; then
      log "uploaded ${BACKUP_DEST%/}/$name, but publishing CodeJudge/BackupSucceeded failed"
      exit 3
    fi
    log "metric published: CodeJudge/BackupSucceeded=1"
    ;;
  file://*)
    dir=${BACKUP_DEST#file://}
    mkdir -p "$dir"
    cp "$tmp/$name" "$dir/$name"
    printf '%s  %s\n' "$sha" "$name" >"$dir/$name.sha256"
    ;;
  *)
    log "unsupported BACKUP_DEST $BACKUP_DEST"
    exit 2
    ;;
esac
log "uploaded ${BACKUP_DEST%/}/$name"
echo "${BACKUP_DEST%/}/$name"

#!/usr/bin/env bash
# Takes CodeJudge down so nothing bills while idle (MAINTENANCE.md, "Up and down"):
#   1. a fresh database backup and a real restore drill from it, plus a backup
#      of Caddy's certificates; any failure aborts before anything is removed;
#   2. the final backups go to s3://<bucket>/codejudge/final/ (never expires);
#   3. the backup alarm's actions are disabled, DNS is parked at 192.0.2.1;
#   4. the host stack (EC2, EBS, Elastic IP, ECR) is destroyed;
#   5. an audit of everything that can still bill (exit 1: "STILL BILLING").
# Safe to run again after a half-failed run.
#
#   ./codejudge-down.sh
set -euo pipefail
# shellcheck source=scripts/codejudge-lib.sh
. "$(dirname "$0")/scripts/codejudge-lib.sh"

preflight
cf_check

# The host: tagged (CodeJudgeHost), or the pre-split one still in CodeJudgeProd.
ID=$(host_id)
if [ -z "$ID" ] && stack_exists "$PERSISTENT"; then
  ID=$(stack_output "$PERSISTENT" InstanceId)
  [ "$ID" = None ] && ID=""
fi

if [ -n "$ID" ]; then
  log "1/5 Backup, restore drill and Caddy data on the host"
  # The drill runs this checkout's pg-restore.sh, whatever release the host has.
  drill=$(tr -d '\r' <"$ROOT/deploy/backup/pg-restore.sh")
  out=$(ssm_run "$ID" '
set -euo pipefail
set -a; . /etc/codejudge/backup.env; set +a
cat >/root/pg-restore-drill.sh <<'"'CODEJUDGE_DRILL'"'
'"$drill"'
CODEJUDGE_DRILL
start=$(date +%s)
systemctl start pg-backup.service
dump=$(journalctl -u pg-backup.service --since "@$start" -o cat --no-pager | sed -n "s/^.*pg-backup: uploaded \(s3:\/\/.*\.dump\)$/\1/p" | tail -n 1)
[ -n "$dump" ] || { echo "pg-backup.service ran but uploaded nothing"; exit 1; }
echo "RESULT dump=$dump"
# The drill: restore that very dump into a new database, compare every table.
bash /root/pg-restore-drill.sh "$dump" --check
vol=$(docker volume ls -q --filter label=com.docker.compose.volume=caddy_data --filter label=com.docker.compose.project='"$COMPOSE_PROJECT"' | head -n 1)
[ -n "$vol" ] || { echo "no caddy_data volume"; exit 1; }
dir=$(docker volume inspect -f "{{.Mountpoint}}" "$vol")
certs=$(find "$dir" -path "*/certificates/*" -name "*.crt" | wc -l)
accounts=$(find "$dir" -path "*/acme/*/users/*" -name "*.key" | wc -l)
[ "$certs" -ge 1 ] && [ "$accounts" -ge 1 ] || { echo "caddy_data has $certs certificates and $accounts ACME account keys"; exit 1; }
tgz=$(mktemp /root/caddy-data.XXXXXX.tgz)
tar -C "$dir" -czf "$tgz" .
sha=$(sha256sum "$tgz" | cut -d" " -f1)
name="caddy-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
aws s3 cp "$tgz" "${BACKUP_DEST%/}/$name" --sse AES256 --metadata "sha256=$sha" --only-show-errors
rm -f "$tgz"
echo "RESULT caddy=${BACKUP_DEST%/}/$name"
echo "RESULT caddy_sha=$sha"
echo "RESULT caddy_certs=$certs"
') || die "backup or restore drill failed on the host: nothing was removed"
  printf '%s\n' "$out" | grep -E 'pg-backup|pg-restore|drill|RESULT' >&2 || true
  dump=$(result dump "$out")
  caddy=$(result caddy "$out")
  counts=$(sed -n 's/^drill-counts: //p' <<<"$out" | tail -n 1 | tr -d '\r')
  [ -n "$dump" ] && [ -n "$caddy" ] && [ -n "$counts" ] || die "the host did not report the backups: nothing was removed"

  log "2/5 Verify the backups in S3 and keep them in $FINAL_PREFIX"
  for url in "$dump" "$caddy"; do
    key=${url#s3://"$BUCKET"/}
    want=$(aws_ s3api head-object --bucket "$BUCKET" --key "$key" --query 'Metadata.sha256' --output text)
    [ "${#want}" = 64 ] || die "$key has no recorded sha256: nothing was removed"
    aws_ s3 cp "s3://$BUCKET/$key" "s3://$BUCKET/$FINAL_PREFIX$(basename "$key")" --only-show-errors
    got=$(aws_ s3api head-object --bucket "$BUCKET" --key "$FINAL_PREFIX$(basename "$key")" --query 'Metadata.sha256' --output text)
    [ "$got" = "$want" ] || die "copy of $key lost its checksum"
    echo "kept $FINAL_PREFIX$(basename "$key") (sha256 ${want:0:12}...)" >&2
  done
  [ "$(result caddy_sha "$out")" = "$(aws_ s3api head-object --bucket "$BUCKET" --key "$FINAL_PREFIX$(basename "$caddy")" --query 'Metadata.sha256' --output text)" ] ||
    die "Caddy backup checksum differs from what the host computed"
  printf '%s\n' "$counts" >"$WORK/counts"
  aws_ s3 cp "$(winpath "$WORK/counts")" "s3://$BUCKET/$FINAL_PREFIX$(basename "$dump").counts" --only-show-errors
  echo "row counts at backup time: $counts" >&2
  # Keep the newest few of each kind.
  for pat in '\.dump$' '\.dump\.counts$' '^.*caddy-.*\.tar\.gz$'; do
    aws_ s3api list-objects-v2 --bucket "$BUCKET" --prefix "$FINAL_PREFIX" --query 'Contents[].Key' --output text | tr '\t' '\n' | tr -d '\r' |
      grep -E "$pat" | sort | head -n "-$KEEP_FINAL" | while read -r old; do
      [ -n "$old" ] && aws_ s3 rm "s3://$BUCKET/$old" --only-show-errors && echo "pruned $old" >&2
    done
  done
else
  log "1-2/5 No host running: nothing to back up (the newest backup stays in $FINAL_PREFIX)"
  newest "$FINAL_PREFIX" '\.dump$' >&2 || true
fi

log "3/5 Alarms off (the budget stays), DNS parked at $PARKED_IP"
alarm=$(backup_alarm)
if [ -n "$alarm" ] && [ "$alarm" != None ]; then
  aws_ cloudwatch disable-alarm-actions --alarm-names "$alarm"
  echo "actions disabled: $alarm" >&2
fi
cf_set_a "$PARKED_IP"

log "4/5 Remove the host (EC2, EBS, Elastic IP, registries)"
if stack_exists "$HOST_STACK"; then
  cdk_ destroy "$HOST_STACK" --force
fi
# Keeps the persistent stack current; on the first run after the split this
# also removes the host that still lived in it.
cdk_ deploy "$PERSISTENT" --exclusively
# Registries left behind by a half-failed run.
for r in $(aws_ ecr describe-repositories --query 'repositories[].repositoryName' --output text | tr '\t' '\n' | tr -d '\r' | grep '^codejudge/' || true); do
  aws_ ecr delete-repository --repository-name "$r" --force >/dev/null && echo "deleted leftover registry $r" >&2
done

log "5/5 Audit"
if audit; then
  printf '\n\033[1mCodeJudge is DOWN.\033[0m Data: %s (%s). Bring it back: ./codejudge-up.sh\n' \
    "$(newest "$FINAL_PREFIX" '\.dump$')" "$(date -u +%FT%TZ)" >&2
  echo "took $(($(date +%s) - T0)) s" >&2
else
  exit 1
fi

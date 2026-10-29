#!/usr/bin/env bash
# Brings CodeJudge up from fully down (MAINTENANCE.md, "Up and down"):
#   1. the host stack (EC2 + EBS + Elastic IP + ECR);
#   2. Caddy's certificates restored BEFORE Caddy first starts (no new
#      Let's Encrypt certificate: the duplicate limit is 5 a week);
#   3. the current release built in the cloud (GitHub Actions "Deploy") and
#      deployed by digest; the newest database backup restored into it;
#   4. only then DNS pointed at the host (until the database is restored and
#      migrated, the name stays parked at 192.0.2.1: no traffic reaches an
#      empty app); a fresh backup, the backup alarm re-enabled;
#   5. checks: health on the IP and on the domain (valid certificate), GitHub
#      OAuth, the hidden-tests deploy key, S3, ECR, a real AC submission, and
#      the users/submissions from the backup all present.
# Safe to run again after a half-failed run.
#
#   ./codejudge-up.sh
set -euo pipefail
# shellcheck source=scripts/codejudge-lib.sh
. "$(dirname "$0")/scripts/codejudge-lib.sh"

preflight
cf_check
[ "$(git -C "$ROOT" rev-parse HEAD)" = "$(git -C "$ROOT" ls-remote origin refs/heads/main | cut -f1)" ] ||
  echo "note: local HEAD differs from origin/main; the site gets origin/main (built by the Deploy workflow)" >&2

# The backup to restore: the newest dump, nightly or final.
DUMP_KEY=$( (newest "$FINAL_PREFIX" '/codejudge-.*\.dump$'; newest "$NIGHTLY_PREFIX" '/codejudge-.*\.dump$') | grep . | sort -t/ -k3 | tail -n 1)
CADDY_KEY=$( (newest "$FINAL_PREFIX" '/caddy-.*\.tar\.gz$'; newest "$NIGHTLY_PREFIX" '/caddy-.*\.tar\.gz$') | grep . | sort -t/ -k3 | tail -n 1)
[ -n "$DUMP_KEY" ] || die "no database backup in s3://$BUCKET: refusing to start an empty site (restore by hand)"
echo "restoring database $DUMP_KEY, Caddy data ${CADDY_KEY:-<none: Caddy will request a new certificate>}" >&2
COUNTS=$(aws s3 cp "s3://$BUCKET/$FINAL_PREFIX$(basename "$DUMP_KEY").counts" - 2>/dev/null | tr -d '\r' || true)

log "1/6 Host stack (EC2, EBS, Elastic IP, registries)"
cdk_ deploy "$PERSISTENT" "$HOST_STACK"
ID=$(stack_output "$HOST_STACK" InstanceId)
IP=$(stack_output "$HOST_STACK" PublicIp)
echo "host ${ID:0:5}..., IP $IP" >&2
# Without a Caddy backup a new certificate is needed, and Let's Encrypt must
# reach the host by name: only then does DNS move before the restore.
[ -n "$CADDY_KEY" ] || cf_set_a "$IP"

log "2/6 Wait for the host to finish bootstrapping"
for _ in $(seq 120); do
  [ "$(aws ssm describe-instance-information --filters "Key=InstanceIds,Values=$ID" --query 'InstanceInformationList[0].PingStatus' --output text 2>/dev/null)" = Online ] && break
  sleep 5
done
ssm_run "$ID" 'cloud-init status --wait >/dev/null || true; cloud-init status --long | grep -E "^(status|errors)"; cloud-init status | grep -q "status: done"' 1800 ||
  die "the host bootstrap did not finish (see /var/log/cloud-init-output.log via an SSM session)"

log "3/6 Restore Caddy's certificates (before Caddy starts)"
for key in "$DUMP_KEY" "$CADDY_KEY"; do # the host may read only the nightly prefix
  [ -n "$key" ] && [ "${key#"$NIGHTLY_PREFIX"}" != "$key" ] && continue
  [ -n "$key" ] && aws_ s3 cp "s3://$BUCKET/$key" "s3://$BUCKET/$NIGHTLY_PREFIX$(basename "$key")" --only-show-errors
done
if [ -n "$CADDY_KEY" ]; then
  sha=$(aws_ s3api head-object --bucket "$BUCKET" --key "$NIGHTLY_PREFIX$(basename "$CADDY_KEY")" --query 'Metadata.sha256' --output text)
  ssm_run "$ID" '
set -euo pipefail
vol='"$COMPOSE_PROJECT"'_caddy_data
if docker volume inspect "$vol" >/dev/null 2>&1 && [ -n "$(ls -A "$(docker volume inspect -f "{{.Mountpoint}}" "$vol")")" ]; then
  echo "caddy_data already restored"; exit 0
fi
docker volume inspect "$vol" >/dev/null 2>&1 ||
  docker volume create --label com.docker.compose.project='"$COMPOSE_PROJECT"' --label com.docker.compose.volume=caddy_data "$vol" >/dev/null
tgz=$(mktemp /root/caddy-data.XXXXXX.tgz)
aws s3 cp "s3://'"$BUCKET/$NIGHTLY_PREFIX$(basename "$CADDY_KEY")"'" "$tgz" --region '"$AWS_REGION"' --only-show-errors
[ "$(sha256sum "$tgz" | cut -d" " -f1)" = '"$sha"' ] || { echo "Caddy backup checksum mismatch"; exit 1; }
tar -C "$(docker volume inspect -f "{{.Mountpoint}}" "$vol")" -xzf "$tgz"
rm -f "$tgz"
echo "caddy_data restored: $(find "$(docker volume inspect -f "{{.Mountpoint}}" "$vol")" -path "*/certificates/*" -name "*.crt" | wc -l) certificate(s)"
' || die "Caddy data restore failed"
fi

log "4/6 Build and deploy the current release (GitHub Actions: Deploy)"
current=$(ssm_run "$ID" 'jq -r .release /opt/codejudge/state/current.json 2>/dev/null || true' 2>/dev/null || true)
main_sha=$(git -C "$ROOT" ls-remote origin refs/heads/main | cut -f1)
if [ "$current" = "$main_sha" ]; then
  echo "release ${main_sha:0:12} already live" >&2
else
  since=$(date -u +%FT%TZ)
  gh workflow run Deploy --ref main -R "$REPO" >/dev/null
  run=""
  for _ in $(seq 60); do
    run=$(gh run list -R "$REPO" -w Deploy -e workflow_dispatch -L 5 --json databaseId,createdAt --jq "[.[] | select(.createdAt >= \"$since\")][0].databaseId // empty")
    [ -n "$run" ] && break
    sleep 5
  done
  [ -n "$run" ] || die "the Deploy run did not start"
  echo "Deploy run https://github.com/$REPO/actions/runs/$run" >&2
  gh run watch "$run" -R "$REPO" --exit-status --interval 20 >/dev/null || die "Deploy failed: https://github.com/$REPO/actions/runs/$run"
fi

log "5/6 Restore the database (then migrate), only then DNS; fresh backup; alarm back on"
out=$(ssm_run "$ID" '
set -euo pipefail
url="s3://'"$BUCKET/$NIGHTLY_PREFIX$(basename "$DUMP_KEY")"'"
marker=/opt/codejudge/state/restored-from
compose=(docker compose -f /opt/codejudge/current/app/deploy/compose.prod.yaml --env-file /etc/codejudge/prod.env)
if [ "$(cat "$marker" 2>/dev/null)" = "$url" ]; then
  echo "already restored from $url"
else
  systemctl stop judge-worker
  "${compose[@]}" stop api
  set -a; . /etc/codejudge/backup.env; set +a
  echo codejudge | /opt/codejudge/current/app/deploy/backup/pg-restore.sh "$url" --into-live
  "${compose[@]}" run --rm migrate up
  set -a; . /etc/codejudge/worker.env; set +a
  /opt/codejudge/current/bin/judge-admin import /opt/codejudge/current/app/problems >/dev/null
  "${compose[@]}" up -d --no-build --wait --wait-timeout 300 api
  systemctl start judge-worker
  echo "$url" >"$marker"
fi
q() { "${compose[@]}" exec -T postgres sh -c "PGPASSWORD=\"\$POSTGRES_PASSWORD\" psql -h 127.0.0.1 -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -XAt -c \"select count(*) from $1\"" </dev/null | tr -d "\r"; }
echo "RESULT counts=users=$(q users) submissions=$(q submissions) submission_tests=$(q submission_tests) problems=$(q problems)"
start=$(date +%s)
systemctl start pg-backup.service
journalctl -u pg-backup.service --since "@$start" -o cat --no-pager | grep -E "uploaded|metric published"
') || die "database restore failed"
printf '%s\n' "$out" | grep -E 'pg-restore|already|uploaded|metric' >&2 || true
LIVE=$(result counts "$out")
echo "restored: $LIVE" >&2
echo "at final backup: ${COUNTS:-<none: the newest dump is a nightly one, no counts were recorded>}" >&2
for t in users submissions submission_tests; do
  want=$(grep -oE "(^| )$t=[0-9]+" <<<"$COUNTS" | cut -d= -f2 || true)
  got=$(grep -oE "(^| )$t=[0-9]+" <<<"$LIVE" | cut -d= -f2)
  [ -z "$want" ] || [ "$got" = "$want" ] || die "$t: $got rows after restore, the final backup recorded $want (DNS still parked)"
done
cf_set_a "$IP"
alarm=$(backup_alarm)
aws_ cloudwatch enable-alarm-actions --alarm-names "$alarm"
echo "actions enabled: $alarm" >&2

log "6/6 Checks"
fail=0
check() { if "$@"; then printf '  ok    %s\n' "$CHECK" >&2; else printf '  \033[31mFAIL\033[0m  %s\n' "$CHECK" >&2; fail=1; fi; }
CHECK="health on the IP $IP with the domain's certificate"
check retry curl -fsS --max-time 15 --resolve "$DOMAIN:443:$IP" "https://$DOMAIN/api/health" -o /dev/null
CHECK="health on https://$DOMAIN (DNS -> $IP, valid certificate)"
domain_ok() {
  local i
  for i in $(seq 60); do
    [ "$(curl -fsS --max-time 10 -o /dev/null -w '%{remote_ip}' "https://$DOMAIN/api/health" 2>/dev/null)" = "$IP" ] && return 0
    sleep 10
  done
  return 1
}
check domain_ok
CHECK="certificate: $(curl -fsS --max-time 10 --resolve "$DOMAIN:443:$IP" -o /dev/null -w '%{ssl_verify_result}' "https://$DOMAIN/" 2>/dev/null | sed 's/^0$/verified/'), $(echo | openssl s_client -connect "$IP:443" -servername "$DOMAIN" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null)"
check true
CHECK="GitHub OAuth: authorize page for our client"
oauth_ok() {
  local loc code
  loc=$(curl -fsS --max-time 15 -o /dev/null -w '%{redirect_url}' --resolve "$DOMAIN:443:$IP" "https://$DOMAIN/api/auth/github")
  [[ "$loc" == https://github.com/login/oauth/authorize?* ]] || return 1
  # Logged out, GitHub shows its sign-in page for any client ID, but only a
  # registered OAuth app's page says "to continue to <app>" (checked against
  # a made-up ID).
  curl -fsS --max-time 15 -L "$loc" | grep -qi 'continue to'
}
check oauth_ok
CHECK="hidden-tests deploy key (git ls-remote codejudge-problems)"
check ssm_run "$ID" 'GIT_SSH_COMMAND="ssh -i /etc/codejudge/problems_deploy_key -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new" git ls-remote git@github.com:DhruvGoyal404/codejudge-problems.git HEAD | grep -qE "^[0-9a-f]{40}"'
CHECK="S3 backups (newest object readable)"
check aws_ s3api head-object --bucket "$BUCKET" --key "$DUMP_KEY" --query ContentLength --output text
CHECK="ECR: every image of the release present"
ecr_ok() {
  local r n
  for r in api web worker sandbox-cpp-compile sandbox-cpp-run sandbox-python sandbox-java-compile sandbox-java-run sandbox-node sandbox-go-compile; do
    n=$(aws_ ecr describe-images --repository-name "codejudge/$r" --query 'length(imageDetails)' --output text) || return 1
    [ "$n" -ge 1 ] || return 1
  done
}
check ecr_ok
CHECK="a real submission is Accepted"
check ssm_run "$ID" 'set -a; . /etc/codejudge/worker.env; set +a; /opt/codejudge/current/bin/judge-admin smoke --problem ledger-total --lang cpp --timeout 5m --src /opt/codejudge/problems-private/ledger-total/solutions/ref.cpp | grep -E "verdict AC|submit to verdict"'
CHECK="users and submissions equal the counts recorded at the final backup ($LIVE)"
check test -n "$COUNTS"
[ "$fail" = 0 ] || die "some checks failed (above); the site is up: fix, or run ./codejudge-down.sh"

secs=$(($(date +%s) - T0))
printf '\n\033[1m+------------------------------------------------------------------+\n' >&2
printf '| CodeJudge is UP                                                  |\n' >&2
printf '|   URL:       https://%-44s|\n' "$DOMAIN" >&2
printf '|   fallback:  add to your hosts file: %-28s|\n' "$IP $DOMAIN" >&2
printf '|   cost:      ~$%s/hour (~Rs %s/hour) while up                 |\n' "$PRICE_HOUR_USD" "$(awk "BEGIN{printf \"%.1f\", $PRICE_HOUR_USD*$USD_INR}")" >&2
printf '|   took:      %-52s|\n' "$((secs / 60)) min $((secs % 60)) s" >&2
printf '|   when done: ./codejudge-down.sh                                 |\n' >&2
printf '+------------------------------------------------------------------+\033[0m\n' >&2

#!/usr/bin/env bash
# CodeJudge release deploy (run as root by the SSM document CodeJudge-Deploy,
# or by hand in an SSM session). Pulls everything by digest, never builds.
#
#   deploy.sh MANIFEST_B64            deploy a release (base64 of release.json)
#   deploy.sh --rollback              redeploy the previous release
#
# release.json (written by .github/workflows/deploy.yml):
#   { "release": "<git sha>", "problems_commit": "<codejudge-problems sha>",
#     "registry": "<account>.dkr.ecr.<region>.amazonaws.com",
#     "images": { "api": "...@sha256:..", "web": "...", "worker": "...",
#                 "sandbox": { "cpp-compile": "...", ... } } }
#
# Steps: fetch secrets from SSM (/codejudge/prod/*) -> ECR login -> pull all
# images by digest -> extract the worker image into /opt/codejudge/releases/<id>
# -> write images.lock.json and /etc/codejudge/*.env -> sync and verify the
# hidden tests at the pinned commit -> switch /opt/codejudge/current -> compose
# up -> migrations -> import problems -> restart the worker -> smoke test
# (Caddy, API health, one AC submission). Any failure after the switch rolls
# back to the previous release (its digests are kept in /opt/codejudge/state).
# Migrations are not rolled back: they must stay backward compatible with the
# previous release (expand, then contract in a later release).
#
# Test seams (CI only; unset in production):
#   DEPLOY_SSM_JSON=file     parameters as {"name": "value"} instead of SSM
#   DEPLOY_SKIP_ECR_LOGIN=1  registry needs no login (local test registry)
#   DEPLOY_PROBLEMS_REPO=url clone the hidden tests from here instead of GitHub
set -euo pipefail

ROOT=/opt/codejudge
STATE=$ROOT/state
RELEASES=$ROOT/releases
ETC=/etc/codejudge
PREFIX=/codejudge/prod
PROBLEMS_DIR=$ROOT/problems-private
PROBLEMS_REPO=${DEPLOY_PROBLEMS_REPO:-git@github.com:DhruvGoyal404/codejudge-problems.git}
# GitHub's published SSH host key: the deploy-key clone never trusts on first use.
GITHUB_HOSTKEY="github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl"
KEEP_RELEASES=3

log() { printf '%s deploy: %s\n' "$(date -u +%FT%TZ)" "$*"; }
die() { log "ERROR: $*"; exit 1; }
[ "$(id -u)" -eq 0 ] || die "run as root"
command -v jq >/dev/null || die "jq missing (run bootstrap.sh)"
install -d -m 0755 "$STATE" "$RELEASES"
exec 9>"$STATE/deploy.lock"
flock -n 9 || die "another deploy is running"

# --- AWS seams -------------------------------------------------------------------
region() {
  if [ -n "${AWS_REGION:-}" ]; then echo "$AWS_REGION"; return; fi
  local t
  t=$(curl -fsS -X PUT http://169.254.169.254/latest/api/token -H "X-aws-ec2-metadata-token-ttl-seconds: 60")
  curl -fsS -H "X-aws-ec2-metadata-token: $t" http://169.254.169.254/latest/meta-data/placement/region
}
fetch_params() { # -> JSON object {short_name: value}
  if [ -n "${DEPLOY_SSM_JSON:-}" ]; then cat "$DEPLOY_SSM_JSON"; return; fi
  aws ssm get-parameters-by-path --region "$REGION" --path "$PREFIX/" --with-decryption --recursive --output json |
    jq --arg p "$PREFIX/" '[.Parameters[] | {key: (.Name | ltrimstr($p)), value: .Value}] | from_entries'
}
ecr_login() {
  [ "${DEPLOY_SKIP_ECR_LOGIN:-}" = 1 ] && return
  aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$1" >/dev/null
}

# --- helpers ---------------------------------------------------------------------
param() { jq -er --arg k "$1" '.[$k] // empty' <<<"$PARAMS" || die "SSM parameter $PREFIX/$1 is missing"; }
write_file() { # write_file PATH MODE GROUP  (content on stdin), atomically
  local tmp
  tmp=$(mktemp "$1.XXXX")
  cat >"$tmp"
  chown "root:$3" "$tmp"
  chmod "$2" "$tmp"
  mv -f "$tmp" "$1"
}
compose() { docker compose -f "$ROOT/current/app/deploy/compose.prod.yaml" --env-file "$ETC/prod.env" "$@"; }
manifest_field() { jq -er "$1" <<<"$2"; }

# Pull, extract and configure a release; nothing running changes yet.
prepare() { # prepare MANIFEST_JSON -> sets REL
  local m=$1 id registry
  id=$(manifest_field .release "$m")
  registry=$(manifest_field .registry "$m")
  REL="$RELEASES/$id"
  log "preparing release $id"
  ecr_login "$registry"
  for ref in $(jq -r '.images | (.api, .web, .worker), (.sandbox[])' <<<"$m"); do
    [[ "$ref" == *@sha256:* ]] || die "image not pinned by digest: $ref"
    docker pull -q "$ref" >/dev/null
  done
  if [ ! -x "$REL/bin/judge-worker" ]; then
    local tmp ctr
    tmp=$(mktemp -d "$RELEASES/.extract.XXXX")
    ctr=$(docker create "$(manifest_field .images.worker "$m")" /none)
    docker cp "$ctr:/opt/codejudge/." "$tmp/" && docker rm "$ctr" >/dev/null
    chmod -R go-w "$tmp" && chmod 0755 "$tmp"
    rm -rf "$REL" && mv "$tmp" "$REL"
  fi
  # The worker runs sandbox containers by image ID (the digest's config).
  mkdir -p "$REL/app/sandbox/images"
  jq -r '.images.sandbox | to_entries[] | "\(.key) \(.value)"' <<<"$m" | while read -r name ref; do
    printf '%s\t%s\n' "$name" "$(docker image inspect --format '{{.Id}}' "$ref")"
  done | jq -Rn '[inputs | split("\t") | {key: .[0], value: .[1]}] | from_entries' >"$REL/app/sandbox/images/images.lock.json.tmp"
  mv -f "$REL/app/sandbox/images/images.lock.json.tmp" "$REL/app/sandbox/images/images.lock.json"
  echo "$m" >"$REL/release.json"
}

# Secrets and image refs into /etc/codejudge (0640 root:codejudge).
configure() { # configure MANIFEST_JSON
  local m=$1 domain pg vk bucket
  domain=$(param domain)
  pg=$(param pg_password)
  vk=$(param valkey_password)
  bucket=$(param backup_bucket)
  [[ "$pg" =~ ^[A-Za-z0-9]{24,}$ && "$vk" =~ ^[A-Za-z0-9]{24,}$ ]] || die "pg_password and valkey_password must be 24+ alphanumeric characters"
  write_file "$ETC/prod.env" 0640 codejudge <<EOF
# Rendered by deploy.sh from SSM $PREFIX/* and release $(manifest_field .release "$m"). Do not edit.
CODEJUDGE_DOMAIN=$domain
PUBLIC_ORIGIN=https://$domain
ACME_EMAIL=$(param acme_email)
CODEJUDGE_PG_PASSWORD=$pg
CODEJUDGE_VALKEY_PASSWORD=$vk
GITHUB_CLIENT_ID=$(param github_client_id)
GITHUB_CLIENT_SECRET=$(param github_client_secret)
GITHUB_REDIRECT_URI=https://$domain/api/auth/github/callback
CODEJUDGE_API_IMAGE=$(manifest_field .images.api "$m")
CODEJUDGE_WEB_IMAGE=$(manifest_field .images.web "$m")
EOF
  write_file "$ETC/worker.env" 0640 codejudge <<EOF
# Rendered by deploy.sh. Do not edit.
CODEJUDGE_DATABASE_URL=postgres://codejudge:$pg@/codejudge?host=/run/codejudge/postgresql&sslmode=disable
CODEJUDGE_VALKEY_URL=unix://:$vk@/run/codejudge/valkey/valkey.sock
CODEJUDGE_PROBLEMS_DIR=$ROOT/current/app/problems
CODEJUDGE_PROBLEMS_TESTS_DIR=$PROBLEMS_DIR
EOF
  write_file "$ETC/backup.env" 0640 codejudge <<EOF
# Rendered by deploy.sh. Do not edit.
BACKUP_DEST=s3://$bucket/codejudge/pg
AWS_REGION=$REGION
EOF
}

# Hidden tests at the release's pinned commit, verified against the release's
# public packages (judge-admin check: bounds, sample copies, catalogue rules).
sync_problems() { # sync_problems MANIFEST_JSON
  local commit key
  commit=$(manifest_field .problems_commit "$1")
  key="$ETC/problems_deploy_key"
  export GIT_SSH_COMMAND="ssh -i $key -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$STATE/github_known_hosts"
  if [ -z "${DEPLOY_PROBLEMS_REPO:-}" ]; then
    param problems_deploy_key | write_file "$key" 0600 root
    echo "$GITHUB_HOSTKEY" >"$STATE/github_known_hosts"
  fi
  if [ ! -d "$PROBLEMS_DIR/.git" ]; then
    git clone -q --no-checkout "$PROBLEMS_REPO" "$PROBLEMS_DIR"
  fi
  git -C "$PROBLEMS_DIR" fetch -q origin
  git -C "$PROBLEMS_DIR" -c advice.detachedHead=false checkout -q --force "$commit"
  chown -R root:codejudge "$PROBLEMS_DIR" && chmod -R g+rX,o-rwx "$PROBLEMS_DIR"
  CODEJUDGE_PROBLEMS_TESTS_DIR=$PROBLEMS_DIR "$REL/bin/judge-admin" check "$REL/app/problems" >/dev/null ||
    die "hidden tests at $commit do not match release $(basename "$REL")"
  log "hidden tests at ${commit:0:12} verified"
}

# Point "current" at REL and bring everything up on it.
activate() {
  local tmp="$ROOT/.current.tmp"
  ln -sfn "$REL" "$tmp" && mv -Tf "$tmp" "$ROOT/current"
  "$REL/app/deploy/host/install-units.sh" "$REL/app"
  compose up -d --no-build --wait --wait-timeout 300 --remove-orphans
  compose run --rm migrate up
  set -a && . "$ETC/worker.env" && set +a
  "$REL/bin/judge-admin" import "$REL/app/problems" >/dev/null
  # Waits for in-flight submissions to finish (TimeoutStopSec in the unit).
  systemctl restart judge-worker
}

smoke() {
  local domain code
  domain=$(param domain)
  code=$(curl -s -o /dev/null -w '%{http_code}' -H "Host: $domain" http://127.0.0.1/ || true)
  [ "$code" = 308 ] || die "smoke: Caddy answered $code on :80 (want 308 to HTTPS)"
  compose exec -T api node -e "fetch('http://127.0.0.1:8080/health').then(r=>r.json()).then(j=>process.exit(j.ok?0:1),()=>process.exit(1))" ||
    die "smoke: API health check failed"
  systemctl is-active --quiet judge-worker || die "smoke: judge-worker is not running"
  set -a && . "$ETC/worker.env" && set +a
  "$ROOT/current/bin/judge-admin" smoke --problem ledger-total --lang cpp --timeout 5m \
    --src "$PROBLEMS_DIR/ledger-total/solutions/ref.cpp" || die "smoke: the test submission was not accepted"
  log "smoke test passed"
}

cleanup() { # keep the last KEEP_RELEASES releases and the images of current + previous
  local keep
  keep=$( (cat "$STATE/current.json" "$STATE/previous.json" 2>/dev/null || true) | jq -r '.images | (.api, .web, .worker), .sandbox[]' | sort -u)
  ls -1dt "$RELEASES"/*/ 2>/dev/null | tail -n +$((KEEP_RELEASES + 1)) | while read -r d; do
    [ "$(readlink -f "$ROOT/current")/" = "$d" ] || rm -rf "$d"
  done
  docker images --digests --format '{{.Repository}}@{{.Digest}}' | grep '/codejudge/' | while read -r ref; do
    grep -qxF "$ref" <<<"$keep" || docker rmi -f "$ref" >/dev/null 2>&1 || true
  done
}

deploy() { # deploy MANIFEST_JSON
  prepare "$1"
  configure "$1"
  sync_problems "$1"
  activate
  smoke
}

# Runs "$@" in a subshell with errexit really on. (Inside "if" or "&&", bash
# ignores set -e for the whole function body, so a failing step would not stop.)
attempt() {
  set +e
  ( set -e; "$@" )
  local rc=$?
  set -e
  return $rc
}

REGION=$(region)
PARAMS=$(fetch_params)

if [ "${1:-}" = "--rollback" ]; then
  [ -s "$STATE/previous.json" ] || die "no previous release to roll back to"
  m=$(cat "$STATE/previous.json")
  log "manual rollback to $(manifest_field .release "$m")"
  attempt deploy "$m" || die "rollback failed: the host needs attention (see docs/DEPLOY.md, Rollback)"
  # Swap: the release rolled away from becomes "previous" (roll forward = --rollback again).
  cp "$STATE/current.json" "$STATE/previous.json.tmp"
  cp "$STATE/previous.json" "$STATE/current.json"
  mv -f "$STATE/previous.json.tmp" "$STATE/previous.json"
  log "rolled back"
  exit 0
fi

new=$(base64 -d <<<"${1:?usage: deploy.sh MANIFEST_B64 | --rollback}") || die "manifest is not base64"
jq -e '.release and .problems_commit and .registry and .images.api and .images.web and .images.worker and (.images.sandbox | length == 6)' <<<"$new" >/dev/null ||
  die "manifest is incomplete"
log "deploying release $(manifest_field .release "$new")"

# Nothing running has changed until activate(); a failure from there on rolls back.
prepare "$new"
configure "$new"
sync_problems "$new"
activate_and_smoke() { activate; smoke; }
if attempt activate_and_smoke; then
  # Redeploying the live release (e.g. after rotating a secret) keeps "previous".
  if [ -s "$STATE/current.json" ] && [ "$(jq -r .release "$STATE/current.json")" != "$(manifest_field .release "$new")" ]; then
    cp "$STATE/current.json" "$STATE/previous.json"
  fi
  echo "$new" >"$STATE/current.json"
  cleanup
  log "release $(manifest_field .release "$new") is live"
  exit 0
fi

log "deploy failed; rolling back"
if [ -s "$STATE/current.json" ]; then
  old=$(cat "$STATE/current.json")
  if attempt deploy "$old"; then
    die "rolled back to $(manifest_field .release "$old"); release $(manifest_field .release "$new") was NOT deployed"
  fi
  die "ROLLBACK FAILED: the host needs attention (see docs/DEPLOY.md, Rollback)"
fi
die "first deploy failed and there is nothing to roll back to"

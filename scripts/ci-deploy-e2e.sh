#!/usr/bin/env bash
# End-to-end test of deploy/host/deploy.sh on a bootstrapped Ubuntu 24.04 host
# (CI), with the AWS parts swapped for local stand-ins: a local registry
# instead of ECR, a parameters file instead of SSM, the hidden tests from a
# local checkout instead of GitHub over SSH.
#
#   SSM_DOC_TEMPLATE=infra/cdk.out/CodeJudgeProd.template.json scripts/ci-deploy-e2e.sh PROBLEMS_CHECKOUT
#
# Deploys go through the SSM document's own commands, run with sh as SSM
# does; the manual rollback calls deploy.sh directly.
#
# Requires: bootstrap.sh already run, sandbox images built
# (scripts/build-images.ps1). Scenario:
#   r1 good       -> live, smoke AC
#   r2 broken API -> deploy fails, rolls back to r1 automatically
#   r3 good       -> live, previous = r1
#   r3 again      -> still live, previous still r1
#   --rollback    -> r1 live again, previous = r3
set -euo pipefail
cd "$(dirname "$0")/.."
problems=$(realpath "${1:?usage: ci-deploy-e2e.sh PROBLEMS_CHECKOUT}")
reg=localhost:5000
tmp=${RUNNER_TEMP:-$(mktemp -d)}
log() { printf '\n=== %s\n' "$*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

log "local registry"
docker run -d --rm --name codejudge-ci-registry -p 127.0.0.1:5000:5000 \
  registry:3.0.0@sha256:6c5666b861f3505b116bb9aa9b25175e71210414bd010d92035ff64018f9457e >/dev/null
for _ in $(seq 30); do curl -fs "http://$reg/v2/" >/dev/null && break; sleep 1; done

push() { # push LOCAL_IMAGE REPO TAG -> prints repo@digest
  docker tag "$1" "$reg/codejudge/$2:$3"
  docker push -q "$reg/codejudge/$2:$3" >/dev/null
  docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$reg/codejudge/$2:$3" | grep -m1 "^$reg/codejudge/$2@"
}

log "build release images"
docker build -q -t ci/api -f api/Dockerfile . >/dev/null
docker build -q -t ci/web -f deploy/web.Dockerfile . >/dev/null
docker build -q -t ci/worker -f deploy/worker.Dockerfile . >/dev/null
api=$(push ci/api api r1)
web=$(push ci/web web r1)
worker=$(push ci/worker worker r1)
sandbox='{}'
for s in cpp-compile cpp-run python java-compile java-run node go-compile; do
  ref=$(push "codejudge/judge-$s:dev" "sandbox-$s" r1)
  sandbox=$(jq --arg k "$s" --arg v "$ref" '. + {($k): $v}' <<<"$sandbox")
done
# Broken release: the API process runs but never answers its health check.
printf 'FROM %s\nCMD ["node", "-e", "setInterval(() => {}, 1e9)"]\n' "$api" | docker build -q -t ci/api-broken - >/dev/null
api_broken=$(push ci/api-broken api broken)

manifest() { # manifest RELEASE API_REF -> base64
  jq -cn --arg r "$1" --arg c "$(git -C "$problems" rev-parse HEAD)" --arg reg "$reg" \
    --arg api "$2" --arg web "$web" --arg worker "$worker" --argjson sb "$sandbox" \
    '{release: $r, problems_commit: $c, registry: $reg, images: {api: $api, web: $web, worker: $worker, sandbox: $sb}}' | base64 -w0
}

params="$tmp/ssm.json"
rand() { openssl rand -hex 16; }
(umask 077 && jq -n --arg pg "$(rand)" --arg vk "$(rand)" '{
  domain: "localhost", acme_email: "ci@example.com", pg_password: $pg, valkey_password: $vk,
  github_client_id: "ci-client-id", github_client_secret: "ci-client-secret", backup_bucket: "ci-bucket"
}' >"$params")
# root clones the runner-owned checkout
sudo git config --system --add safe.directory '*'

deploy() {
  sudo env AWS_REGION=ap-south-1 DEPLOY_SSM_JSON="$params" DEPLOY_SKIP_ECR_LOGIN=1 \
    DEPLOY_PROBLEMS_REPO="file://$problems" deploy/host/deploy.sh "$@"
}

# deploy_doc MANIFEST_B64: what SSM does for CodeJudge-Deploy. The document's
# runCommand lines (from the synthesized template) go into _script.sh, the
# parameter is pasted in textually, and the file runs with sh (dash).
doc_template=${SSM_DOC_TEMPLATE:?set SSM_DOC_TEMPLATE to the synthesized CodeJudgeProd template}
deploy_doc() {
  local script="$tmp/_script.sh"
  jq -r '[.Resources[] | select(.Type == "AWS::SSM::Document")][0].Properties.Content.mainSteps[0].inputs.runCommand | join("\n")' \
    "$doc_template" | sed "s#{{ Manifest }}#$1#g" >"$script"
  grep -q "deploy.sh '$1'" "$script" || fail "the manifest was not substituted into the document"
  sudo env AWS_REGION=ap-south-1 DEPLOY_SSM_JSON="$params" DEPLOY_SKIP_ECR_LOGIN=1 \
    DEPLOY_PROBLEMS_REPO="file://$problems" sh "$script"
}
expect_live() { # expect_live RELEASE [PREVIOUS]
  [ "$(readlink /opt/codejudge/current)" = "/opt/codejudge/releases/$1" ] || fail "current -> $(readlink /opt/codejudge/current), want $1"
  [ "$(sudo jq -r .release /opt/codejudge/state/current.json)" = "$1" ] || fail "state/current.json is not $1"
  if [ -n "${2:-}" ]; then
    [ "$(sudo jq -r .release /opt/codejudge/state/previous.json)" = "$2" ] || fail "state/previous.json is not $2"
  fi
  systemctl is-active --quiet judge-worker || fail "judge-worker is not active"
  code=$(curl -sk -o /dev/null -w '%{http_code}' --resolve localhost:443:127.0.0.1 https://localhost/api/health)
  [ "$code" = 200 ] || fail "https://localhost/api/health answered $code"
  echo "ok: $1 is live"
}

log "deploy r1"
deploy_doc "$(manifest r1 "$api")"
expect_live r1
sudo stat -c '%a %U:%G %n' /etc/codejudge/prod.env /etc/codejudge/worker.env /etc/codejudge/backup.env
for f in prod.env worker.env backup.env; do
  [ "$(sudo stat -c '%a %U:%G' "/etc/codejudge/$f")" = "640 root:codejudge" ] || fail "/etc/codejudge/$f permissions"
done
sudo systemd-analyze verify /etc/systemd/system/judge-worker.service /etc/systemd/system/pg-backup.service /etc/systemd/system/pg-backup.timer

log "deploy r2 (broken API): must fail and roll back to r1"
if deploy_doc "$(manifest r2 "$api_broken")"; then fail "the broken release deployed"; fi
expect_live r1

log "deploy r3"
deploy_doc "$(manifest r3 "$api")"
expect_live r3 r1

log "redeploy the live release (secret rotation): previous stays r1"
deploy_doc "$(sudo base64 -w0 /opt/codejudge/state/current.json)"
expect_live r3 r1

log "calibration: a deploy starts it, a later deploy reports it"
cal=$(base64 -d <<<"$(manifest r3 "$api")" |
  jq -c '. + {calibrate: "start", calibrate_problems: "ledger-total", calibrate_runs: 1, calibrate_latency_n: 2}' | base64 -w0)
deploy_doc "$cal" | tee "$tmp/cal1.out"
grep -q "calibration: started" "$tmp/cal1.out" || fail "the calibration did not start"
sudo jq -e 'has("calibrate") | not' /opt/codejudge/state/current.json >/dev/null || fail "the calibration request was kept in current.json"
for _ in $(seq 120); do systemctl is-active --quiet codejudge-calibrate || break; sleep 5; done
deploy_doc "$(sudo base64 -w0 /opt/codejudge/state/current.json)" | tee "$tmp/cal2.out"
grep -q "calibration: started" "$tmp/cal2.out" && fail "a plain redeploy started another calibration"
summary=$(sed -n '/^CALIBRATION-BEGIN/,/^CALIBRATION-END/{/^CALIBRATION-/d;p}' "$tmp/cal2.out" | base64 -d | gunzip) ||
  fail "no calibration summary in the deploy output"
echo "$summary"
# Six references (all AC), one slow solution (TLE), two latency samples.
[ "$(awk -F'\t' '$1 == "ledger-total" && $2 ~ /^ref\./ && $6 == "AC"' <<<"$summary" | wc -l)" = 6 ] || fail "references not all AC"
awk -F'\t' '$1 == "ledger-total" && $2 ~ /^slow/ && $6 == "TLE" {ok = 1} END {exit !ok}' <<<"$summary" || fail "slow solution did not TLE"
awk -F'\t' '$1 == "latency" && $2 == "ledger-total" && $3 == 2 && $4 > 0 {ok = 1} END {exit !ok}' <<<"$summary" || fail "no latency"
expect_live r3 r1

log "manual rollback"
deploy --rollback
expect_live r1 r3

log "all deploy scenarios passed"

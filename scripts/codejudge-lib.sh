#!/usr/bin/env bash
# Shared by codejudge-up.sh and codejudge-down.sh (sourced, not run). Bash for
# Git Bash on Windows (and Linux). See MAINTENANCE.md, "Up and down".
# shellcheck disable=SC2034 # constants used by the scripts that source this

export MSYS_NO_PATHCONV=1 # "/codejudge/..." SSM names must reach aws.exe unchanged
export AWS_PROFILE=${AWS_PROFILE:-codejudge}
export AWS_REGION=ap-south-1 AWS_DEFAULT_REGION=ap-south-1 AWS_PAGER=""
# aws.exe prints in the Windows code page and dies on characters such as "->" in host output.
export PYTHONUTF8=1

# pwd -W: the Windows form (E:/...) that native git and aws.exe accept with MSYS_NO_PATHCONV set.
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && { pwd -W 2>/dev/null || pwd; })
PERSISTENT=CodeJudgeProd
HOST_STACK=CodeJudgeHost
HOST_TAG_KEY=codejudge:host
HOST_TAG_VALUE=prod
PARKED_IP=192.0.2.1 # TEST-NET-1: never routable, so the name never follows a released IP
CF_TOKEN_PARAM=/codejudge/ops/cloudflare-token
REPO=DhruvGoyal404/codejudge
COMPOSE_PROJECT=codejudge-prod # deploy/compose.prod.yaml "name:"
FINAL_PREFIX=codejudge/final/  # never expires (infra/: only codejudge/pg/ does)
RELEASE_KEY=codejudge/final/release.json # the release live at the last down: up redeploys it
# Expected ECR: 2 releases (current + previous) of the 10 codejudge/* images,
# ~1.33 GiB each as ECR reported them on 2026-11-18 (cpp-compile 487 MiB,
# go-compile 348, java-compile 203, java-run 97, node 78, api 65, python 45,
# web 24, worker 13, cpp-run 1) = ~2.66 GiB, ~$0.27/month (shared layers make
# the real bill lower). Flagged above 3.2 GiB: ~20% room for image growth,
# while a third release (~4 GiB) still trips it.
ECR_MAX_BYTES=$((32 * 1073741824 / 10))
ECR_MAX_LABEL="3.2 GiB"
ECR_PREFIX=codejudge/            # CodeJudge's repos; others in this account belong to other projects
CDK_ASSETS_PREFIX=cdk-hnb659fds- # the CDK bootstrap's asset bucket and repo, which CodeJudge deploys through
NIGHTLY_PREFIX=codejudge/pg/   # the only prefix the host may read and write
KEEP_FINAL=5
# On-demand prices, ap-south-1, from the AWS Pricing API (2026-10-30).
PRICE_HOUR_USD=0.0299 # t3.small 0.0224 + gp3 20 GB (0.0912/GB-month) 0.0025 + public IPv4 0.005
USD_INR=88

# Windows form too (C:/...): native jq, curl and aws.exe must open these files.
WORK=$(cd "$(mktemp -d)" && { pwd -W 2>/dev/null || pwd; })
trap 'rm -rf "$WORK"' EXIT
# No silent exits: a command that fails outside a condition (set -e) prints
# where and what, once, from the top level (set -E: functions inherit it).
set -E
on_err() {
  local rc=$?
  [ "$BASH_SUBSHELL" -eq 0 ] || return 0
  printf '\n\033[31mERROR: %s, line %s: `%s` failed (exit %s)\033[0m\n' "${BASH_SOURCE[1]:-$0}" "${BASH_LINENO[0]:-?}" "$BASH_COMMAND" "$rc" >&2
}
trap on_err ERR
T0=$(date +%s)

log() { printf '\n\033[1m[%s +%ss] %s\033[0m\n' "$(date +%H:%M:%S)" "$(($(date +%s) - T0))" "$*" >&2; }
die() { printf '\n\033[31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }
winpath() { if command -v cygpath >/dev/null; then cygpath -w "$1"; else echo "$1"; fi; }

# retry CMD...: runs CMD up to 6 times while the error looks transient
# (throttling, 5xx, "in progress", connection trouble); output on success only.
retry() {
  local n=0 out
  while :; do
    if out=$("$@" 2>&1); then
      [ -z "$out" ] || printf '%s\n' "$out"
      return 0
    fi
    n=$((n + 1))
    if [ "$n" -ge 6 ] || ! grep -qiE 'thrott|toomanyrequests|requestlimitexceeded|internalerror|internal error|serviceunavailable|unavailable|\b50[0234]\b|in ?progress|timed? ?out|could not connect|connection (reset|refused|was closed)|incorrectinstancestate|invalidinstanceid|pending' <<<"$out"; then
      printf '%s\n' "$out" >&2
      return 1
    fi
    sleep $((n * 5))
  done
}
aws_() { retry aws "$@"; }
param() { aws_ ssm get-parameter --name "$1" --with-decryption --query Parameter.Value --output text; }

# --- preflight ----------------------------------------------------------------
preflight() {
  local c plan
  for c in aws jq npx npm gh git curl; do command -v "$c" >/dev/null || die "$c is not installed"; done
  if ! aws sts get-caller-identity >/dev/null 2>&1; then
    log "AWS session expired: approve the login in the browser"
    aws sso login --profile "$AWS_PROFILE" || die "aws sso login failed"
  fi
  ACCOUNT=$(aws_ sts get-caller-identity --query Account --output text)
  # The right account is the one that holds the project's persistent stack.
  aws_ cloudformation describe-stacks --stack-name "$PERSISTENT" --query 'Stacks[0].StackStatus' --output text >/dev/null ||
    die "account ${ACCOUNT:0:4}******** has no $PERSISTENT stack: wrong AWS_PROFILE?"
  # Billing state from the API, not a cache: the account must be active.
  plan=$(aws_ freetier get-account-plan-state --query '[accountPlanType,accountPlanStatus]' --output text) ||
    die "could not read the account's plan state"
  [[ "$plan" == *ACTIVE* ]] || die "account plan is not active: $plan"
  gh auth status --hostname github.com >/dev/null 2>&1 || die "gh is not logged in: gh auth login"
  DOMAIN=$(param /codejudge/prod/domain)
  ALARM_EMAIL=$(param /codejudge/ops/alarm_email)
  BUDGET_EMAIL=$(param /codejudge/ops/budget_email)
  BUCKET=$(param /codejudge/prod/backup_bucket)
  echo "account ${ACCOUNT:0:4}******** (holds $PERSISTENT), plan: $plan, region $AWS_REGION, site $DOMAIN" >&2
}

# --- CDK ------------------------------------------------------------------------
cdk_() {
  (
    cd "$ROOT/infra" || exit 1
    [ -d node_modules ] || npm ci --no-audit --no-fund >&2
    # --require-approval and --progress are deploy options; destroy warns "Unknown option(s)".
    local extra=()
    [ "$1" = deploy ] && extra=(--require-approval never --progress events)
    npx cdk "$@" -c alarmEmail="$ALARM_EMAIL" -c budgetEmail="$BUDGET_EMAIL" "${extra[@]}"
  )
}
stack_exists() {
  local s
  s=$(aws cloudformation describe-stacks --stack-name "$1" --query 'Stacks[0].StackStatus' --output text 2>/dev/null) || return 1
  [ "$s" != DELETE_COMPLETE ]
}
stack_output() { aws_ cloudformation describe-stacks --stack-name "$1" --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text; }

# --- the host -------------------------------------------------------------------
# host_id: the running (or starting) host, found by its tag; empty if none.
host_id() {
  local id
  id=$(aws_ ec2 describe-instances --filters "Name=tag:$HOST_TAG_KEY,Values=$HOST_TAG_VALUE" Name=instance-state-name,Values=pending,running \
    --query 'Reservations[].Instances[].InstanceId' --output text)
  [ "$id" = None ] && id=""
  echo "$id"
}

# ssm_send ID DOCUMENT PARAMS_FILE [VERSION]: runs a command document on the
# host, prints its output, fails if it fails.
ssm_send() {
  local id=$1 doc=$2 f=$3 cid st out err
  cid=$(aws_ ssm send-command --instance-ids "$id" --document-name "$doc" ${4:+--document-version "$4"} --timeout-seconds 120 \
    --parameters "file://$(winpath "$f")" --query Command.CommandId --output text) || return 1
  st=Pending
  while :; do
    sleep 5
    st=$(aws ssm get-command-invocation --command-id "$cid" --instance-id "$id" --query Status --output text 2>/dev/null || echo Pending)
    case "$st" in Pending | InProgress | Delayed) ;; *) break ;; esac
  done
  out=$(aws_ ssm get-command-invocation --command-id "$cid" --instance-id "$id" --query StandardOutputContent --output text)
  err=$(aws_ ssm get-command-invocation --command-id "$cid" --instance-id "$id" --query StandardErrorContent --output text)
  [ -z "$out" ] || printf '%s\n' "$out"
  [ -z "$err" ] || printf '%s\n' "$err" >&2
  [ "$st" = Success ] || { echo "host command $st" >&2; return 1; }
}
# ssm_run ID SCRIPT [TIMEOUT_S]: runs SCRIPT with bash as root on the host
# (AWS-RunShellScript), prints its output, fails if it fails.
ssm_run() {
  local f="$WORK/ssm-params.json"
  jq -n --arg s "$2" --arg t "${3:-1800}" \
    '{commands: ["cat > /root/codejudge-op.sh <<'"'"'CODEJUDGE_OP'"'"'\n" + $s + "\nCODEJUDGE_OP", "exec bash /root/codejudge-op.sh"], executionTimeout: [$t]}' >"$f"
  ssm_send "$1" AWS-RunShellScript "$f"
}
# result KEY OUTPUT: the value of a "RESULT KEY=value" line the host printed.
result() { sed -n "s/^RESULT $1=//p" <<<"$2" | tail -n 1 | tr -d '\r'; }

# --- Cloudflare DNS -------------------------------------------------------------
cf_api() { # cf_api METHOD PATH [JSON]; the token goes in on stdin, never in argv
  local tok
  tok=$(param "$CF_TOKEN_PARAM") || die "Cloudflare token missing: store it in SSM $CF_TOKEN_PARAM (MAINTENANCE.md)"
  if [ -n "${3:-}" ]; then
    printf 'Authorization: Bearer %s\n' "$tok" | retry curl -sS --fail-with-body -X "$1" -H @- -H 'Content-Type: application/json' --data "$3" "https://api.cloudflare.com/client/v4$2"
  else
    printf 'Authorization: Bearer %s\n' "$tok" | retry curl -sS --fail-with-body -X "$1" -H @- "https://api.cloudflare.com/client/v4$2"
  fi
}
cf_check() {
  cf_api GET /user/tokens/verify | jq -e '.result.status == "active"' >/dev/null || die "the Cloudflare token is not active"
}
# cf_set_a IP: points DOMAIN's A record at IP (DNS only, TTL 60).
cf_set_a() {
  local ip=$1 zone rec cur body
  zone=$(cf_api GET "/zones?name=${DOMAIN#*.}" | jq -r '.result[0].id // empty')
  [ -n "$zone" ] || die "Cloudflare zone ${DOMAIN#*.} not found (the token needs Zone:Read and DNS:Edit on it)"
  rec=$(cf_api GET "/zones/$zone/dns_records?type=A&name=$DOMAIN")
  body=$(jq -nc --arg ip "$ip" --arg n "$DOMAIN" '{type: "A", name: $n, content: $ip, ttl: 60, proxied: false}')
  cur=$(jq -r '.result[0].content // empty' <<<"$rec")
  if [ "$cur" = "$ip" ] && [ "$(jq -r '.result[0].proxied' <<<"$rec")" = false ]; then
    echo "DNS: $DOMAIN A $ip already" >&2
  elif [ -n "$cur" ]; then
    cf_api PATCH "/zones/$zone/dns_records/$(jq -r '.result[0].id' <<<"$rec")" "$body" | jq -e .success >/dev/null || die "DNS update failed"
    echo "DNS: $DOMAIN A $cur -> $ip (grey cloud, TTL 60)" >&2
  else
    cf_api POST "/zones/$zone/dns_records" "$body" | jq -e .success >/dev/null || die "DNS create failed"
    echo "DNS: $DOMAIN A $ip created (grey cloud, TTL 60)" >&2
  fi
}

# --- alarms ---------------------------------------------------------------------
backup_alarm() { aws_ cloudwatch describe-alarms --alarm-name-prefix "$PERSISTENT-BackupMissing" --query 'MetricAlarms[0].AlarmName' --output text; }

# --- S3 backups -----------------------------------------------------------------
# newest PREFIX GLOB: the newest key under s3://BUCKET/PREFIX whose name matches
# GLOB (names carry a UTC timestamp, so the lexically last is the newest).
# The newest key under prefix $1 matching $2, or nothing. An empty prefix (the
# CLI prints "None") is not an error: nightly backups expire after 14 days.
newest() {
  local keys
  keys=$(aws_ s3api list-objects-v2 --bucket "$BUCKET" --prefix "$1" --query 'Contents[].Key' --output text)
  [ "$keys" = None ] && return 0
  printf '%s\n' "$keys" | tr '\t' '\n' | { grep -E "$2" || true; } | sort | tail -n 1
}

# --- ECR ------------------------------------------------------------------------
codejudge_repos() {
  aws_ ecr describe-repositories --query "repositories[?starts_with(repositoryName, '$ECR_PREFIX')].repositoryName" --output text | tr '\t' '\n' | tr -d '\r' | grep . || true
}
# ecr_prune: applies the repos' lifecycle rule (keep the 2 newest images) now.
# ECR applies it up to a day after a push, so a down right after `up --build`
# would still store 3 releases. Never removes an image of the saved release
# (codejudge/final/release.json), even one outside the 2 newest.
ecr_prune() {
  local keep repo d tags
  keep=$(aws_ s3 cp "s3://$BUCKET/$RELEASE_KEY" - 2>/dev/null | jq -r '.images | .. | strings | select(contains("@sha256:")) | split("@")[1]' || true)
  for repo in $(codejudge_repos); do
    while read -r d tags; do
      [ -n "$d" ] || continue
      if grep -qxF "$d" <<<"$keep"; then
        echo "kept $repo ${tags:0:12}: the saved release" >&2
        continue
      fi
      aws_ ecr batch-delete-image --repository-name "$repo" --image-ids imageDigest="$d" >/dev/null
      echo "pruned $repo ${tags:0:12} (older than the 2 newest releases)" >&2
    done < <(aws_ ecr describe-images --repository-name "$repo" \
      --query 'reverse(sort_by(imageDetails,&imagePushedAt))[].[imageDigest, join(`,`, imageTags || [`-`])]' --output text |
      tr -d '\r' | tail -n +3)
  done
}

# --- audit ------------------------------------------------------------------------
# audit: everything that can still bill, with its idle cost. Exits non-zero
# ("STILL BILLING") if anything beyond CodeJudge's expected storage remains.
# Storage is scoped to CodeJudge (codejudge/* repos, its backup bucket, the CDK
# bootstrap assets); other projects' repos and buckets in the account are
# listed, never counted.
audit() {
  local bad=0 n v line region other=0
  log "Audit: what can still bill"
  report() { # report BILLING? WHAT
    if [ "$1" = yes ]; then printf '  \033[31m%-6s\033[0m %s\n' BILLS "$2"; bad=1; else printf '  %-6s %s\n' ok "$2"; fi
  }
  n=$(aws_ ec2 describe-instances --filters Name=instance-state-name,Values=pending,running,stopping,stopped --query 'length(Reservations[].Instances[])' --output text)
  report "$([ "$n" = 0 ] && echo no || echo yes)" "EC2 instances (ap-south-1): $n (t3.small \$0.0224/h each while running)"
  n=$(aws_ ec2 describe-volumes --query 'length(Volumes)' --output text)
  report "$([ "$n" = 0 ] && echo no || echo yes)" "EBS volumes: $n (gp3 \$0.0912/GB-month)"
  n=$(aws_ ec2 describe-snapshots --owner-ids self --query 'length(Snapshots)' --output text)
  report "$([ "$n" = 0 ] && echo no || echo yes)" "EBS snapshots: $n"
  n=$(aws_ ec2 describe-addresses --query 'length(Addresses)' --output text)
  report "$([ "$n" = 0 ] && echo no || echo yes)" "Elastic IPs: $n (\$0.005/h each, idle or not)"
  n=$(aws_ ec2 describe-network-interfaces --query 'length(NetworkInterfaces[?Association.PublicIp])' --output text)
  report "$([ "$n" = 0 ] && echo no || echo yes)" "public IPv4 on network interfaces: $n (\$0.005/h each)"
  n=$(aws_ ec2 describe-nat-gateways --filter Name=state,Values=pending,available --query 'length(NatGateways)' --output text)
  report "$([ "$n" = 0 ] && echo no || echo yes)" "NAT gateways: $n"
  n=$(aws_ elbv2 describe-load-balancers --query 'length(LoadBalancers)' --output text)
  v=$(aws_ elb describe-load-balancers --query 'length(LoadBalancerDescriptions)' --output text)
  report "$([ "$n$v" = 00 ] && echo no || echo yes)" "load balancers: $n (v2) + $v (classic)"
  # Registries: billed by stored bytes.
  v=0
  while read -r line; do
    [ -n "$line" ] || continue
    n=$(aws_ ecr describe-images --repository-name "$line" --query 'sum(imageDetails[].imageSizeInBytes)' --output text)
    [ "$n" = None ] && n=0
    case $line in
      "$ECR_PREFIX"* | "$CDK_ASSETS_PREFIX"*)
        v=$((v + n))
        [ "$n" = 0 ] || echo "         ECR $line: $((n / 1048576)) MiB" >&2 ;;
      *)
        other=$((other + n))
        echo "         ECR $line: $((n / 1048576)) MiB (other project, not CodeJudge)" >&2 ;;
    esac
  done < <(aws_ ecr describe-repositories --query 'repositories[].repositoryName' --output text | tr '\t' '\n' | tr -d '\r')
  # Expected: the current and previous release, kept so up needs no rebuild.
  report "$([ "$v" -le "$ECR_MAX_BYTES" ] && echo no || echo yes)" "CodeJudge ECR: $((v / 1048576)) MiB, expected (current + previous release, ~2.7 GiB): ~\$$(awk "BEGIN{printf \"%.2f\", $v/1073741824*0.10}")/month (\$0.10/GB-month; flagged above $ECR_MAX_LABEL)"
  # S3: CodeJudge's backups and the CDK assets: a few MB, ~nothing a month.
  v=0
  for n in $(aws_ s3api list-buckets --query 'Buckets[].Name' --output text | tr -d '\r'); do
    line=$(aws_ s3api list-objects-v2 --bucket "$n" --query 'sum(Contents[].Size)' --output text 2>/dev/null || echo 0)
    [ "$line" = None ] && line=0
    if [ "$n" = "$BUCKET" ] || [[ "$n" == "$CDK_ASSETS_PREFIX"* ]]; then
      v=$((v + line))
      echo "         S3 $n: $((line / 1024)) KiB" >&2
    else
      other=$((other + line))
      echo "         S3 $n: $((line / 1048576)) MiB (other project, not CodeJudge)" >&2
    fi
  done
  report "$([ "$v" -lt $((100 * 1048576)) ] && echo no || echo yes)" "CodeJudge S3: $((v / 1024)) KiB (\$0.025/GB-month: ~\$$(awk "BEGIN{printf \"%.4f\", $v/1073741824*0.025}")/month)"
  printf '  %-6s %s\n' info "other projects (not CodeJudge): $((other / 1048576)) MiB of ECR + S3, not counted here" >&2
  n=$(aws_ secretsmanager list-secrets --query 'length(SecretList)' --output text)
  report "$([ "$n" = 0 ] && echo no || echo yes)" "Secrets Manager secrets: $n (\$0.40/month each; SSM standard parameters are free)"
  n=0
  for v in $(aws_ kms list-keys --query 'Keys[].KeyId' --output text | tr -d '\r'); do
    line=$(aws_ kms describe-key --key-id "$v" --query '[KeyMetadata.KeyManager,KeyMetadata.KeyState]' --output text)
    [[ "$line" == CUSTOMER*Enabled* ]] && n=$((n + 1))
  done
  report "$([ "$n" = 0 ] && echo no || echo yes)" "customer-managed KMS keys: $n (\$1/month each)"
  n=$(aws_ cloudwatch describe-alarms --query 'length(MetricAlarms)' --output text)
  report "$([ "$n" -le 10 ] && echo no || echo yes)" "CloudWatch alarms: $n (first 10 free)"
  v=$(aws_ logs describe-log-groups --query 'sum(logGroups[].storedBytes)' --output text)
  [ "$v" = None ] && v=0
  report "$([ "$v" -lt $((100 * 1048576)) ] && echo no || echo yes)" "CloudWatch Logs storage: $((v / 1024)) KiB"
  # Other regions: anything running there would bill too.
  for region in $(aws_ ec2 describe-regions --query 'Regions[].RegionName' --output text | tr -d '\r'); do
    [ "$region" = "$AWS_REGION" ] && continue
    n=$(aws ec2 describe-instances --region "$region" --filters Name=instance-state-name,Values=pending,running,stopping,stopped --query 'length(Reservations[].Instances[])' --output text 2>/dev/null || echo 0)
    v=$(aws ec2 describe-addresses --region "$region" --query 'length(Addresses)' --output text 2>/dev/null || echo 0)
    line=$(aws ec2 describe-volumes --region "$region" --query 'length(Volumes)' --output text 2>/dev/null || echo 0)
    [ "$n$v$line" = 000 ] || report yes "$region: $n instances, $v Elastic IPs, $line volumes"
  done
  echo "  (other regions: no instances, Elastic IPs or volumes)" >&2
  if [ "$bad" = 1 ]; then
    printf '\n\033[41;97m STILL BILLING: see the BILLS lines above \033[0m\n' >&2
    return 1
  fi
  printf '\n\033[42;30m Audit clean: CodeJudge bills only its expected storage (ECR releases + S3 backups, above) \033[0m\n' >&2
}

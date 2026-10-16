#!/usr/bin/env bash
# CodeJudge host bootstrap (Ubuntu 24.04). Idempotent: safe to run again; a
# second run changes nothing.
#
#   sudo deploy/host/bootstrap.sh [--no-aws] [--app-dir DIR]
#
#   --no-aws        skip the AWS CLI (CI, or a non-AWS host)
#   --app-dir DIR   also install the systemd units and tmpfiles from DIR/deploy
#                   (a release or a checkout). Deploys do this themselves.
#
# Installs: Docker Engine + compose plugin (pinned, from Docker's apt repo),
# gVisor runsc registered with Docker as runtime "runsc" WITH --oci-seccomp
# (the worker selects it: JUDGE_RUNTIME=runsc; Docker's default stays runc for
# the compose services), a 2 GiB swap file, the "codejudge" system user, the
# /opt/codejudge and /etc/codejudge layout, unattended security upgrades and
# the AWS CLI. No secrets: they are rendered from SSM at deploy time.
set -euo pipefail

DOCKER_VERSION="5:29.8.2-1~ubuntu.24.04~noble"            # 2026-09-30
CONTAINERD_VERSION="2.3.6-1~ubuntu.24.04~noble"           # 2026-09-25
COMPOSE_VERSION="5.5.1-1~ubuntu.24.04~noble"              # 2026-09-03
GVISOR_RELEASE="20260921.0"
GVISOR_SHA512="66a5b17354690ec2e4037b54080eeabde55a1503779ceb823d73856283a6836953e105493d7e38fb2dcf85e5c86e0f48c66a9abb0244a78bd612df938702475c"
AWSCLI_VERSION="2.37.7"                                   # 2026-09-30
AWSCLI_SHA256="7fccf7854f9f02ad81d6fc28e01098bdf48c72d1aa931eeb36784b8893e0ae14"
SWAP_FILE=/swapfile
SWAP_SIZE=2G

with_aws=1
app_dir=""
while [ $# -gt 0 ]; do
  case "$1" in
    --no-aws) with_aws=0 ;;
    --app-dir) app_dir="$2"; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
  shift
done

[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }
. /etc/os-release
[ "${VERSION_ID:-}" = "24.04" ] || { echo "Ubuntu 24.04 expected, found ${PRETTY_NAME:-unknown}" >&2; exit 1; }
log() { printf '%s bootstrap: %s\n' "$(date -u +%FT%TZ)" "$*"; }
export DEBIAN_FRONTEND=noninteractive
changed=0
note() { changed=1; log "$*"; }

# --- base packages -----------------------------------------------------------
need=()
for p in ca-certificates curl gnupg jq git unzip zstd unattended-upgrades; do
  dpkg-query -W -f='${Status}' "$p" 2>/dev/null | grep -q "install ok installed" || need+=("$p")
done
if [ ${#need[@]} -gt 0 ]; then
  apt-get update -qq
  apt-get install -y -qq "${need[@]}"
  note "installed ${need[*]}"
fi

# --- Docker Engine (pinned) --------------------------------------------------
keyring=/etc/apt/keyrings/docker.asc
if [ ! -s "$keyring" ]; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o "$keyring"
  chmod a+r "$keyring"
  note "added Docker's apt key"
fi
list=/etc/apt/sources.list.d/docker.list
want_list="deb [arch=$(dpkg --print-architecture) signed-by=$keyring] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable"
# Another source for the same repo (a different keyring path) makes apt fail.
for f in $(grep -l 'download.docker.com' /etc/apt/sources.list.d/* 2>/dev/null || true); do
  [ "$f" = "$list" ] || { rm -f "$f"; note "removed duplicate Docker source $f"; }
done
if [ "$(cat "$list" 2>/dev/null)" != "$want_list" ]; then
  echo "$want_list" >"$list"
  apt-get update -qq
  note "configured Docker's apt repository"
fi
installed() { dpkg-query -W -f='${Version}' "$1" 2>/dev/null || true; }
if [ "$(installed docker-ce)" != "$DOCKER_VERSION" ] || [ "$(installed docker-ce-cli)" != "$DOCKER_VERSION" ] ||
  [ "$(installed containerd.io)" != "$CONTAINERD_VERSION" ] || [ "$(installed docker-compose-plugin)" != "$COMPOSE_VERSION" ]; then
  apt-get install -y -qq --allow-downgrades \
    "docker-ce=$DOCKER_VERSION" "docker-ce-cli=$DOCKER_VERSION" \
    "containerd.io=$CONTAINERD_VERSION" "docker-compose-plugin=$COMPOSE_VERSION"
  apt-mark hold docker-ce docker-ce-cli containerd.io docker-compose-plugin >/dev/null
  note "installed Docker $DOCKER_VERSION (held)"
fi
systemctl enable --now docker >/dev/null 2>&1

# --- gVisor runsc, registered with --oci-seccomp -------------------------------
if [ "$(runsc --version 2>/dev/null | head -1)" != "runsc version release-${GVISOR_RELEASE}" ]; then
  tmp=$(mktemp -d)
  curl -fsSL -o "$tmp/gvisor.tar.zstd" "https://storage.googleapis.com/gvisor/releases/release/${GVISOR_RELEASE}/x86_64/gvisor.tar.zstd"
  echo "${GVISOR_SHA512}  $tmp/gvisor.tar.zstd" | sha512sum -c --quiet
  mkdir "$tmp/x" && tar --zstd -xf "$tmp/gvisor.tar.zstd" -C "$tmp/x"
  install -m 0755 "$(find "$tmp/x" -type f -name runsc | head -1)" /usr/local/bin/runsc
  shim=$(find "$tmp/x" -type f -name containerd-shim-runsc-v1 | head -1)
  [ -n "$shim" ] && install -m 0755 "$shim" /usr/local/bin/containerd-shim-runsc-v1
  rm -rf "$tmp"
  note "installed gVisor $GVISOR_RELEASE"
fi
daemon=/etc/docker/daemon.json
if ! jq -e '.runtimes.runsc.runtimeArgs | index("--oci-seccomp")' "$daemon" >/dev/null 2>&1; then
  # Without --oci-seccomp gVisor ignores the container's seccomp profile.
  runsc install -- --oci-seccomp
  systemctl restart docker
  note "registered runsc with --oci-seccomp"
fi
if ! jq -e '."log-opts"."max-size"' "$daemon" >/dev/null 2>&1; then
  tmpd=$(mktemp)
  jq '. + {"log-driver": "json-file", "log-opts": {"max-size": "10m", "max-file": "3"}}' "$daemon" >"$tmpd"
  install -m 0644 "$tmpd" "$daemon" && rm -f "$tmpd"
  systemctl restart docker
  note "capped container logs"
fi

# --- swap ----------------------------------------------------------------------
if [ ! -f "$SWAP_FILE" ]; then
  fallocate -l "$SWAP_SIZE" "$SWAP_FILE"
  chmod 0600 "$SWAP_FILE"
  mkswap "$SWAP_FILE" >/dev/null
  note "created $SWAP_SIZE swap file"
fi
if ! swapon --show=NAME --noheadings | grep -qx "$SWAP_FILE"; then
  swapon "$SWAP_FILE"
  note "enabled swap"
fi
grep -q "^$SWAP_FILE " /etc/fstab || { echo "$SWAP_FILE none swap sw 0 0" >>/etc/fstab; note "swap in fstab"; }
sysctl_conf=/etc/sysctl.d/90-codejudge.conf
want_sysctl=$'# Prefer RAM; swap only absorbs spikes.\nvm.swappiness=10'
if [ "$(cat "$sysctl_conf" 2>/dev/null)" != "$want_sysctl" ]; then
  echo "$want_sysctl" >"$sysctl_conf"
  sysctl -q -p "$sysctl_conf"
  note "set vm.swappiness"
fi

# --- user and layout -----------------------------------------------------------
if ! id codejudge >/dev/null 2>&1; then
  useradd --system --home-dir /opt/codejudge --shell /usr/sbin/nologin codejudge
  note "created user codejudge"
fi
id -nG codejudge | tr ' ' '\n' | grep -qx docker || { usermod -aG docker codejudge; note "codejudge joins docker"; }
install -d -m 0755 -o root -g root /opt/codejudge /opt/codejudge/releases /opt/codejudge/state
install -d -m 0750 -o root -g codejudge /etc/codejudge

# --- unattended security upgrades ------------------------------------------------
auto=/etc/apt/apt.conf.d/20auto-upgrades
want_auto=$'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";'
if [ "$(cat "$auto" 2>/dev/null)" != "$want_auto" ]; then
  echo "$want_auto" >"$auto"
  note "enabled unattended upgrades"
fi

# --- AWS CLI v2 (pinned, checksum) ------------------------------------------------
if [ "$with_aws" = 1 ] && [ "$(aws --version 2>/dev/null | cut -d' ' -f1)" != "aws-cli/${AWSCLI_VERSION}" ]; then
  tmp=$(mktemp -d)
  curl -fsSL -o "$tmp/awscli.zip" "https://awscli.amazonaws.com/awscli-exe-linux-x86_64-${AWSCLI_VERSION}.zip"
  echo "${AWSCLI_SHA256}  $tmp/awscli.zip" | sha256sum -c --quiet
  unzip -q "$tmp/awscli.zip" -d "$tmp"
  "$tmp/aws/install" --update >/dev/null
  rm -rf "$tmp"
  note "installed AWS CLI $AWSCLI_VERSION"
fi

# --- systemd units (from a release or checkout) -------------------------------------
if [ -n "$app_dir" ]; then
  "$app_dir/deploy/host/install-units.sh" "$app_dir"
fi

if [ "$changed" = 0 ]; then log "already up to date"; else log "done"; fi

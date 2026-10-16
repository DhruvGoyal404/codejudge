#!/usr/bin/env bash
# CI: runs deploy/host/bootstrap.sh (without the AWS CLI) on an Ubuntu 24.04
# runner twice and checks what it promises: the second run changes nothing,
# runsc is registered with --oci-seccomp, swap, the codejudge user, the
# layout and the units.
#
#   scripts/ci-bootstrap-check.sh
set -euo pipefail
cd "$(dirname "$0")/.."
fail() { echo "FAIL: $*" >&2; exit 1; }

# (The runner image ships Docker already; bootstrap pins and holds its own.)
echo "=== first run"
sudo deploy/host/bootstrap.sh --no-aws --app-dir "$PWD"
echo "=== second run (must change nothing)"
out=$(sudo deploy/host/bootstrap.sh --no-aws --app-dir "$PWD" 2>&1)
echo "$out"
grep -q 'bootstrap: already up to date$' <<<"$out" || fail "second run changed something"
grep -q 'install-units: updated' <<<"$out" && fail "second run rewrote units"

echo "=== checks"
sudo jq -e '.runtimes.runsc.runtimeArgs | index("--oci-seccomp")' /etc/docker/daemon.json >/dev/null || fail "runsc lacks --oci-seccomp"
docker info --format '{{json .Runtimes}}' | jq -e 'has("runsc")' >/dev/null || fail "Docker does not list runsc"
# gVisor's synthetic kernel log names it (klogctl needs CAP_SYSLOG). Output
# captured first: with pipefail, grep -q exiting early would SIGPIPE docker.
kmsg=$(docker run --rm --runtime=runsc --cap-add SYSLOG busybox:1.37.0@sha256:bdf57e528e45e4433820e045b29b4597825a1c9e38353532d90a01445013f82e dmesg)
grep -qi gvisor <<<"$kmsg" || { echo "$kmsg"; fail "runsc container is not gVisor"; }
swapon --show=NAME --noheadings | grep -qx /swapfile || fail "no /swapfile swap"
[ "$(sysctl -n vm.swappiness)" = 10 ] || fail "vm.swappiness"
id -nG codejudge | tr ' ' '\n' | grep -qx docker || fail "codejudge is not in the docker group"
[ "$(stat -c '%a %U:%G' /etc/codejudge)" = "750 root:codejudge" ] || fail "/etc/codejudge permissions"
systemctl is-enabled --quiet judge-worker || fail "judge-worker not enabled"
systemctl is-enabled --quiet pg-backup.timer || fail "pg-backup.timer not enabled"
[ -d /run/codejudge/postgresql ] || fail "tmpfiles not applied"
for p in docker-ce docker-ce-cli containerd.io docker-compose-plugin; do
  apt-mark showhold | grep -qx "$p" || fail "$p is not held"
done
docker version --format 'engine {{.Server.Version}}'
runsc --version | head -1
echo "bootstrap checks passed"

#!/usr/bin/env bash
# TEMPORARY (one CI iteration, 6a.7): is there a runsc/gVisor-level way to
# stop clone3(CLONE_NEWUSER / CLONE_NEWNS)? Flags, sysctls, annotations.
set -uo pipefail
echo "===== runsc flags mentioning user/namespace/sysctl/clone/caps"
runsc flags 2>&1 | grep -i -E -B1 -A2 'user|namespace|sysctl|clone|unshare|caps?\b|nonroot|rootless' | head -120
id=$(jq -r '."cpp-compile"' sandbox/images/images.lock.json)
mkdir -p /tmp/ns && cp .github/diag/clone3.cpp /tmp/ns/ && chmod 777 /tmp/ns
docker run --rm --network none -v /tmp/ns:/p --entrypoint sh "$id" -c 'g++ -O1 -static -o /p/clone3 /p/clone3.cpp && echo built'
# The runsc profile variant: clone3 allowed (as the sandbox builds it).
jq '(.syscalls[] | select(.action=="SCMP_ACT_ERRNO") | .names) |= map(select(. != "clone3"))
    | .syscalls |= map(select((.names|length) > 0))
    | .syscalls += [{"names":["clone3"],"action":"SCMP_ACT_ALLOW"}]' sandbox/seccomp/default.json >/tmp/variant.json
common=(--rm --runtime runsc --network none --security-opt seccomp=/tmp/variant.json --security-opt no-new-privileges --cap-drop ALL --user 1000000000:1000000000 -v /tmp/ns:/p:ro --entrypoint /p/clone3)
try() { echo "===== $1"; shift; docker run "${common[@]:0:2}" "$@" "${common[@]:2}" "$id" 2>&1 | tail -5; }
try "baseline"
try "--sysctl user.max_user_namespaces=0" --sysctl user.max_user_namespaces=0
try "--sysctl kernel.unprivileged_userns_clone=0" --sysctl kernel.unprivileged_userns_clone=0
try "--sysctl user.max_mnt_namespaces=0" --sysctl user.max_mnt_namespaces=0
try "annotation dev.gvisor.flag.unprivileged-userns=false" --annotation dev.gvisor.flag.unprivileged-userns=false
echo "===== /proc/sys/user inside runsc"
docker run --rm --runtime runsc --network none --entrypoint sh "$id" -c 'ls /proc/sys/user 2>&1; cat /proc/sys/user/max_user_namespaces 2>&1' | head

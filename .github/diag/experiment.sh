#!/usr/bin/env bash
# TEMPORARY (runsc-diag): run the probes and a g++ compile under runc and runsc
# with the repo profile and with a COPY whose defaultErrnoRet is 38 (ENOSYS).
# The repo profile is not changed.
set -uo pipefail
id=$(jq -r '."cpp-compile"' sandbox/images/images.lock.json)
jq '.defaultErrnoRet = 38' sandbox/seccomp/default.json >/tmp/enosys.json
mkdir -p /tmp/probe && cp .github/diag/*.c /tmp/probe/ && chmod 777 /tmp/probe
docker run --rm --network none -v /tmp/probe:/p --entrypoint sh "$id" -c \
  'gcc -O1 -static -o /p/spawnprobe /p/spawnprobe.c && gcc -O1 -static -o /p/denied /p/denied.c && echo built'
printf '#include <cstdio>\nint main(){std::puts("hi");}\n' >/tmp/hi.cpp
common=(--rm --network none --security-opt no-new-privileges --cap-drop ALL --user 65534)
for rt in runc runsc; do
  for prof in "$PWD/sandbox/seccomp/default.json" /tmp/enosys.json; do
    echo "===== $rt, profile $(basename "$prof")"
    docker run "${common[@]}" --runtime "$rt" --security-opt "seccomp=$prof" -v /tmp/probe:/p:ro \
      --entrypoint sh "$id" -c '/p/spawnprobe; /p/denied' 2>&1
    docker run "${common[@]}" --runtime "$rt" --security-opt "seccomp=$prof" --tmpfs /tmp:exec -v /tmp/hi.cpp:/src/hi.cpp:ro \
      --entrypoint sh "$id" -c 'cd /tmp && g++ -O2 -o hi /src/hi.cpp && ./hi; echo "g++ exit=$?"' 2>&1 | tail -3
  done
done

#!/usr/bin/env bash
# Time-limit calibration on the production host. deploy.sh starts it in a
# transient systemd unit (codejudge-calibrate) when a deploy's manifest says
# "calibrate": "start" (Deploy workflow, run by hand with "calibrate" ticked).
# It changes nothing: it judges every problem's private reference (ref.*) and
# slow (slow*.*) solutions with judge-run in the production sandbox (runsc,
# the release's images and seccomp profile), CALIBRATE_RUNS passes over the
# whole catalogue, then measures submit-to-verdict latency through the real
# queue and worker with judge-admin smoke. The next deploy prints the summary.
#
#   calibrate.sh RELEASE_DIR PROBLEMS_DIR OUT_DIR
#
# Env: CALIBRATE_RUNS (3), CALIBRATE_PROBLEMS (comma-separated slugs; default
# all), CALIBRATE_LATENCY_N (20 submissions per problem; 0 skips),
# CALIBRATE_LARGE (the large problem for latency; default: the one with the
# most test data).
set -euo pipefail

rel=$(readlink -f "${1:?usage: calibrate.sh RELEASE_DIR PROBLEMS_DIR OUT_DIR}")
private=${2:?}
out=${3:?}
runs=${CALIBRATE_RUNS:-3}
latency_n=${CALIBRATE_LATENCY_N:-20}
mkdir -p "$out"
results=$out/results.jsonl
: >"$results"
log() { echo "$(date -u +%FT%TZ) $*" | tee -a "$out/log.txt"; }

set -a && . /etc/codejudge/worker.env && set +a
export CODEJUDGE_PROBLEMS_TESTS_DIR=$private JUDGE_RUNTIME=runsc

if [ -n "${CALIBRATE_PROBLEMS:-}" ]; then
  IFS=, read -r -a slugs <<<"$CALIBRATE_PROBLEMS"
else
  mapfile -t slugs < <(find "$rel/app/problems" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort)
fi
lang_of() {
  case $1 in
    *.c) echo c ;; *.cpp) echo cpp ;; *.go) echo go ;; *.py) echo python ;; *.java) echo java ;; *.js) echo javascript ;;
    *) return 1 ;;
  esac
}

log "calibrating ${#slugs[@]} problems, $runs runs, release $(basename "$rel"), problems $(git -C "$private" rev-parse --short HEAD)"
for run in $(seq "$runs"); do
  for slug in "${slugs[@]}"; do
    for src in "$private/$slug/solutions"/ref.* "$private/$slug/solutions"/slow*.*; do
      [ -f "$src" ] || continue
      l=$(lang_of "$src") || continue
      file=$(basename "$src")
      if res=$("$rel/bin/judge-run" judge --problem "$rel/app/problems/$slug" --lang "$l" --src "$src" \
        --images "$rel/app/sandbox/images/images.lock.json" --seccomp "$rel/app/sandbox/seccomp/default.json" 2>>"$out/stderr.txt"); then
        jq -c --arg s "$slug" --arg f "$file" --argjson r "$run" \
          '{slug: $s, file: $f, lang, run: $r, verdict, max_cpu_ms, limit_ms: .time_limit_ms, tests_run, tests_total, total_ms}' <<<"$res" >>"$results"
      else
        jq -cn --arg s "$slug" --arg f "$file" --arg l "$l" --argjson r "$run" '{slug: $s, file: $f, lang: $l, run: $r, verdict: "ERROR"}' >>"$results"
      fi
    done
  done
  log "run $run done: $(wc -l <"$results") judgements"
done

# Submit-to-verdict latency (finished_at - created_at in Postgres) through the
# real queue and worker, for a small and a large problem, C++ references.
: >"$out/latency.tsv"
if [ "$latency_n" -gt 0 ]; then
  large=${CALIBRATE_LARGE:-$(for s in "${slugs[@]}"; do echo "$(du -sk "$private/$s/tests" | cut -f1) $s"; done | sort -rn | head -1 | cut -d' ' -f2)}
  for slug in $(printf '%s\n' ledger-total "$large" | awk '!seen[$0]++'); do
    for _ in $(seq "$latency_n"); do
      ms=$("$rel/bin/judge-admin" smoke --problem "$slug" --lang cpp --timeout 5m --src "$private/$slug/solutions/ref.cpp" |
        sed -n 's/.*submit to verdict \([0-9]*\) ms.*/\1/p')
      printf '%s\t%s\n' "$slug" "${ms:-NA}" >>"$out/latency.tsv"
    done
  done
  log "latency done"
fi

# Summary: per solution, the worst max CPU over all runs against its effective
# limit, and every verdict seen; then latency percentiles (nearest rank).
{
  printf 'slug\tfile\tlimit_ms\tworst_cpu_ms\tpct\tverdicts\n'
  jq -rs 'group_by([.slug, .file])[] |
    (map(.max_cpu_ms // 0) | max) as $cpu | (.[0].limit_ms // 0) as $lim |
    [.[0].slug, .[0].file, $lim, $cpu, (if $lim > 0 then ($cpu * 100 / $lim | floor) else "NA" end),
     (map(.verdict) | join(","))] | @tsv' "$results"
  printf 'latency\tproblem\tn\tp50_ms\tp95_ms\tmax_ms\n'
  for slug in $(cut -f1 "$out/latency.tsv" | sort -u); do
    awk -F'\t' -v s="$slug" '$1 == s && $2 != "NA" {print $2}' "$out/latency.tsv" | sort -n | awk -v s="$slug" '
      {v[NR] = $1} END {
        if (NR == 0) { printf "latency\t%s\t0\tNA\tNA\tNA\n", s; exit }
        p50 = int(0.50 * NR); if (p50 < 0.50 * NR) p50++
        p95 = int(0.95 * NR); if (p95 < 0.95 * NR) p95++
        printf "latency\t%s\t%d\t%d\t%d\t%d\n", s, NR, v[p50], v[p95], v[NR] }'
  done
} >"$out/summary.tsv"
log "done"

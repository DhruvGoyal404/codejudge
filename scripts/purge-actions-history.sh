#!/usr/bin/env bash
# One-off, right before making the repository public: deletes EVERY GitHub
# Actions workflow run (with its logs), every artifact and every cache, so
# nothing recorded while the repository was private becomes public. This
# includes the runs of workflows that no longer exist. Irreversible.
#
#   scripts/purge-actions-history.sh DhruvGoyal404/codejudge
#
# Needs gh, logged in with admin rights on the repository. Run it when no
# workflow is running, and don't push until it has finished: a push starts
# new runs, and those are not deleted.
set -euo pipefail

repo=${1:?usage: purge-actions-history.sh OWNER/REPO}
[ "$(gh api "repos/$repo" --jq .permissions.admin)" = true ] || { echo "need admin rights on $repo" >&2; exit 1; }

active=$(gh api --paginate "repos/$repo/actions/runs?status=in_progress" --jq '.workflow_runs[].id'
  gh api --paginate "repos/$repo/actions/runs?status=queued" --jq '.workflow_runs[].id')
[ -z "$active" ] || { echo "runs still active ($(echo "$active" | wc -l)); wait or cancel them first" >&2; exit 1; }

runs=$(gh api --paginate "repos/$repo/actions/runs?per_page=100" --jq '.workflow_runs[].id')
artifacts=$(gh api --paginate "repos/$repo/actions/artifacts?per_page=100" --jq '.artifacts[].id')
caches=$(gh api --paginate "repos/$repo/actions/caches?per_page=100" --jq '.actions_caches[].id')
echo "$repo: $(wc -w <<<"$runs") runs, $(wc -w <<<"$artifacts") artifacts, $(wc -w <<<"$caches") caches will be DELETED."
read -r -p "Type the repository name to confirm: " answer
[ "$answer" = "$repo" ] || { echo "aborted" >&2; exit 1; }

# Artifacts first (deleting a run deletes its artifacts too; this also covers
# any artifact whose run is already gone).
for id in $artifacts; do gh api -X DELETE "repos/$repo/actions/artifacts/$id" --silent && echo "artifact $id deleted"; done
for id in $runs; do gh api -X DELETE "repos/$repo/actions/runs/$id" --silent && echo "run $id deleted"; done
for id in $caches; do gh api -X DELETE "repos/$repo/actions/caches/$id" --silent && echo "cache $id deleted"; done

left_runs=$(gh api "repos/$repo/actions/runs" --jq .total_count)
left_artifacts=$(gh api "repos/$repo/actions/artifacts" --jq .total_count)
left_caches=$(gh api "repos/$repo/actions/caches" --jq .total_count)
echo "left: $left_runs runs, $left_artifacts artifacts, $left_caches caches"
[ "$left_runs$left_artifacts$left_caches" = 000 ] || { echo "something is left: run the script again" >&2; exit 1; }
echo "done"

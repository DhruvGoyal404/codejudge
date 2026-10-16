#!/usr/bin/env bash
# Installs CodeJudge's systemd units and tmpfiles from a release (or checkout)
# directory. Idempotent: units are only rewritten, and systemd reloaded, when
# their content changed. Called by bootstrap.sh --app-dir and by deploy.sh.
#
#   install-units.sh APP_DIR
set -euo pipefail
app=${1:?usage: install-units.sh APP_DIR}
src="$app/deploy/systemd"
reload=0
put() { # put SRC DEST
  if ! cmp -s "$1" "$2"; then
    install -m 0644 "$1" "$2"
    reload=1
    echo "install-units: updated $2"
  fi
}
put "$src/judge-worker.service" /etc/systemd/system/judge-worker.service
put "$src/pg-backup.service" /etc/systemd/system/pg-backup.service
put "$src/pg-backup.timer" /etc/systemd/system/pg-backup.timer
put "$src/codejudge.tmpfiles.conf" /etc/tmpfiles.d/codejudge.conf
systemd-tmpfiles --create /etc/tmpfiles.d/codejudge.conf
if [ "$reload" = 1 ]; then
  systemctl daemon-reload
fi
systemctl enable judge-worker.service pg-backup.timer >/dev/null 2>&1

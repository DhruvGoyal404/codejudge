#!/usr/bin/env bash
# Installs CodeJudge's systemd units and tmpfiles from a release (or checkout)
# directory, and starts every timer. Idempotent: units are only rewritten when
# their content changed. Called by bootstrap.sh --app-dir and by deploy.sh.
# Any failure fails the caller (a deploy then rolls back).
#
# Timers are enabled AND started (--now): "enable" alone only starts a timer at
# the next boot, and the production host never rebooted, so pg-backup.timer
# sat enabled but inactive and no backup ever ran (MAINTENANCE.md, incident).
# judge-worker is only enabled here; deploy.sh restarts it after migrations.
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
  echo "install-units: systemd units changed; reloading"
fi
systemctl daemon-reload
systemctl enable judge-worker.service
for timer in "$src"/*.timer; do
  name=$(basename "$timer")
  systemctl enable --now "$name"
  systemctl is-active --quiet "$name" || {
    echo "install-units: $name is not active after enable --now" >&2
    exit 1
  }
done

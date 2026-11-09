#!/usr/bin/env bash
# P2 ops hardening for the Otto steward on this box (run as root, idempotent).
#
#   ./deploy/remote.sh --copy deploy/harden.sh /tmp/
#   ./deploy/remote.sh 'bash /tmp/harden.sh'
#
# What it does, and why each piece is here:
#   - journald limits: the steward is chatty during runs and this disk is 40 GB shared with
#     everything else. Capping the journal keeps a runaway log from filling /.
#   - restart policy: `Restart=always` with systemd's default limits gives up after 5 starts in
#     10 s, so one transient failure can leave the service down until someone looks. A wider
#     window survives flakiness and still stops a hot loop.
#   - memory ceiling: the box has 1.7 GB. Without a ceiling a Node heap blow takes the whole
#     machine (nginx included); with one, only the steward dies and `Restart=always` brings it
#     back — safe here, because the actual workers run on the owner's laptop, not on the VPS.
#   - daily SQLite backup: `sqlite3 .backup` (a consistent copy while WAL is live), 14 kept.
#     Off-box copy needs an rclone remote (RCLONE_REMOTE in deploy/aliyun.env); unset, this
#     only protects against bad upgrades and accidental deletes, not against losing the disk.
set -euo pipefail

unit_dir=/etc/systemd/system
backup_dir=/var/lib/otto/backups

install -d -o otto -g otto -m 0750 "$backup_dir"
install -d /etc/systemd/journald.conf.d
install -d "$unit_dir/otto.service.d"

cat > "$unit_dir/otto.service.d/limits.conf" <<'CONF'
[Unit]
# systemd's defaults (5 starts / 10 s) turn one transient failure into a service that stays
# down. Ten starts across five minutes still catches a hot crash loop.
StartLimitIntervalSec=300
StartLimitBurst=10

[Service]
RestartSec=3
# Soft limit throttles and lets the process recover; the hard limit only kills the steward,
# never nginx or sshd, and Restart=always brings it straight back.
MemoryHigh=800M
MemoryMax=1200M
CONF

cat > /etc/systemd/journald.conf.d/otto.conf <<'CONF'
[Journal]
SystemMaxUse=200M
RuntimeMaxUse=64M
CONF

cat > "$unit_dir/otto-backup.service" <<CONF
[Unit]
Description=Otto steward SQLite backup
After=local-fs.target

[Service]
Type=oneshot
User=otto
Group=otto
# .backup is SQLite's online copy: consistent with a live WAL writer, no locks held for long.
ExecStart=/bin/sh -c '/usr/bin/sqlite3 /var/lib/otto/steward.sqlite ".backup /var/lib/otto/backups/steward-\$(date -u +%%Y%%m%%dT%%H%%M%%S).sqlite" && ls -1t /var/lib/otto/backups/steward-*.sqlite | tail -n +15 | xargs -r rm --'
CONF

cat > "$unit_dir/otto-backup.timer" <<'CONF'
[Unit]
Description=Daily Otto steward backup

[Timer]
OnCalendar=*-*-* 03:20:00 UTC
RandomizedDelaySec=300
Persistent=true

[Install]
WantedBy=timers.target
CONF

systemctl daemon-reload
systemctl enable --now otto-backup.timer >/dev/null
systemctl restart systemd-journald
# The limits only apply to a unit that is (re)started.
systemctl restart otto
sleep 3

echo "== otto =="
systemctl is-active otto
systemctl show otto -p RestartSec -p MemoryHigh -p MemoryMax -p StartLimitBurst -p StartLimitIntervalUSec
echo "== journald =="
journalctl --disk-usage
echo "== backup timer =="
systemctl list-timers otto-backup.timer --no-pager | sed -n 2p
systemctl start otto-backup.service
sleep 2
systemctl is-failed otto-backup.service >/dev/null && echo "backup FAILED" || echo "backup ok"
ls -lh "$backup_dir" | tail -3
echo "== unattended-upgrades =="
systemctl is-enabled unattended-upgrades

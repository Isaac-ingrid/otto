#!/usr/bin/env bash
# Install the opt-in offsite copy + isolated verification jobs after the operator has configured
# /etc/otto/offsite.env and a root-owned rclone crypt remote. Does not create credentials.
set -euo pipefail

[[ "$(id -u)" -eq 0 ]] || { echo 'run as root' >&2; exit 1; }
for tool in rclone sqlite3 sha256sum; do command -v "$tool" >/dev/null || { echo "$tool is required" >&2; exit 1; }; done
systemctl cat otto-backup.service >/dev/null || { echo 'install the local backup with deploy/harden.sh first' >&2; exit 1; }
[[ -f /etc/otto/offsite.env && ! -L /etc/otto/offsite.env ]] || { echo '/etc/otto/offsite.env is missing' >&2; exit 1; }
[[ "$(stat -c '%u' /etc/otto/offsite.env)" == 0 ]] || { echo 'offsite.env must belong to root' >&2; exit 1; }
mode="$(stat -c '%a' /etc/otto/offsite.env)"
(( (8#$mode & 077) == 0 )) || { echo 'offsite.env must not be accessible by group or others' >&2; exit 1; }

script_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
install -d -m 0755 /usr/local/libexec
install -o root -g root -m 0700 "$script_dir/offsite-backup.sh" /usr/local/libexec/otto-offsite-backup
install -d /etc/systemd/system/otto-backup.service.d
cat > /etc/systemd/system/otto-backup.service.d/offsite.conf <<'CONF'
[Unit]
# Only trigger after the local SQLite online backup finished successfully.
OnSuccess=otto-offsite-backup.service
CONF
cat > /etc/systemd/system/otto-offsite-backup.service <<'CONF'
[Unit]
Description=Copy Otto SQLite and recovery secrets to encrypted offsite storage
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
EnvironmentFile=/etc/otto/offsite.env
ExecStart=/usr/local/libexec/otto-offsite-backup upload
UMask=0077
PrivateTmp=yes
ProtectHome=yes
ProtectSystem=strict
NoNewPrivileges=yes
CONF
cat > /etc/systemd/system/otto-offsite-verify.service <<'CONF'
[Unit]
Description=Verify latest encrypted offsite Otto restore in isolation
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
EnvironmentFile=/etc/otto/offsite.env
ExecStart=/usr/local/libexec/otto-offsite-backup verify
UMask=0077
PrivateTmp=yes
ProtectHome=yes
ProtectSystem=strict
NoNewPrivileges=yes
CONF
cat > /etc/systemd/system/otto-offsite-verify.timer <<'CONF'
[Unit]
Description=Weekly verification of encrypted Otto offsite backup

[Timer]
OnCalendar=Sun *-*-* 05:00:00 UTC
RandomizedDelaySec=300
Persistent=true

[Install]
WantedBy=timers.target
CONF
systemctl daemon-reload
systemctl enable --now otto-offsite-verify.timer
printf '%s\n' 'Installed offsite jobs. Run systemctl start otto-backup.service, then' \
  'systemctl start otto-offsite-verify.service and inspect both units with journalctl.'

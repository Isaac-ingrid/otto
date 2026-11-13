#!/usr/bin/env bash
# Install on the Node server as root, with these three deploy files alongside each other.
set -euo pipefail
[[ $(id -u) == 0 ]] || { echo 'run as root' >&2; exit 1; }
script_dir="$(cd "$(dirname "$0")" && pwd)"
node_bin="$(command -v node)"
[[ "$node_bin" == /* ]] || exit 1
install -d -m 0700 /var/lib/otto-health
install -d -m 0755 /opt/otto
install -m 0700 "$script_dir/doctor.sh" /opt/otto/doctor.sh
install -m 0700 "$script_dir/health-monitor.mjs" /opt/otto/health-monitor.mjs
cat > /etc/systemd/system/otto-health.service <<CONF
[Unit]
Description=Otto read-only health check and durable notice delivery
After=network.target

[Service]
Type=oneshot
User=root
UMask=0077
ExecStart=$node_bin /opt/otto/health-monitor.mjs
TimeoutStartSec=180
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/otto-health
CONF
cat > /etc/systemd/system/otto-health.timer <<'CONF'
[Unit]
Description=Check Otto health every 15 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=15min
AccuracySec=30s
Unit=otto-health.service

[Install]
WantedBy=timers.target
CONF
systemctl daemon-reload
systemctl enable --now otto-health.timer
systemctl start otto-health.service
systemctl list-timers otto-health.timer --no-pager

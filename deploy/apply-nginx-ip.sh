#!/usr/bin/env bash
# Apply the IP TLS vhost on the current Otto ECS. Run on the server as root, after copying
# nginx-otto-ip.conf to /tmp/otto-nginx/. Keep the validation here rather than passing a long
# shell expression through PowerShell, Git Bash and ssh (which can change its quoting).
set -euo pipefail

ip=115.29.164.8
source=/tmp/otto-nginx/nginx-otto-ip.conf
active=/etc/nginx/sites-available/otto
backup=/etc/nginx/sites-available/otto.pre-hardening
rendered="$(mktemp /tmp/otto-nginx/otto-rendered.XXXXXX)"
normal_body="$(mktemp /tmp/otto-nginx/otto-normal.XXXXXX)"
spoof_body="$(mktemp /tmp/otto-nginx/otto-spoof.XXXXXX)"

cleanup() {
  status=$?
  trap - EXIT
  rm -f "$rendered" "$normal_body" "$spoof_body"
  if [ "$status" -ne 0 ]; then
    cp -p "$backup" "$active"
    if nginx -t && systemctl reload nginx; then
      echo 'NGINX_ROLLED_BACK' >&2
    else
      echo 'NGINX_ROLLBACK_FAILED: inspect the server immediately' >&2
    fi
  fi
  exit "$status"
}

# Refuse to touch a different vhost or a missing staged template.
test -f "$source"
test "$(readlink -f /etc/nginx/sites-enabled/otto)" = "$active"
cp -p "$active" "$backup"
trap cleanup EXIT

sed "s/__OTTO_IP__/$ip/g" "$source" > "$rendered"
if grep -q '__OTTO_IP__' "$rendered" ||
   ! grep -Fq 'if ($http_host != 115.29.164.8) { return 421; }' "$rendered"; then
  echo 'Missing rendered raw Host guard' >&2
  exit 1
fi
install -m 644 "$rendered" "$active"
nginx -t
systemctl reload nginx
# `systemctl reload` returns after signalling the master, not after replacement workers
# start accepting. An immediate curl can hit an old worker and falsely trigger rollback.
sleep 3

# Loopback HTTPS probes: --noproxy ensures they actually hit this box. -k is only for the
# localhost/certificate mismatch; browsers must validate the public IP certificate normally.
# The diagnostic found this box has only one :443 vhost, so an unknown Host must return 421.
normal="$(curl --noproxy '*' -ksS --max-time 5 -o "$normal_body" -w '%{http_code}' -H "Host: $ip" https://127.0.0.1/)"
spoof="$(curl --noproxy '*' -ksS --max-time 5 -o "$spoof_body" -w '%{http_code}' -H 'Host: attacker.example' https://127.0.0.1/)"
if [ "$normal" != 200 ] || ! grep -Fq 'id="password-form"' "$normal_body"; then
  echo "IP Host did not reach Otto's login page (status $normal)" >&2
  exit 1
fi
if [ "$spoof" != 421 ] || grep -Fq 'id="password-form"' "$spoof_body"; then
  echo "Unknown Host unexpectedly reached Otto or returned an unexpected status ($spoof)" >&2
  exit 1
fi
echo 'NGINX_OK'

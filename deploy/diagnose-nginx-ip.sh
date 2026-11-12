#!/usr/bin/env bash
# Read-only diagnosis for the IP nginx vhost. Run on the server as root.
set -euo pipefail

active=/etc/nginx/sites-available/otto
backup=/etc/nginx/sites-available/otto.pre-hardening
if cmp -s "$active" "$backup" && systemctl is-active --quiet nginx && systemctl is-active --quiet otto; then
  echo 'ROLLBACK_OK'
else
  echo 'ROLLBACK_NOT_CONFIRMED' >&2
  exit 1
fi

echo 'TLS listeners and server names (no secrets):'
nginx -T 2>/dev/null | grep -E '^[[:space:]]*(listen[[:space:]]+.*443|server_name[[:space:]])' | head -60 || true

probe() {
  label="$1"
  host="$2"
  address="$3"
  body="$(mktemp)"
  # Bypass HTTPS_PROXY/ALL_PROXY: test the nginx on THIS box, not an egress proxy.
  status="$(curl --noproxy '*' -ksS --max-time 5 -o "$body" -w '%{http_code}' -H "Host: $host" "$address")"
  if grep -Fq 'id="password-form"' "$body"; then
    page=otto-login
  else
    page=other
  fi
  rm -f "$body"
  printf '%s status=%s page=%s\n' "$label" "$status" "$page"
}

probe loopback_ip 115.29.164.8 https://127.0.0.1/
probe loopback_spoof attacker.example https://127.0.0.1/
probe public_ip 115.29.164.8 https://115.29.164.8/
probe public_spoof attacker.example https://115.29.164.8/

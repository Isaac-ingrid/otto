#!/usr/bin/env bash
# Put the steward behind nginx with a real certificate.
#
#   deploy/enable-tls.sh --stage   # vhost on :80 now (no cert, no redirect) — safe before 备案
#   deploy/enable-tls.sh --live    # + certbot, 443, and the http→https redirect
#   ... --domain name              # use a name other than OTTO_DOMAIN (for a rehearsal)
#
# Requires OTTO_DOMAIN (and, for --live, OTTO_EMAIL — optional but Let's Encrypt likes it) in
# deploy/aliyun.env. The steward keeps listening on 127.0.0.1:8787; only nginx is exposed.
set -euo pipefail

cd "$(dirname "$0")/.."
set -a
# shellcheck disable=SC1091
. ./deploy/aliyun.env
set +a

mode="${1:---stage}"
case "$mode" in
  --stage|--live) ;;
  *) echo "usage: enable-tls.sh [--stage|--live] [--domain name]" >&2; exit 2 ;;
esac
# --domain overrides the file, for rehearsing against a throwaway name.
if [ "${2:-}" = "--domain" ] && [ -n "${3:-}" ]; then OTTO_DOMAIN="$3"; fi
: "${OTTO_DOMAIN:?set OTTO_DOMAIN in deploy/aliyun.env}"
: "${OTTO_SSH_HOST:?set OTTO_SSH_HOST in deploy/aliyun.env}"

# The rendered vhost is not a secret; it is pushed through the same tar pipe as everything else.
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
sed "s/__OTTO_DOMAIN__/${OTTO_DOMAIN}/g" deploy/nginx-otto.conf > "$tmp/otto.conf"

./deploy/remote.sh "mkdir -p /tmp/otto-nginx" >/dev/null
./deploy/remote.sh --copy "$tmp/otto.conf" /tmp/otto-nginx >/dev/null

./deploy/remote.sh "OTTO_DOMAIN='${OTTO_DOMAIN}' OTTO_HOST='${OTTO_SSH_HOST}' OTTO_EMAIL='${OTTO_EMAIL:-}' OTTO_MODE='${mode}' bash -s" <<'REMOTE'
set -euo pipefail

echo "== dns"
resolved="$(getent ahostsv4 "$OTTO_DOMAIN" | awk 'NR==1{print $1}' || true)"
if [ "$resolved" != "$OTTO_HOST" ]; then
  echo "   $OTTO_DOMAIN -> ${resolved:-<nothing>} (expected $OTTO_HOST)" >&2
  echo "   A record must point here first; ICP 备案 is also required for 80/443 in 大陆." >&2
  exit 1
fi
echo "   $OTTO_DOMAIN -> $OTTO_HOST"

echo "== websocket upgrade map (nginx has no default \$connection_upgrade)"
if ! grep -q 'connection_upgrade' /etc/nginx/conf.d/websocket-upgrade.conf 2>/dev/null; then
  cat > /etc/nginx/conf.d/websocket-upgrade.conf <<'MAP'
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}
MAP
fi

echo "== vhost"
backup="/etc/nginx.bak.$(date +%s)"
cp -a /etc/nginx "$backup"
install -m 644 /tmp/otto-nginx/otto.conf /etc/nginx/sites-available/otto
ln -sf /etc/nginx/sites-available/otto /etc/nginx/sites-enabled/otto
nginx -t
systemctl reload nginx
echo "   enabled (backup: $backup)"
curl -s -o /dev/null -w "   http://$OTTO_DOMAIN/ -> %{http_code}\n" -H "Host: $OTTO_DOMAIN" http://127.0.0.1/ || true

if [ "$OTTO_MODE" = "--live" ]; then
  echo "== certificate"
  if ! command -v certbot >/dev/null; then
    DEBIAN_FRONTEND=noninteractive apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq certbot python3-certbot-nginx
  fi
  email_args=(--register-unsafely-without-email)
  [ -n "$OTTO_EMAIL" ] && email_args=(-m "$OTTO_EMAIL")
  certbot --nginx -d "$OTTO_DOMAIN" --redirect --agree-tos --non-interactive "${email_args[@]}" 2>&1 | tail -8
  nginx -t && systemctl reload nginx
  curl -sI "https://$OTTO_DOMAIN/" | head -1
fi

echo "== active"
systemctl is-active nginx
REMOTE

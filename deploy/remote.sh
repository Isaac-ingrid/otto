#!/usr/bin/env bash
# Run something on the Sig VPS with the key from deploy/aliyun.env.
#
# The inline key never touches disk in a readable place: it is materialized into a 0600
# mktemp file, used, and removed on exit. Nothing here echoes a secret.
#
#   deploy/remote.sh 'systemctl status sig --no-pager'
#   deploy/remote.sh --copy ./dist/node/steward-node.mjs /opt/sig/dist/node/
set -euo pipefail

cd "$(dirname "$0")/.."
set -a
# shellcheck disable=SC1091
. ./deploy/aliyun.env
set +a

: "${SIG_SSH_HOST:?SIG_SSH_HOST is empty in deploy/aliyun.env}"
SIG_SSH_USER="${SIG_SSH_USER:-root}"
SIG_SSH_PORT="${SIG_SSH_PORT:-22}"

key_file="${SIG_SSH_KEY:-}"
tmp_key=""
cleanup() { if [ -n "$tmp_key" ]; then rm -f "$tmp_key"; fi; }
trap cleanup EXIT

if [ -z "$key_file" ]; then
  if [ -z "${SIG_SSH_KEY_PEM:-}" ]; then
    echo "deploy/aliyun.env has neither SIG_SSH_KEY_PEM nor SIG_SSH_KEY" >&2
    exit 1
  fi
  tmp_key="$(mktemp)"
  chmod 600 "$tmp_key"
  printf '%s\n' "$SIG_SSH_KEY_PEM" > "$tmp_key"
  key_file="$tmp_key"
fi

target="$SIG_SSH_USER@$SIG_SSH_HOST"
ssh_args=(-i "$key_file" -p "$SIG_SSH_PORT" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new)

if [ "${1:-}" = "--copy" ]; then
  shift
  command -v rsync >/dev/null || { echo "rsync not installed locally" >&2; exit 1; }
  rsync -az --info=progress2 -e "ssh ${ssh_args[*]}" "$@"
  exit
fi

exec ssh "${ssh_args[@]}" "$target" "$@"

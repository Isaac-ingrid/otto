#!/usr/bin/env bash
# Run something on the Otto VPS with the key from deploy/aliyun.env.
#
# The inline key never touches disk in a readable place: it is materialized into a 0600
# mktemp file, used, and removed on exit. Nothing here echoes a secret.
#
#   deploy/remote.sh 'systemctl status otto --no-pager'
#   deploy/remote.sh --copy ./dist/node/steward-node.mjs /opt/otto/dist/node/
set -euo pipefail

cd "$(dirname "$0")/.."
set -a
# shellcheck disable=SC1091
. ./deploy/aliyun.env
set +a

: "${OTTO_SSH_HOST:?OTTO_SSH_HOST is empty in deploy/aliyun.env}"
OTTO_SSH_USER="${OTTO_SSH_USER:-root}"
OTTO_SSH_PORT="${OTTO_SSH_PORT:-22}"

key_file="${OTTO_SSH_KEY:-}"
tmp_key=""
cleanup() { if [ -n "$tmp_key" ]; then rm -f "$tmp_key"; fi; }
trap cleanup EXIT

if [ -z "$key_file" ]; then
  if [ -z "${OTTO_SSH_KEY_PEM:-}" ]; then
    echo "deploy/aliyun.env has neither OTTO_SSH_KEY_PEM nor OTTO_SSH_KEY" >&2
    exit 1
  fi
  tmp_key="$(mktemp)"
  chmod 600 "$tmp_key"
  printf '%s\n' "$OTTO_SSH_KEY_PEM" > "$tmp_key"
  key_file="$tmp_key"
fi

target="$OTTO_SSH_USER@$OTTO_SSH_HOST"
ssh_args=(-i "$key_file" -p "$OTTO_SSH_PORT" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new)

if [ "${1:-}" = "--copy" ]; then
  # macOS ships openrsync, which cannot create remote paths ("mkpath: Permission denied").
  # A tar pipe does the same job with only tar/ssh, both stable everywhere.
  shift
  [ "$#" -eq 2 ] || { echo "usage: remote.sh --copy <local-path> <remote-dir>" >&2; exit 1; }
  src="$1"; dest="$2"
  ssh "${ssh_args[@]}" "$target" "mkdir -p '$dest'"
  tar_flags=()
  if [ "$(uname -s)" = "Darwin" ]; then
    tar_flags=(--no-xattrs --no-mac-metadata)
  fi
  if [ -d "$src" ]; then
    COPYFILE_DISABLE=1 tar "${tar_flags[@]}" -C "$src" -cf - . | ssh "${ssh_args[@]}" "$target" "tar --warning=no-unknown-keyword -C '$dest' -xf -"
  else
    COPYFILE_DISABLE=1 tar "${tar_flags[@]}" -C "$(dirname "$src")" -cf - "$(basename "$src")" | ssh "${ssh_args[@]}" "$target" "tar --warning=no-unknown-keyword -C '$dest' -xf -"
  fi
  exit 0
fi

# Do not exec: the EXIT trap must remove a temporary inline-key file after ssh exits.
ssh "${ssh_args[@]}" "$target" "$@"

#!/usr/bin/env bash
# Local smoke test of upload, restore verification, corruption detection, and crypt-only guard.
# The fake rclone copies files to a temp directory; it does NOT test rclone's encryption.
set -euo pipefail
command -v sqlite3 >/dev/null || { echo 'sqlite3 required for backup test' >&2; exit 1; }
script_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT
mkdir -p "$tmp/bin" "$tmp/local" "$tmp/remote"
printf '%s\n' 'test-only nonsecret config' > "$tmp/otto.env"
printf '%s\n' '[crypt]' > "$tmp/rclone.conf"
sqlite3 "$tmp/local/steward-20261112T010203.sqlite" 'CREATE TABLE backup_test (value TEXT); INSERT INTO backup_test VALUES ("ok");'

cat > "$tmp/bin/rclone" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == --config ]] || exit 2
shift 2
cmd="$1"; shift
case "$cmd" in
  config)
    [[ "$1" == show ]] || exit 2
    printf '[%s]\ntype = %s\n' "$2" "${FAKE_REMOTE_TYPE:-crypt}"
    ;;
  copyto)
    src="$1"; dest="$2"
    if [[ "$src" == crypt:* ]]; then src="$FAKE_STORAGE/${src#crypt:}"; fi
    if [[ "$dest" == crypt:* ]]; then dest="$FAKE_STORAGE/${dest#crypt:}"; fi
    mkdir -p "$(dirname "$dest")"
    cp -- "$src" "$dest"
    ;;
  lsf)
    [[ "$2" == --dirs-only ]] || exit 2
    for path in "$FAKE_STORAGE"/otto/*/; do
      [[ ! -d "$path" ]] || printf '%s/\n' "$(basename "$path")"
    done
    ;;
  *) exit 2 ;;
esac
MOCK
chmod +x "$tmp/bin/rclone"
# The test user is not root; mock only the root-only config metadata checks.
cat > "$tmp/bin/stat" <<'MOCK'
#!/usr/bin/env bash
if [[ "$1" == -c && "$3" == "$RCLONE_CONFIG" ]]; then
  case "$2" in %u) echo 0 ;; %a) echo 600 ;; *) exit 2 ;; esac
else
  /usr/bin/stat "$@"
fi
MOCK
chmod +x "$tmp/bin/stat"
export PATH="$tmp/bin:$PATH" FAKE_STORAGE="$tmp/remote"
export OTTO_BACKUP_DIR="$tmp/local" OTTO_VARS_FILE="$tmp/otto.env"
export OTTO_RCLONE_DEST=crypt:otto RCLONE_CONFIG="$tmp/rclone.conf"
bash "$script_dir/offsite-backup.sh" upload
bash "$script_dir/offsite-backup.sh" verify
printf '%s' corrupt > "$tmp/remote/otto/steward-20261112T010203/steward.sqlite"
if bash "$script_dir/offsite-backup.sh" verify >/dev/null 2>&1; then
  echo 'corrupt offsite snapshot was accepted' >&2; exit 1
fi
FAKE_REMOTE_TYPE=local
export FAKE_REMOTE_TYPE
if bash "$script_dir/offsite-backup.sh" upload >/dev/null 2>&1; then
  echo 'unencrypted rclone remote was accepted' >&2; exit 1
fi
echo 'offsite backup smoke test passed'

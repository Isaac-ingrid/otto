#!/usr/bin/env bash
# Rotate SERVER_KEY on the explicit-key VPS deployment (issue #27 semantics, no wrangler).
#
#   deploy/rotate-key.sh status      # what key is where — ids only, never a secret
#   deploy/rotate-key.sh open        # add the window: SERVER_KEY=new, SERVER_KEY_PREVIOUS=old
#   deploy/rotate-key.sh verify      # window is doing its job? (sealed row + connector rekeyed)
#   deploy/rotate-key.sh close       # drop SERVER_KEY_PREVIOUS; the rotation becomes final
#   deploy/rotate-key.sh rollback    # put the old key back (only while the window is open)
#
# Why a window at all: `sh_model.apiKeyEnc` is sealed under the key (`v2.<keyId>…`) and the
# connector's device token names it (`st1.<keyId>…`). With only a new SERVER_KEY the sealed model
# key would not open, and a machine that has not reconnected yet would have to re-pair. The
# verifier accepts both keys while SERVER_KEY_PREVIOUS is set; sealed values are re-sealed onto
# the primary on read, and `welcome` hands each connector a rekeyed token it persists
# (`client.ts` → `store.updateToken`). Close the window only once *both* have moved.
#
# Nothing here prints a secret: key ids are the first 8 hex chars of
# sha256("otto:keyid:v1:<secret>"), which is exactly what a token/sealed blob carries anyway.
# deploy/aliyun.env is backed up outside the repo (0600) before it is rewritten, so `rollback`
# stays possible even if the edit goes wrong.
set -euo pipefail

cd "$(dirname "$0")/.."

ENV_FILE=deploy/aliyun.env
BACKUP_DIR="${HOME}/.local/state/otto-key-rotation"
REMOTE_DB=/var/lib/otto/steward.sqlite
LOCAL_STORE="${OTTO_HOME:-${HOME}/.otto}/connector.sqlite"

die() { echo "error: $*" >&2; exit 1; }
say() { echo "$*"; }

# --- readers ---------------------------------------------------------------------------------

# key id of a variable in the *remote* env file (the file the steward actually loads).
remote_keyid() {
  local name="$1"
  ./deploy/remote.sh "
    f=/etc/otto/.dev.vars
    v=\$(sed -n 's/^${name}=//p' \"\$f\" | head -1)
    if [ -n \"\$v\" ]; then printf '%s' \"otto:keyid:v1:\$v\" | sha256sum | cut -c1-8; else echo '-'; fi
  " 2>/dev/null | tr -d '\r'
}

# local key id from deploy/aliyun.env, without echoing the value.
local_keyid() {
  python3 - "$1" <<'PY'
import re, sys, hashlib
name = sys.argv[1]
for line in open("deploy/aliyun.env"):
    m = re.match(rf"^{name}=(.*)$", line.rstrip("\n"))
    if m:
        v = re.sub(r"\s+#.*$", "", m.group(1)).strip().strip("'\"")
        print(hashlib.sha256(f"otto:keyid:v1:{v}".encode()).hexdigest()[:8] if v else "-")
        break
else:
    print("-")
PY
}

# Sealed ciphertexts carry their key id; collect every one (#74 split the storage, so both the
# live `sh_provider_key` row and the legacy `sh_model` mirror matter).
sealed_keyids() {
  ./deploy/remote.sh "sqlite3 $REMOTE_DB \"
    select substr(apiKeyEnc,4,8) from sh_provider_key where apiKeyEnc <> ''
    union all
    select substr(apiKeyEnc,4,8) from sh_model where id = 0 and apiKeyEnc <> ''\"" 2>/dev/null \
    | tr '\n' ' ' | sed 's/ *$//'
}

connector_keyid() {
  [ -f "$LOCAL_STORE" ] || { echo "-"; return; }
  sqlite3 "$LOCAL_STORE" "select token from credentials where id=0" 2>/dev/null \
    | awk -F. '{ print ($1 == "st1" && NF == 6) ? $2 : "legacy" }'
}

machine_age_s() {
  ./deploy/remote.sh "sqlite3 $REMOTE_DB \"select round((strftime('%s','now')*1000 - lastSeen)/1000) from sh_machine order by lastSeen desc limit 1\"" 2>/dev/null | tr -d '\r'
}

# --- writers ---------------------------------------------------------------------------------

backup_env() {
  install -d -m 700 "$BACKUP_DIR"
  local dest="$BACKUP_DIR/aliyun.env.$(date -u +%Y%m%dT%H%M%SZ)"
  install -m 600 "$ENV_FILE" "$dest"
  say "backed up $ENV_FILE → $dest"
}

# open_window: PREVIOUS=<old SERVER_KEY>, SERVER_KEY=<fresh 32-byte hex>
open_window() {
  backup_env
  python3 - <<'PY'
import re, secrets
path = "deploy/aliyun.env"
text = open(path).read()
m = re.search(r"^SERVER_KEY=(.*)$", text, re.M)
if not m:
    raise SystemExit("error: no SERVER_KEY= line in deploy/aliyun.env")
old = re.sub(r"\s+#.*$", "", m.group(1)).strip().strip("'\"")
if not old:
    raise SystemExit("error: SERVER_KEY is empty; nothing to rotate")
if re.search(r"^SERVER_KEY_PREVIOUS=.+$", text, re.M):
    raise SystemExit("error: SERVER_KEY_PREVIOUS is already set; close or roll back first")
new = secrets.token_hex(32)
text = re.sub(r"^SERVER_KEY=.*$", f"SERVER_KEY={new}", text, count=1, flags=re.M)
text = text.replace(f"SERVER_KEY={new}", f"SERVER_KEY_PREVIOUS={old}\nSERVER_KEY={new}", 1)
open(path, "w").write(text)
print("wrote new SERVER_KEY and SERVER_KEY_PREVIOUS to deploy/aliyun.env")
PY
}

close_window() {
  python3 - <<'PY'
import re
path = "deploy/aliyun.env"
text = open(path).read()
if not re.search(r"^SERVER_KEY_PREVIOUS=.+$", text, re.M):
    raise SystemExit("error: SERVER_KEY_PREVIOUS is not set; the window is already closed")
text = re.sub(r"^SERVER_KEY_PREVIOUS=.*\n", "", text, count=1, flags=re.M)
open(path, "w").write(text)
print("dropped SERVER_KEY_PREVIOUS from deploy/aliyun.env")
PY
}

rollback_window() {
  python3 - <<'PY'
import re
path = "deploy/aliyun.env"
text = open(path).read()
m = re.search(r"^SERVER_KEY_PREVIOUS=(.*)$", text, re.M)
if not m:
    raise SystemExit("error: SERVER_KEY_PREVIOUS is not set; nothing to roll back to")
old = re.sub(r"\s+#.*$", "", m.group(1)).strip().strip("'\"")
text = re.sub(r"^SERVER_KEY=.*$", f"SERVER_KEY={old}", text, count=1, flags=re.M)
text = re.sub(r"^SERVER_KEY_PREVIOUS=.*\n", "", text, count=1, flags=re.M)
open(path, "w").write(text)
print("SERVER_KEY restored to SERVER_KEY_PREVIOUS; window closed")
PY
}

report() {
  local primary previous sealed connector age
  primary="$(remote_keyid SERVER_KEY)"
  previous="$(remote_keyid SERVER_KEY_PREVIOUS)"
  sealed="$(sealed_keyids)"
  connector="$(connector_keyid)"
  age="$(machine_age_s)"
  say "  remote SERVER_KEY           ${primary}"
  say "  remote SERVER_KEY_PREVIOUS  ${previous}"
  say "  sealed secrets under        ${sealed:-（none）}"
  say "  connector token key         ${connector}"
  say "  last machine contact        ${age}s ago"
}

verify() {
  local primary previous sealed connector stale
  primary="$(remote_keyid SERVER_KEY)"
  previous="$(remote_keyid SERVER_KEY_PREVIOUS)"
  sealed="$(sealed_keyids)"
  connector="$(connector_keyid)"
  report
  stale="$(for id in $sealed; do [ "$id" = "$primary" ] || echo "$id"; done)"
  [ -z "$stale" ] || { say "FAIL: a sealed secret is still under ${stale} (read it once under the new primary to re-seal)"; return 1; }
  [ "$connector" = "$primary" ] || { say "FAIL: the connector has not been rekeyed yet (restart it, e.g. systemctl restart otto)"; return 1; }
  [ "$previous" = "$primary" ] && say "NOTE: no previous key is configured; the window is closed"
  say "OK: every sealed secret and the connector token are on the primary key"
}

# --- command line ----------------------------------------------------------------------------

cmd="${1:-status}"
case "$cmd" in
  status)
    report
    ;;
  open)
    [ "${2:-}" = "--force" ] || [ -z "$(remote_keyid SERVER_KEY_PREVIOUS | grep -v '^-$' || true)" ] \
      || die "SERVER_KEY_PREVIOUS is already live on the box; run 'close' or 'rollback' first (or --force)"
    open_window
    ./deploy/apply-env.sh
    say "window open:"
    report
    say "next: ./deploy/rotate-key.sh verify   (after the connector reconnects)"
    ;;
  verify)
    verify
    ;;
  close)
    verify >/dev/null || { verify; die "refusing to close the window before verify passes (--force overrides)"; }
    close_window
    ./deploy/apply-env.sh
    say "window closed:"
    report
    ;;
  rollback)
    rollback_window
    ./deploy/apply-env.sh
    say "rolled back:"
    report
    ;;
  *)
    die "usage: $(basename "$0") {status|open|verify|close|rollback}"
    ;;
esac

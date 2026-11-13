#!/usr/bin/env bash
# Read-only health report for the current IP-HTTPS VPS layout. Never reads or prints secrets.
# Exit nonzero on failures so an operator-owned external monitor can alert on it.
set -euo pipefail
failures=0
check() { if "$@"; then printf 'ok: %s\n' "$description"; else printf 'FAIL: %s\n' "$description" >&2; failures=$((failures + 1)); fi; }

for service in otto nginx otto-backup.timer; do
  description="$service active"
  check systemctl is-active --quiet "$service"
done

cert="${OTTO_CERT_FILE:-/etc/letsencrypt/live/otto-ip/fullchain.pem}"
description='IP HTTPS certificate valid for at least 48 hours'
check openssl x509 -checkend 172800 -noout -in "$cert"

backup_dir="${OTTO_BACKUP_DIR:-/var/lib/otto/backups}"
latest="$(find "$backup_dir" -maxdepth 1 -type f -name 'steward-*.sqlite' -printf '%T@ %p\n' 2>/dev/null | sort -nr | head -n 1 | cut -d ' ' -f 2- || true)"
if [[ -n "$latest" && -f "$latest" ]]; then
  age=$(( $(date +%s) - $(stat -c '%Y' "$latest") ))
  description='latest local backup younger than 36 hours'
  check test "$age" -ge 0 -a "$age" -le 129600
  description='latest local SQLite passes integrity_check'
  check test "$(sqlite3 -readonly "$latest" 'PRAGMA integrity_check;')" = ok
else
  echo 'FAIL: no local SQLite backup' >&2
  failures=$((failures + 1))
fi

used="$(df -P "$backup_dir" 2>/dev/null | awk 'NR==2 {gsub(/%/, "", $5); print $5}' || true)"
description='backup disk usage below 80%'
if [[ "$used" =~ ^[0-9]+$ ]] && (( used < 80 )); then echo "ok: $description"; else echo "FAIL: $description" >&2; failures=$((failures + 1)); fi

if systemctl cat otto-offsite-verify.timer >/dev/null 2>&1; then
  description='encrypted offsite restore check succeeded within 8 days'
  # journald shows the verify script's success line, not just a timer existing.
  entries="$(journalctl --quiet -u otto-offsite-verify.service --since '8 days ago' --no-pager -o cat -n 100)"
  if grep -q 'verified encrypted offsite snapshot' <<< "$entries"; then
    echo "ok: $description"
  else
    echo "FAIL: $description" >&2
    failures=$((failures + 1))
  fi
else
  if [[ "${OTTO_REQUIRE_OFFSITE:-0}" == 1 ]]; then
    echo 'FAIL: encrypted offsite backups not configured' >&2
    failures=$((failures + 1))
  else
    echo 'WARN: offsite backups disabled; local disk loss is not recoverable from local snapshots'
  fi
fi

# Read only aggregates: never print command payloads, subscription endpoints or secrets.
# lastSeen is a connection transition/hello timestamp, NOT a heartbeat; age alone cannot
# distinguish a healthy long-lived connection from a stale persisted online flag.
db="${OTTO_DB_PATH:-/var/lib/otto/steward.sqlite}"
if [[ -f "$db" ]]; then
  now_ms=$(( $(date +%s) * 1000 ))
  count_check() {
    local count
    if count="$(sqlite3 -readonly -cmd '.timeout 5000' "$db" "$1")" && [[ "$count" =~ ^[0-9]+$ ]]; then
      echo "count: $description = $count"
      check test "$count" -eq 0
    else
      echo "FAIL: cannot read $description" >&2
      failures=$((failures + 1))
    fi
  }
  description='queued connector commands past delivery deadline'
  count_check "SELECT COUNT(*) FROM outbox WHERE state='queued' AND notAfter IS NOT NULL AND notAfter < $now_ms - 60000;"
  description='unheld connector commands queued for over 10 minutes'
  count_check "SELECT COUNT(*) FROM outbox WHERE state='queued' AND held=0 AND createdAt < $now_ms - 600000;"
  description='push jobs overdue by over 5 minutes (including retries)'
  count_check "SELECT COUNT(*) FROM sh_push_job WHERE sentAt IS NULL AND dueAt < $now_ms - 300000;"
  description='push jobs exhausting six failed attempts in the past 24 hours'
  count_check "SELECT COUNT(*) FROM sh_push_job WHERE attempts >= 6 AND createdAt >= $now_ms - 86400000;"
else
  echo 'FAIL: production database missing' >&2
  failures=$((failures + 1))
fi

printf 'health checks failed: %d\n' "$failures"
(( failures == 0 ))

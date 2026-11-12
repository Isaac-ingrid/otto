#!/usr/bin/env bash
# Push the steward's environment from deploy/aliyun.env to the server.
#
#   deploy/apply-env.sh            # write /etc/otto/.dev.vars, then restart otto
#   deploy/apply-env.sh --no-restart
#
# Only the keys the steward reads are forwarded; SSH settings (and anything else in the file)
# stay local. No value is ever printed — the summary is name + length.
#
# It rewrites /etc/otto/.dev.vars wholesale: a key set by hand on the server disappears unless it
# is also in aliyun.env and in WANTED below. Keep the two lists in step with src/env.d.ts.
set -euo pipefail

cd "$(dirname "$0")/.."

python3 - <<'PY' > /tmp/otto-dev-vars.$$
import re
WANTED = ["SERVER_KEY", "SERVER_KEY_PREVIOUS", "LOGIN_PASSWORD", "MODEL_KEY",
          "STEWARD_MODEL", "DAILY_BUDGET_USD", "WATCHDOG_LLM", "LOGIN_LINK_TTL_MS",
          "LOGIN_LINK_REUSABLE", "OTTO_PUBLIC_ORIGIN"]
values = {}
for line in open("deploy/aliyun.env"):
    match = re.match(r"^([A-Z_]+)=(.*)$", line.rstrip("\n"))
    if not match:
        continue
    name, value = match.group(1), match.group(2)
    value = re.sub(r"\s+#.*$", "", value).strip()      # the file's inline notes
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
        value = value[1:-1]
    if name in WANTED and value:
        values[name] = value
for name in WANTED:
    if name in values:
        print(f"{name}={values[name]}")
PY
trap 'rm -f /tmp/otto-dev-vars.$$' EXIT
chmod 600 /tmp/otto-dev-vars.$$
if ! grep -q '^OTTO_PUBLIC_ORIGIN=' /tmp/otto-dev-vars.$$; then
  echo 'Set OTTO_PUBLIC_ORIGIN=https://<IP-or-domain> in deploy/aliyun.env before updating the Node service' >&2
  exit 1
fi

awk -F= '{ printf "  %-22s %d chars\n", $1, length($0) - length($1) - 1 }' /tmp/otto-dev-vars.$$

cat /tmp/otto-dev-vars.$$ | ./deploy/remote.sh 'umask 027; cat > /etc/otto/.dev.vars \
  && chown root:otto /etc/otto/.dev.vars && chmod 640 /etc/otto/.dev.vars && echo "wrote /etc/otto/.dev.vars"'

if [ "${1:-}" != "--no-restart" ]; then
  ./deploy/remote.sh 'systemctl restart otto && sleep 3 && systemctl is-active otto'
fi

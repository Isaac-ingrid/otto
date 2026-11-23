#!/usr/bin/env node
/**
 * One-command self-hosted VPS upgrade for Otto Steward (`pnpm deploy:vps`).
 *
 * Pipeline:
 * 1. Builds `apps/connector/dist/cli.js` and `apps/steward/dist/node/steward-node.mjs` locally.
 * 2. Backs up remote SQLite (`sqlite3 .backup`), `/opt/otto/dist/node/steward-node.mjs.prev`,
 *    and `/opt/otto/dist/ui.prev`.
 * 3. Ships the new Steward bundle, full `apps/steward/ui/` directory (cleaning `._*` sidecars
 *    and setting `root:otto` permissions), and `/opt/otto/doctor.sh` (if installed).
 * 4. Verifies `/etc/nginx/sites-available/default` still carries the `/.well-known/acme-challenge/`
 *    bypass to `/var/www/letsencrypt` (auto-healing if overwritten) and renews `otto-ip` if <48h left.
 * 5. Restarts `otto.service` (auto-rolling back `.prev` on startup failure) and runs `deploy/doctor.sh`.
 *
 * Flags:
 *   --dry-run       Run local builds and print the planned remote steps without touching the VPS.
 *   --apply-env     Also run `./deploy/apply-env.sh --no-restart` before restarting `otto`.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const remoteSh = join(rootDir, "deploy", "remote.sh");
const applyEnvSh = join(rootDir, "deploy", "apply-env.sh");
const doctorSh = join(rootDir, "deploy", "doctor.sh");
const aliyunEnv = join(rootDir, "deploy", "aliyun.env");

const argv = new Set(process.argv.slice(2));
for (const flag of argv) {
  if (flag !== "--dry-run" && flag !== "--apply-env") {
    console.error(`deploy-vps: unknown flag '${flag}' (supported: --dry-run, --apply-env)`);
    process.exit(2);
  }
}
const dryRun = argv.has("--dry-run");
const withApplyEnv = argv.has("--apply-env");

function step(title) {
  console.log(`\n==> ${title}`);
}

function runLocal(cmd, args, cwd = rootDir) {
  execFileSync(cmd, args, { cwd, stdio: "inherit" });
}

function runRemote(remoteScript, stdinText) {
  execFileSync("bash", [remoteSh, remoteScript], {
    cwd: rootDir,
    stdio: stdinText !== undefined ? ["pipe", "inherit", "inherit"] : "inherit",
    ...(stdinText !== undefined ? { input: stdinText } : {}),
  });
}

function copyToRemote(localRelPath, remoteDestDir) {
  execFileSync("bash", [remoteSh, "--copy", localRelPath, remoteDestDir], {
    cwd: rootDir,
    stdio: "inherit",
  });
}

if (!existsSync(aliyunEnv) && !dryRun) {
  console.error("deploy-vps: missing deploy/aliyun.env (required by deploy/remote.sh)");
  process.exit(1);
}

// 1. Local build
step("1/5 Building Connector & Steward Node host bundles locally");
runLocal(process.execPath, ["build.mjs"], join(rootDir, "apps", "connector"));
runLocal(process.execPath, ["scripts/build-node.mjs"], join(rootDir, "apps", "steward"));

const stewardBundlePath = join(rootDir, "apps", "steward", "dist", "node", "steward-node.mjs");
const bundleSha256 = createHash("sha256").update(readFileSync(stewardBundlePath)).digest("hex");
console.log(`    steward-node.mjs sha256: ${bundleSha256.slice(0, 16)}…`);

if (dryRun) {
  console.log("\n[dry-run] Local bundles built cleanly. Remote backup, sync, restart, and doctor check skipped.");
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

// 2. Remote pre-upgrade backup (SQLite online backup + previous code/UI snapshot)
step(`2/5 Backing up remote SQLite database & current /opt/otto/dist (${stamp})`);
runRemote(
  [
    "set -euo pipefail",
    "install -d -o otto -g otto -m 0750 /var/lib/otto/backups",
    `if [ -f /var/lib/otto/steward.sqlite ]; then sudo -u otto sqlite3 /var/lib/otto/steward.sqlite ".backup /var/lib/otto/backups/steward-predeploy-${stamp}.sqlite"; fi`,
    "ls -1t /var/lib/otto/backups/steward-predeploy-*.sqlite 2>/dev/null | tail -n +11 | xargs -r rm -f",
    "if [ -f /opt/otto/dist/node/steward-node.mjs ]; then cp /opt/otto/dist/node/steward-node.mjs /opt/otto/dist/node/steward-node.mjs.prev; fi",
    "if [ -d /opt/otto/dist/ui ]; then rm -rf /opt/otto/dist/ui.prev && cp -a /opt/otto/dist/ui /opt/otto/dist/ui.prev; fi",
  ].join("\n"),
);

// 3. Ship new Steward bundle, full UI directory, optional env update, and doctor.sh
step("3/5 Uploading steward-node.mjs & apps/steward/ui to /opt/otto/dist");
copyToRemote("apps/steward/dist/node/steward-node.mjs", "/opt/otto/dist/node");
runRemote("rm -rf /opt/otto/dist/ui && mkdir -p /opt/otto/dist/ui");
copyToRemote("apps/steward/ui", "/opt/otto/dist/ui");
runRemote(
  [
    "set -euo pipefail",
    "find /opt/otto/dist -name '._*' -delete",
    "chown -R root:otto /opt/otto/dist && chmod -R g+rX,o-rwx /opt/otto/dist",
  ].join("\n"),
);

runRemote("if [ -f /opt/otto/doctor.sh ]; then exit 0; else exit 0; fi");
copyToRemote("deploy/doctor.sh", "/opt/otto");
runRemote("chmod 0700 /opt/otto/doctor.sh");

if (withApplyEnv) {
  step("Applying deploy/aliyun.env -> /etc/otto/.dev.vars");
  runLocal("bash", [applyEnvSh, "--no-restart"]);
}

// 4. Guard ACME HTTP-01 challenge path & auto-renew IP cert if <48h remaining, then restart otto
step("4/5 Verifying TLS renewal guard & restarting systemd otto.service");
const acmeAndRestartScript = `
set -euo pipefail

# Ensure /var/www/letsencrypt ACME bypass remains intact even if :80 default vhost was re-synced
if [ -f /etc/nginx/sites-available/default ] && ! grep -q 'location \\^~ /.well-known/acme-challenge/' /etc/nginx/sites-available/default; then
  echo "restoring /.well-known/acme-challenge/ bypass in /etc/nginx/sites-available/default"
  mkdir -p /var/www/letsencrypt/.well-known/acme-challenge
  chmod 0755 / /var /var/www /var/www/letsencrypt /var/www/letsencrypt/.well-known /var/www/letsencrypt/.well-known/acme-challenge
  cp /etc/nginx/sites-available/default /etc/nginx/sites-available/default.bak-acme
  python3 -c '
conf = "/etc/nginx/sites-available/default"
txt = open(conf, "r", encoding="utf-8").read()
snip = """    location ^~ /.well-known/acme-challenge/ {
        allow all;
        root /var/www/letsencrypt;
        default_type "text/plain";
        try_files $uri =404;
    }

"""
anchor = "    location ~ /\\\\. {"
if anchor in txt:
    open(conf, "w", encoding="utf-8").write(txt.replace(anchor, snip + anchor, 1))
'
  if nginx -t; then
    systemctl reload nginx
    sleep 3
  else
    cp /etc/nginx/sites-available/default.bak-acme /etc/nginx/sites-available/default
  fi
fi

# Auto-renew shortlived IP cert if inside the 48-hour renewal window
cert_path="/etc/letsencrypt/live/otto-ip/fullchain.pem"
if [ -f "$cert_path" ] && ! openssl x509 -checkend 172800 -noout -in "$cert_path" >/dev/null 2>&1; then
  echo "IP HTTPS certificate has <48h remaining — running certbot renew..."
  timeout 90 certbot renew --cert-name otto-ip --no-random-sleep-on-renew
  systemctl reload nginx
  sleep 3
fi

# Restart otto and auto-rollback code on startup failure
systemctl restart otto
sleep 3
if ! systemctl is-active --quiet otto; then
  echo "ERROR: otto.service failed to stay active — rolling back to .prev!" >&2
  journalctl -u otto -n 30 --no-pager >&2 || true
  if [ -f /opt/otto/dist/node/steward-node.mjs.prev ]; then
    cp /opt/otto/dist/node/steward-node.mjs.prev /opt/otto/dist/node/steward-node.mjs
  fi
  if [ -d /opt/otto/dist/ui.prev ]; then
    rm -rf /opt/otto/dist/ui && cp -a /opt/otto/dist/ui.prev /opt/otto/dist/ui
  fi
  chown -R root:otto /opt/otto/dist && chmod -R g+rX,o-rwx /opt/otto/dist
  systemctl restart otto
  exit 1
fi
journalctl -u otto -n 8 --no-pager
`;
runRemote("bash -s", acmeAndRestartScript);

// 5. Run read-only remote health check
step("5/5 Running remote deploy/doctor.sh health verification");
runRemote("bash -s", readFileSync(doctorSh, "utf8"));

console.log(`
✅ Cloud server Steward upgraded and verified healthy (${bundleSha256.slice(0, 12)}).
   To also reload your local Mac Connector daemon, run:
     node apps/connector/bin/otto.js restart
`);

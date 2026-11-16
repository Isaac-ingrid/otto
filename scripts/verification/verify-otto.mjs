// Project-local, credentials-free verification. Always run from a checkout, never production.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { resolve, dirname, basename, join, relative, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { root, cache, sha256, toolchain } from './toolchain.mjs';
import { runFormal } from './run-tla.mjs';

const steward = resolve(root, 'apps/steward');
const connector = resolve(root, 'apps/connector');
const require = createRequire(resolve(steward, 'package.json'));
const features = ['conversation', 'pr-watch', 'event-delivery', 'all'];
function doctor() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || major === 22 && minor < 18) throw new Error('Node >=22.18 required');
  const testRequire = createRequire(require.resolve('@playwright/test'));
  const pwRequire = createRequire(testRequire.resolve('playwright/package.json'));
  const core = dirname(pwRequire.resolve('playwright-core/package.json'));
  const revision = JSON.parse(readFileSync(resolve(core, 'browsers.json'), 'utf8')).browsers.find(browser => browser.name === 'chromium-headless-shell').revision;
  let browserDir = dirname(require('@playwright/test').chromium.executablePath());
  while (!/^chromium-\d+$/.test(basename(browserDir))) {
    const parent = dirname(browserDir);
    if (parent === browserDir) throw new Error('Cannot locate pinned browser cache');
    browserDir = parent;
  }
  function findBinary(dir, depth = 3) {
    if (!existsSync(dir) || depth < 0) return undefined;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      if (entry.isFile() && /^chrome-headless-shell(?:\.exe)?$/.test(entry.name)) return file;
      if (entry.isDirectory()) { const found = findBinary(file, depth - 1); if (found) return found; }
    }
  }
  const browser = findBinary(resolve(dirname(browserDir), `chromium_headless_shell-${revision}`));
  if (!browser) throw new Error('Pinned headless Chromium missing: corepack pnpm --filter @isaac2ingrid/steward exec playwright install chromium --only-shell');
  for (const app of [steward, connector]) if (!existsSync(resolve(app, 'node_modules/vitest/vitest.mjs'))) throw new Error('Install the pinned workspace dependencies first');
  const tools = toolchain();
  return { node: process.version, platform: process.platform, browser, javaVersion: tools.javaVersion, jarSha256: tools.jarSha256,
    note: 'Prerequisites only; the browser journey verifies session/auth/readiness on its own isolated instance.' };
}
const [command, feature, ...extra] = process.argv.slice(2);
if (extra.length || !['doctor', 'run'].includes(command) || command === 'doctor' && feature || command === 'run' && !features.includes(feature)) {
  throw new Error('Usage: node scripts/verification/verify-otto.mjs doctor | run conversation|pr-watch|event-delivery|all');
}
if (command === 'doctor') {
  console.log(JSON.stringify(doctor(), null, 2));
} else {
  const prerequisites = doctor();
  mkdirSync(cache, { recursive: true });
  const lock = resolve(cache, 'verify-otto.lock');
  // Refuse parallel control of common test resources. Never delete someone else's lock.
  mkdirSync(lock);
  const output = resolve(root, '.verification/evidence', `${Date.now()}-${randomUUID()}`);
  mkdirSync(output, { recursive: true });
  writeFileSync(resolve(lock, 'owner.json'), JSON.stringify({ pid: process.pid, evidence: output }) + '\n');
  const sourceDirs = ['formal', 'scripts/verification', '.agents/skills/verify-otto', 'packages/protocol/src',
    'apps/connector/src', 'apps/connector/test', 'apps/steward/src', 'apps/steward/ui',
    'apps/steward/node-host', 'apps/steward/e2e', 'apps/steward/test'];
  const inputFiles = ['package.json', 'pnpm-lock.yaml', 'apps/steward/package.json', 'apps/connector/package.json',
    'apps/steward/playwright.config.ts', 'apps/steward/vitest.node.config.ts'];
  function walk(dir) {
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
      const path = join(dir, entry.name);
      return entry.isDirectory() ? walk(path) : entry.isFile() ? [relative(root, path).split(sep).join('/')] : [];
    });
  }
  const fingerprint = () => Object.fromEntries([...inputFiles, ...sourceDirs.flatMap(dir => walk(resolve(root, dir)))].sort()
    .map(file => [file, sha256(readFileSync(resolve(root, file)))]));
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
  const receipt = { runId: basename(output), feature, prerequisites, gitHead: head.stdout.trim(), dirty: Boolean(dirty.stdout.trim()),
    inputs: {}, inputStable: false, steps: [], passed: false };
  try {
    receipt.inputs = fingerprint();
    function run(name, cwd, args, env = {}) {
      const started = Date.now();
      const result = spawnSync(process.execPath, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 360_000, maxBuffer: 32 * 1024 * 1024 });
      writeFileSync(resolve(output, `${name}.log`), `${result.stdout ?? ''}${result.stderr ?? ''}`);
      receipt.steps.push({ name, command: [process.execPath, ...args], cwd, childPid: result.pid,
        exit: result.status, signal: result.signal, error: result.error?.message ?? null, elapsedMs: Date.now() - started });
      if (result.error || result.signal || result.status !== 0 || /\b[1-9]\d* skipped\b/.test(result.stdout ?? '')) throw new Error(`${name} failed or skipped required coverage; see retained evidence`);
      console.log(`PASS ${name}`);
    }
    const browser = (name, grep, expectedJourneys) => {
      const artifacts = resolve(output, name);
      run(name, steward, [resolve(steward, 'node_modules/@playwright/test/cli.js'), 'test', '--project=chromium', '--grep', grep,
        '--trace=on', '--retries=0', '--reporter=list', '--output', artifacts], { OTTO_VERIFY_EVIDENCE: '1' });
      const files = readdirSync(artifacts, { recursive: true }).filter(file => /\.(png|json|zip)$/.test(file));
      for (const filename of ['final-ui.png', 'workspace-state.json', 'trace.zip']) {
        const count = files.filter(file => basename(file) === filename && readFileSync(resolve(artifacts, file)).length > 0).length;
        if (count !== expectedJourneys) throw new Error(`Expected ${expectedJourneys} retained ${filename} files, got ${count}`);
      }
      receipt.steps.at(-1).artifacts = files;
      receipt.steps.at(-1).journeys = expectedJourneys;
    };
    if (feature === 'conversation' || feature === 'all') browser('conversation', '1\\. signs in|2\\. stops|5\\. page reload', 3);
    if (feature === 'pr-watch' || feature === 'all') {
      browser('pr-watch', '3 & 4\\.|7\\. stale PR', 2);
      run('pr-watch-contract', steward, [resolve(steward, 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'vitest.node.config.ts', 'test/pr-watch-api.test.ts', 'test/pr-watch-approval.test.ts']);
    }
    if (feature === 'event-delivery' || feature === 'all') {
      run('connector-events', connector, [resolve(connector, 'node_modules/vitest/vitest.mjs'), 'run', 'test/client.test.ts', 'test/events.test.ts']);
      run('steward-events', steward, [resolve(steward, 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'vitest.node.config.ts', 'test/ledger.test.ts', 'test/event-ack-contract.test.ts']);
      const formal = runFormal(resolve(output, 'formal'));
      receipt.steps.push({ name: 'TLC baseline and negative controls', passed: formal.passed });
      if (!formal.passed) throw new Error('Formal checks failed (including required negative controls)');
    }
    receipt.inputStable = JSON.stringify(receipt.inputs) === JSON.stringify(fingerprint());
    if (!receipt.inputStable) throw new Error('Inputs changed during verification; result is not acceptance evidence');
    receipt.passed = true;
  } catch (error) {
    receipt.error = error.message;
    process.exitCode = 1;
    console.error(error.message);
  } finally {
    writeFileSync(resolve(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
    rmSync(lock, { recursive: true });
    console.log(`Evidence retained after cleanup: ${output}`);
  }
}

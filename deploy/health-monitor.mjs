// Independent, model-free monitor. Persistent outbox survives Otto outages and retries with
// stable IDs; the server deduplicates those IDs before writing workspace notices.
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export function transition(state, failures, now, makeId = randomUUID) {
  const next = structuredClone(state);
  next.issues ??= {};
  next.pending ??= [];
  const current = new Set(failures);
  for (const issue of new Set([...Object.keys(next.issues), ...current])) {
    const before = next.issues[issue];
    const failed = current.has(issue);
    const event = failed ? (!before ? 'failure' : now - before.at >= 6 * 3600_000 ? 'reminder' : null) : before ? 'recovery' : null;
    if (!event) continue;
    if (next.pending.length >= 200) throw new Error('monitor outbox full');
    next.pending.push({ id: makeId(), issue, event });
    if (failed) next.issues[issue] = { at: now };
    else delete next.issues[issue];
  }
  return next;
}

export async function main() {
  const dir = '/var/lib/otto-health';
  const file = `${dir}/state.json`;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  let state;
  try { state = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('cannot read monitor state'); state = {}; }
  const check = spawnSync('/bin/bash', ['/opt/otto/doctor.sh'], { encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 });
  const failures = [...new Set(`${check.stdout ?? ''}\n${check.stderr ?? ''}`.split('\n')
    .filter(line => line.startsWith('FAIL: ')).map(line => line.slice(6)))];
  if (check.error || (check.status !== 0 && !failures.length)) failures.push('health checker could not complete');
  for (const issue of failures) console.error(`health check failed: ${issue}`);
  state = transition(state, failures, Date.now());
  const save = async () => {
    await writeFile(`${file}.tmp`, JSON.stringify(state), { mode: 0o600 });
    await rename(`${file}.tmp`, file);
  };
  // Persist pending intents before contacting Otto. Do not discard alerts when it is down.
  await save();
  const vars = {};
  for (const line of (await readFile('/etc/otto/.dev.vars', 'utf8')).split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) vars[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  if (!vars.SERVER_KEY) throw new Error('monitor needs explicit SERVER_KEY in protected config');
  while (state.pending.length) {
    let response;
    try {
      response = await fetch('http://127.0.0.1:8787/api/health-notice', {
        method: 'POST', signal: AbortSignal.timeout(10_000), redirect: 'error',
        headers: { authorization: `Bearer ${vars.SERVER_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify(state.pending[0]),
      });
      await response.body?.cancel();
    } catch { throw new Error('Otto unavailable; notices retained for next check'); }
    if (!response.ok) throw new Error(`notice rejected (HTTP ${response.status}); retained for retry`);
    state.pending.shift();
    await save();
  }
  console.log(`health monitor: current_failures=${failures.length} pending_notices=${state.pending.length}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('health monitor failed; inspect checker/configuration; pending notices retained'); process.exitCode = 1; });
}

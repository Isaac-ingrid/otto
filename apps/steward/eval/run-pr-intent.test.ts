import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const runner = fileURLToPath(new URL('./run-pr-intent.ts', import.meta.url));
test('paid intent CLI rejects malformed arguments before credential/model lookup', () => {
  for (const args of [[], ['--config'], ['--config', ''], ['--config', 'a', '--config', 'b'], ['--unknown', 'value'], ['--worker-out', 'x', '--config', 'missing'], ['--config', 'missing', '--out', 'x', '--concurrency', '0']]) {
    const child = spawnSync(process.execPath, [runner, ...args], { encoding: 'utf8', timeout: 15000 });
    assert.notEqual(child.status, 0);
    assert.doesNotMatch(child.stderr, /DEEPSEEK_API_KEY|auth\.json/);
  }
});

test('focused runner preserves a complete red faux observation without secrets or paid fallback', { timeout: 90000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'otto-intent-cli-test-'));
  try {
    const config = join(dir, 'profile.json'), out = join(dir, 'result.json');
    writeFileSync(config, JSON.stringify({ provider: 'faux', modelId: 'faux-1', thinkingLevel: 'off', apiKeyEnv: 'OTTO_INTENT_TEST_KEY', label: 'offline-cli-test' }));
    const child = spawnSync(process.execPath, [runner, '--config', config, '--out', out, '--concurrency', '2'], {
      encoding: 'utf8', timeout: 85000, env: { ...process.env, OTTO_INTENT_TEST_KEY: 'fixture-no-network-key' },
    });
    const raw = readFileSync(out, 'utf8');
    const result = JSON.parse(raw);
    assert.equal(child.status, 1, child.stderr);
    assert.equal(result.finished, true);
    assert.equal(result.inputStable, true);
    assert.equal(result.gatePass, false);
    assert.equal(result.summary.n, 12);
    assert.equal(result.summary.errors, 0);
    assert.equal(result.provenance.configuration.measurement, 'pr-tool-intent');
    assert.equal(new Set(result.results.map((r: { caseId: number }) => r.caseId)).size, 12);
    assert.doesNotMatch(raw, /fixture-no-network-key|OTTO_INTENT_TEST_KEY/);
    assert.ok(result.results.every((r: { verdict: string }) => r.verdict !== 'pass'), 'faux prose cannot manufacture success');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('workers use a private frozen profile and attest it despite external profile changes', { timeout: 90000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'otto-intent-freeze-test-'));
  const config = join(dir, 'profile.json'), out = join(dir, 'result.json');
  writeFileSync(config, JSON.stringify({ provider: 'faux', modelId: 'faux-1', thinkingLevel: 'off', apiKeyEnv: 'OTTO_INTENT_TEST_KEY', label: 'frozen-original' }));
  const child = spawn(process.execPath, [runner, '--config', config, '--out', out, '--concurrency', '2'], { env: { ...process.env, OTTO_INTENT_TEST_KEY: 'fixture-no-network-key' }, stdio: 'ignore' });
  const exited = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  try {
    for (let i = 0; i < 2500; i++) {
      if (existsSync(out)) {
        const progress = JSON.parse(readFileSync(out, 'utf8'));
        if (progress.summary.n > 0) { assert.ok(progress.summary.n < 12, 'mutate while later workers are still queued'); break; }
      }
      await new Promise(resolve => setTimeout(resolve, 20));
      if (i === 2499) throw new Error('no partial result');
    }
    writeFileSync(config, 'invalid external profile after first completed case');
    assert.equal(await exited, 1);
    const result = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(result.summary.n, 12);
    assert.equal(result.summary.errors, 0);
    assert.equal(result.inputStable, true);
    for (const row of result.results) assert.deepEqual(row.workerConfiguration, {
      mode: 'production-builder', label: 'frozen-original', provider: 'faux', modelId: 'faux-1',
      requestedThinkingLevel: 'off', effectiveThinkingLevel: 'off', endpointHash: null, customHeaders: false,
    });
  } finally { child.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }); }
});

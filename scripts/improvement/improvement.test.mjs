import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { repoRoot, captureProvenance, canonical, hash } from './provenance.mjs';
import { readEvalProfile } from './eval-config.mjs';
import { compareRuns } from './compare-results.mjs';
import { parseEvalArgs } from './eval-args.mjs';

function temporary(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'otto-improvement-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}
const configuration = { provider: 'test', modelId: 'test', caseIds: [1, 2] };
function run(at = '2026-11-13T00:00:00Z') {
  return { runId: randomUUID(), at, model: 'test', thresholds: { wrongRoute: 0.02, missedAsk: 0.03, unnecessaryAsk: 0.15 },
    provenance: captureProvenance(configuration), inputStable: true,
    results: [
      { id: 1, text: 'one', expect: { kind: 'ask' }, outcome: { kind: 'ask' }, verdict: 'pass' },
      { id: 2, text: 'two', expect: { kind: 'new' }, outcome: { kind: 'new' }, verdict: 'pass' },
    ] };
}

test('eval options reject missing/empty values, repeated flags and typos before credentials', () => {
  for (const option of ['config', 'endpoint', 'model', 'out', 'limit', 'only', 'concurrency']) {
    for (const tail of [[], [''], ['   '], ['--selftest']]) {
      assert.throws(() => parseEvalArgs([`--${option}`, ...tail]), new RegExp(`Missing value for --${option}`));
    }
  }
  assert.throws(() => parseEvalArgs(['--concurency', '4']), /Unknown/);
  assert.throws(() => parseEvalArgs(['--config', 'one', '--config', 'two']), /Duplicate/);
  assert.throws(() => parseEvalArgs(['--selftest', '--selftest']), /Duplicate/);
  assert.deepEqual(parseEvalArgs(['--config', 'a profile.json', '--only', '1,2']), { config: 'a profile.json', only: '1,2' });
  assert.deepEqual(parseEvalArgs(['--selftest']), { selftest: true });
  assert.deepEqual(parseEvalArgs([]), {});
});

test('missing --config path exits without a network call, even with a default key available', () => temporary(dir => {
  const out = join(dir, 'must-not-exist.json');
  const stub = `globalThis.fetch = async () => {
    console.error('UNEXPECTED_NETWORK_CALL');
    const data = { id:'local', object:'chat.completion.chunk', model:'local', choices:[{index:0, delta:{role:'assistant',content:'Hello.'}, finish_reason:'stop'}] };
    return new Response('data: '+JSON.stringify(data)+String.fromCharCode(10,10)+'data: [DONE]'+String.fromCharCode(10,10), {headers:{'content-type':'text/event-stream'}});
  };`;
  const result = spawnSync(process.execPath, ['--import', 'data:text/javascript;base64,' + Buffer.from(stub).toString('base64'),
    'eval/run-eval.ts', '--only', '1', '--out', out, '--config'], {
    cwd: join(repoRoot, 'apps/steward'), env: { ...process.env, DEEPSEEK_API_KEY: 'fake-review-default-key' }, encoding: 'utf8', timeout: 15_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Missing value for --config/);
  assert.equal(result.stderr.includes('UNEXPECTED_NETWORK_CALL'), false);
  assert.equal(existsSync(out), false);
}));

test('capture is repeatable, LF-normalized and detects input edits; excludes result files', () => temporary(root => {
  for (const dir of ['apps/steward/src', 'apps/steward/eval/results', 'packages/protocol/src', 'scripts/improvement']) mkdirSync(join(root, dir), { recursive: true });
  for (const file of ['package.json', 'apps/steward/package.json', 'packages/protocol/package.json', 'pnpm-lock.yaml']) writeFileSync(join(root, file), '{}');
  const source = join(root, 'apps/steward/src/prompt.ts');
  writeFileSync(source, 'one\r\ntwo\r\n');
  const first = captureProvenance(configuration, { root });
  writeFileSync(source, 'one\ntwo\n');
  assert.equal(captureProvenance(configuration, { root }).fingerprint, first.fingerprint);
  writeFileSync(join(root, 'apps/steward/eval/results/new.json'), '{"secret":"not-an-input"}');
  assert.equal(captureProvenance(configuration, { root }).fingerprint, first.fingerprint);
  writeFileSync(source, 'changed');
  assert.notEqual(captureProvenance(configuration, { root }).fingerprint, first.fingerprint);
  assert.equal(first.git.commit, null);
}));

test('profile loads credentials only from named env vars and redacts endpoint/headers', () => temporary(dir => {
  const path = join(dir, 'profile.json');
  writeFileSync(path, JSON.stringify({ provider: 'openai-compatible', modelId: 'custom', baseUrl: 'https://gateway.example/private-path', thinkingLevel: 'auto', label: 'gateway-a', apiKeyEnv: 'EVAL_KEY', headersEnv: 'EVAL_HEADERS' }));
  const profile = readEvalProfile(path, { EVAL_KEY: 'secret-key', EVAL_HEADERS: '{"X-Secret":"secret-header"}' });
  assert.equal(profile.apiKey, 'secret-key');
  assert.deepEqual(profile.config.headers, { 'X-Secret': 'secret-header' });
  const evidence = JSON.stringify(captureProvenance({ ...profile.safe, caseIds: [1] }));
  for (const value of ['secret-key', 'secret-header', 'private-path', 'X-Secret']) assert.equal(evidence.includes(value), false);
  assert.throws(() => readEvalProfile(path, {}), /empty/);
  const input = JSON.parse(readFileSync(path));
  writeFileSync(path, JSON.stringify({ ...input, apiKey: 'never-inline' }));
  assert.throws(() => readEvalProfile(path, {}), /fields/);
  writeFileSync(path, JSON.stringify({ ...input, baseUrl: 'https://user:password@example.test/v1' }));
  assert.throws(() => readEvalProfile(path, {}), /baseUrl/);
  writeFileSync(path, JSON.stringify({ ...input, thinkingLevel: 'typo' }));
  assert.throws(() => readEvalProfile(path, {}), /thinkingLevel/);
}));

test('same-tree report measures score and route flips, not prose; ordering is irrelevant', () => {
  const a = run();
  const b = run('2026-11-13T01:00:00Z');
  b.results[0].outcome = { kind: 'chat' };
  b.results[0].verdict = 'missed_ask';
  b.results.reverse();
  const report = compareRuns([a, b]);
  assert.equal(report.metrics.passRate.mean, 0.75);
  assert.equal(report.metrics.missedAskRate.mean, 0.5);
  assert.equal(report.metrics.passRate.sampleStddev, Math.sqrt(0.125));
  assert.deepEqual(report.flips.map(row => row.id), [1]);
  assert.equal(report.warnings.some(text => text.includes('Fewer than five')), true);
  b.results[1].outcome = { kind: 'ask' };
  b.results[1].verdict = 'pass';
  b.results[1].reply = 'different wording';
  assert.deepEqual(compareRuns([a, b]).flips, []);
});

test('refuses mixed, legacy, partial, duplicate and changed-input runs', () => {
  const a = run();
  const b = run('later');
  assert.throws(() => compareRuns([a]), /at least two/);
  assert.throws(() => compareRuns([a, structuredClone(a)]), /Duplicate/);
  assert.throws(() => compareRuns([a, { ...b, provenance: undefined }]), /provenance/);
  assert.throws(() => compareRuns([a, { ...b, inputStable: false }]), /inputStable/);
  assert.throws(() => compareRuns([a, { ...b, results: b.results.slice(1) }]), /selection/);
  b.provenance = captureProvenance({ ...configuration, effectiveThinkingLevel: 'high' });
  assert.throws(() => compareRuns([a, b]), /Mixed code/);
  b.provenance.fingerprint = a.provenance.fingerprint;
  assert.throws(() => compareRuns([a, b]), /fingerprint/);
});

test('reordered copies cannot masquerade as five observations, even with rewritten IDs', () => {
  const original = run();
  original.results.push({ id: 3, text: 'three', expect: { kind: 'chat' }, outcome: { kind: 'chat' }, verdict: 'pass' });
  original.provenance = captureProvenance({ ...configuration, caseIds: [1, 2, 3] });
  const permutations = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1]];
  const copies = permutations.map(order => ({ ...structuredClone(original), results: order.map(i => structuredClone(original.results[i])) }));
  assert.throws(() => compareRuns(copies), /Duplicate runId/);
  copies.forEach(copy => { copy.runId = randomUUID(); });
  assert.throws(() => compareRuns(copies), /Duplicate run artifact/);
});

test('runId must exist, stay unique and be outside the cohort fingerprint', () => {
  const a = run();
  const b = run('2026-11-13T01:00:00Z');
  // Identical outcomes are legitimate: separate observations must not be deduped by score.
  const report = compareRuns([a, b]);
  assert.equal(report.metrics.passRate.sampleStddev, 0);
  assert.deepEqual(report.runIds, [a.runId, b.runId]);
  assert.equal(a.provenance.fingerprint, b.provenance.fingerprint);
  assert.throws(() => compareRuns([a, { ...b, runId: undefined }]), /runId/);
  assert.throws(() => compareRuns([a, { ...b, runId: 'manually-added-label' }]), /runId/);
  assert.throws(() => compareRuns([a, { ...b, runId: a.runId }]), /Duplicate runId/);
});

test('refuses changed definitions/thresholds and duplicate IDs; zero denominators are null', () => {
  const a = run();
  const b = run('later');
  b.thresholds.wrongRoute = 1;
  assert.throws(() => compareRuns([a, b]), /thresholds/);
  b.thresholds = a.thresholds;
  b.results[0].text = 'changed';
  assert.throws(() => compareRuns([a, b]), /definitions/);
  b.results[0] = structuredClone(a.results[1]);
  assert.throws(() => compareRuns([a, b]), /duplicate/);
  b.results = structuredClone(a.results);
  for (const r of [a, b]) r.results[0].expect.kind = 'new';
  assert.equal(compareRuns([a, b]).metrics.missedAskRate, null);
});

test('runner profile uses production gateway transport; output contains only safe provenance', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'otto-eval-wire-'));
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push({ headers: request.headers, body: JSON.parse(body) });
    response.setHeader('content-type', 'text/event-stream');
    response.end('data: ' + JSON.stringify({ id: 'test', object: 'chat.completion.chunk', model: 'gateway-test', choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello.' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const runIds = new Set();
    for (const thinkingLevel of ['auto', 'auto', 'off', 'high']) {
      const config = join(dir, 'profile.json');
      const output = join(dir, thinkingLevel, 'result.json');
      writeFileSync(config, JSON.stringify({ provider: 'openai-compatible', modelId: 'gateway-test', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, thinkingLevel, label: 'local-wire-test', apiKeyEnv: 'OTTO_TEST_KEY', headersEnv: 'OTTO_TEST_HEADERS' }));
      const code = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['eval/run-eval.ts', '--config', config, '--only', '2', '--out', output], {
          cwd: join(repoRoot, 'apps/steward'), env: { ...process.env, OTTO_TEST_KEY: 'fake-wire-key', OTTO_TEST_HEADERS: '{"X-Wire-Test":"fake-header-secret"}' },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        const timer = setTimeout(() => { child.kill(); reject(new Error('Local eval timed out')); }, 30_000);
        child.on('error', error => { clearTimeout(timer); reject(error); });
        child.on('exit', code => { clearTimeout(timer); resolve(code); });
        child.stdout.resume(); child.stderr.resume();
      });
      // #2 expects a dispatch; a plain reply intentionally fails the unchanged routing gate.
      assert.equal(code, 1);
      const result = JSON.parse(readFileSync(output, 'utf8'));
      assert.match(result.runId, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
      assert.equal(runIds.has(result.runId), false);
      runIds.add(result.runId);
      assert.equal(result.inputStable, true);
      assert.equal(result.provenance.configuration.effectiveThinkingLevel, thinkingLevel);
      assert.equal(result.results.length, 1);
      assert.equal(result.summary.errors, 0);
      const request = requests.at(-1);
      assert.equal(request.headers.authorization, 'Bearer fake-wire-key');
      assert.equal(request.headers['x-wire-test'], 'fake-header-secret');
      assert.equal(request.body.model, 'gateway-test');
      if (thinkingLevel === 'auto') {
        assert.equal(request.body.reasoning_effort, undefined);
        assert.equal(request.body.thinking, undefined);
      } else if (thinkingLevel === 'off') {
        assert.equal(request.body.reasoning_effort, undefined);
        assert.deepEqual(request.body.thinking, { type: 'disabled' });
      } else assert.equal(request.body.reasoning_effort, 'high');
      const evidence = JSON.stringify(result.provenance);
      assert.equal(evidence.includes('fake-wire-key'), false);
      assert.equal(evidence.includes('fake-header-secret'), false);
      assert.equal(evidence.includes('127.0.0.1'), false);
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('canonical hash ignores object insertion order, not array order', () => {
  assert.equal(hash(canonical({ a: 1, b: 2 })), hash(canonical({ b: 2, a: 1 })));
  assert.notEqual(hash(canonical([1, 2])), hash(canonical([2, 1])));
});

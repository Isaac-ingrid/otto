// Explicit-profile focused acceptance. No auth-store fallback and no production-world access.
// Each case has a killable child, bounding local execution/retries, not guaranteeing upstream refunds.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureProvenance, canonical, hash } from '../../../scripts/improvement/provenance.mjs';
import { readEvalProfile } from '../../../scripts/improvement/eval-config.mjs';
import { buildStewardModels, resolveModelThinking } from '../src/llm/models.ts';
import { INTENT_CASES, runIntentCase } from './pr-intent.ts';

const args: Record<string, string> = {};
const allowed = new Set(['config', 'out', 'concurrency', 'worker-case', 'worker-out']);
for (let i = 2; i < process.argv.length; i++) {
  const flag = process.argv[i]!;
  const name = flag.startsWith('--') ? flag.slice(2) : '';
  const value = process.argv[++i];
  if (!allowed.has(name) || Object.hasOwn(args, name) || !value || value.startsWith('--')) throw new Error('Invalid, repeated or missing intent eval argument');
  args[name] = value;
}
if (!args.config) throw new Error('Intent eval requires --config; no credential/model fallback');
const isWorker = args['worker-case'] !== undefined;
if (isWorker ? (!args['worker-out'] || args.out || args.concurrency) : (args['worker-out'] || !args.out)) throw new Error('Invalid intent eval mode');
const concurrency = Number(args.concurrency ?? 1);
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 2) throw new Error('Intent concurrency must be 1 or 2');
const profile = readEvalProfile(args.config);
const thinking = resolveModelThinking(profile.config).thinkingLevel;
if (isWorker) {
  const c = INTENT_CASES.find(c => c.id === Number(args['worker-case']));
  if (!c) throw new Error('Invalid worker case');
  try {
    const built = buildStewardModels(profile.config, profile.apiKey);
    const result = await runIntentCase(c, built.models, {
      model: { provider: profile.config.provider, modelId: profile.config.modelId }, thinkingLevel: thinking === 'auto' ? 'off' : thinking,
    }, c.ownerApprovals);
    writeFileSync(args['worker-out']!, JSON.stringify({ ...result,
      workerConfiguration: { ...profile.safe, effectiveThinkingLevel: thinking },
    }), { mode: 0o600 });
  } catch {
    // Do not serialize gateway errors which can echo URLs/credentials. Parent records failure.
    process.exit(2);
  }
  process.exit(0);
}

const deadlineMs = 150_000;
const configuration = { ...profile.safe, measurement: 'pr-tool-intent', scoringVersion: 3, approvalProtocol: 'owner-bound-confirmation-v1', simulatedOwner: true,
  effectiveThinkingLevel: thinking, concurrency, deadlineMs, totalCaseCount: INTENT_CASES.length,
  caseIds: INTENT_CASES.map(c => c.id), caseHash: hash(canonical(INTENT_CASES)) };
const provenance = captureProvenance(configuration);
const runId = randomUUID();
const at = new Date().toISOString();
const temp = mkdtempSync(join(tmpdir(), 'otto-pr-intent-'));
const frozenProfilePath = join(temp, 'profile.json');
writeFileSync(frozenProfilePath, JSON.stringify({ provider: profile.config.provider, modelId: profile.config.modelId,
  ...(profile.config.baseUrl ? { baseUrl: profile.config.baseUrl } : {}), thinkingLevel: profile.safe.requestedThinkingLevel,
  label: profile.safe.label, apiKeyEnv: 'OTTO_INTENT_SNAPSHOT_KEY',
  ...(profile.config.headers !== undefined ? { headersEnv: 'OTTO_INTENT_SNAPSHOT_HEADERS' } : {}),
}), { mode: 0o600 });
const workerEnv = { ...process.env, OTTO_INTENT_SNAPSHOT_KEY: profile.apiKey,
  ...(profile.config.headers !== undefined ? { OTTO_INTENT_SNAPSHOT_HEADERS: JSON.stringify(profile.config.headers) } : {}),
};
const expectedWorkerConfiguration = hash(canonical({ ...profile.safe, effectiveThinkingLevel: thinking }));
type Result = Awaited<ReturnType<typeof runIntentCase>> | { caseId: number; verdict: 'incomplete'; error: string };
const results: Result[] = [];
const queue = [...INTENT_CASES];
let infrastructureFailure = false;
mkdirSync(dirname(args.out!), { recursive: true });
const save = (finished: boolean) => {
  const inputStable = captureProvenance(configuration).fingerprint === provenance.fingerprint;
  const counts = Object.fromEntries([...new Set(results.map(r => r.verdict))].map(v => [v, results.filter(r => r.verdict === v).length]));
  const gatePass = finished && inputStable && results.length === INTENT_CASES.length && results.every(r => r.verdict === 'pass');
  writeFileSync(`${args.out!}.tmp`, JSON.stringify({ runId, at, model: profile.config.modelId, provenance, inputStable,
    finished, gatePass, summary: { n: results.length, total: INTENT_CASES.length, counts,
      errors: results.filter(r => 'error' in r).length },
    results: [...results].sort((a, b) => a.caseId - b.caseId),
  }, null, 1) + '\n', { mode: 0o600 });
  renameSync(`${args.out!}.tmp`, args.out!);
  return gatePass;
};
async function worker(): Promise<void> {
  while (!infrastructureFailure) {
    const c = queue.shift(); if (!c) return;
    const output = join(temp, `case-${c.id}.json`);
    const startedAt = Date.now();
    const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), '--config', frozenProfilePath, '--worker-case', String(c.id), '--worker-out', output], {
      env: workerEnv, stdio: 'ignore', // Parent logs only synthetic case ids/verdicts, never SDK error bodies.
    });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, deadlineMs);
    let code: number | null;
    try {
      code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    } catch { code = null; }
    finally { clearTimeout(timer); }
    let result: Result;
    try {
      if (code !== 0) throw new Error(timedOut ? 'case_deadline' : 'case_worker_failed');
      const parsed = JSON.parse(readFileSync(output, 'utf8')) as Awaited<ReturnType<typeof runIntentCase>> & { workerConfiguration: unknown };
      if (parsed.workerConfiguration === undefined || hash(canonical(parsed.workerConfiguration)) !== expectedWorkerConfiguration) throw new Error('worker_configuration_changed');
      if (parsed.caseId !== c.id || !Array.isArray(parsed.observation?.toolCalls)) throw new Error('invalid_case_result');
      result = parsed;
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      result = { caseId: c.id, verdict: 'incomplete', error: ['case_deadline', 'case_worker_failed', 'invalid_case_result', 'worker_configuration_changed'].includes(message) ? message : 'case_result_missing' };
      infrastructureFailure = true; // Preserve partial evidence; no blind additional paid cases/retries.
    }
    results.push(result); save(false);
    console.error(`[${results.length}/${INTENT_CASES.length}] #${c.id} -> ${result.verdict} (${Date.now() - startedAt}ms)`);
  }
}
try {
  save(false);
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  process.exitCode = save(true) ? 0 : 1;
} finally { rmSync(temp, { recursive: true, force: true }); }

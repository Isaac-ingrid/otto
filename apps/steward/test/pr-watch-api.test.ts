import { beforeEach, describe, expect, it } from 'vitest';
import { SELF, runInDurableObject } from 'cloudflare:test';
import type { Ledger } from '../src/ledger.ts';
import type { PrWatchDeps, PrWatchService } from '../src/pr-watch.ts';
import type { EvidenceResult } from '../src/pr-evidence.ts';
import { configureAndBind, llmState, ownerStub, resetLedgerState, waitWhileOutboundPending } from './helpers.ts';

const ENDPOINT = 'https://steward.test/api/pr-watches';
const THREAD = 't_pr_watch_test';
const payload = { action: 'create', id: 'follow-pr-42', threadId: THREAD, url: 'https://github.com/example/project/pull/42' };
const auth = { authorization: 'Bearer test-server-key-not-a-secret' };
const send = (body: unknown) => SELF.fetch(ENDPOINT, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body) });
let reads = 0;

beforeEach(async () => {
  await resetLedgerState();
  await configureAndBind('ou_owner');
  reads = 0;
  await runInDurableObject(ownerStub(), raw => {
    const instance = raw as unknown as { ledger: Ledger; prWatches: PrWatchService };
    instance.ledger.threads.create({ threadId: THREAD, title: 'PR follow-up', goal: 'Wait for CI, no modifications' });
    // Replace only the network boundary; keep the production service, storage and outbound path.
    const deps = (instance.prWatches as unknown as { deps: PrWatchDeps }).deps;
    deps.read = async (): Promise<EvidenceResult> => { reads++; return { ok: true, evidence: { head: 'a'.repeat(40), state: 'success', checks: 1, failed: 0, pending: 0 } }; };
  });
});

describe('owner-authorized persistent PR watches', () => {
  it('requires explicit API authority, validates scope and deduplicates creates/schedules', async () => {
    expect((await SELF.fetch(ENDPOINT)).status).toBe(401);
    expect((await SELF.fetch(ENDPOINT, { method: 'POST', body: JSON.stringify(payload) })).status).toBe(401);
    expect((await send({ ...payload, threadId: 'missing' })).status).toBe(400);
    expect((await send({ ...payload, url: 'https://127.0.0.1/private' })).status).toBe(400);
    expect((await send(payload)).status).toBe(200);
    expect((await send(payload)).status).toBe(200);
    expect((await send({ ...payload, url: 'https://github.com/example/project/pull/43' })).status).toBe(409);
    const response = await SELF.fetch(ENDPOINT, { headers: auth });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect((await response.json() as { watches: unknown[] }).watches).toHaveLength(1);
    await runInDurableObject(ownerStub(), async raw => {
      const schedules = await (raw as unknown as { listSchedules(): Promise<Array<{ callback: string }>> }).listSchedules();
      expect(schedules.filter(s => s.callback === 'pollPrWatches')).toHaveLength(1);
    });
    expect((await llmState()).runs).toHaveLength(0);
  });

  it('delivers one head-bound external-state report, without a model run or worker command', async () => {
    await send(payload);
    await ownerStub().pollPrWatches();
    await ownerStub().pollPrWatches();
    await waitWhileOutboundPending();
    const reports = (await ownerStub().outboundRows(100)).filter(row => row.id.startsWith('pr-watch:follow-pr-42:'));
    expect(reports).toHaveLength(1);
    expect(JSON.stringify(reports[0]!.payload)).toContain('不代表需求验收通过');
    expect(JSON.stringify(reports[0]!.payload)).toContain('a'.repeat(40));
    expect(reports[0]!.threadId).toBe(THREAD);
    const snapshot = await ownerStub().debugSnapshot();
    expect(snapshot.threads.flatMap(thread => thread.workers)).toHaveLength(0);
    expect(snapshot.threads.flatMap(thread => thread.timeline).filter(entry => entry.text.includes('a'.repeat(40)))).toHaveLength(1);
    expect((await llmState()).runs).toHaveLength(0);
  });

  it('cancels future checks, survives repeated cancellation and never resurrects on create retry', async () => {
    await send(payload);
    expect((await send({ action: 'cancel', id: payload.id })).status).toBe(200);
    expect((await send({ action: 'cancel', id: payload.id })).status).toBe(200);
    expect((await send({ action: 'cancel', id: 'missing' })).status).toBe(404);
    expect((await send(payload)).status).toBe(200);
    await ownerStub().pollPrWatches();
    const response = await SELF.fetch(ENDPOINT, { headers: auth });
    expect((await response.json() as { watches: Array<{ status: string }> }).watches[0]!.status).toBe('cancelled');
    expect((await ownerStub().outboundRows(100)).filter(row => row.id.startsWith('pr-watch:'))).toHaveLength(0);
    expect((await llmState()).runs).toHaveLength(0);
    expect(reads).toBe(0);
  });
});

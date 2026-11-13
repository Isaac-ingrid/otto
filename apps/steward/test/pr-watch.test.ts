import { beforeEach, describe, expect, it } from 'vitest';
import { runInDurableObject } from 'cloudflare:test';
import { PrWatchService, type PrWatchDeps } from '../src/pr-watch.ts';
import type { EvidenceResult } from '../src/pr-evidence.ts';
import type { SqlExecutor } from '../src/schema.ts';
import { configureAndBind, ownerStub, resetLedgerState } from './helpers.ts';

const HEAD = 'a'.repeat(40);
const NEXT = 'b'.repeat(40);
const URL = 'https://github.com/example/project/pull/42';
const success: EvidenceResult = { ok: true, evidence: { head: HEAD, state: 'success', checks: 1, failed: 0, pending: 0 } };
const waiting: EvidenceResult = { ok: true, evidence: { head: HEAD, state: 'waiting', checks: 0, failed: 0, pending: 0 } };
const failure: EvidenceResult = { ok: true, evidence: { head: HEAD, state: 'failure', checks: 2, failed: 1, pending: 1 } };

beforeEach(async () => { await resetLedgerState(); await configureAndBind('ou_owner'); });
async function fixture(fn: (h: {
  service: PrWatchService; deps: PrWatchDeps; sql: SqlExecutor;
  now: number; result: EvidenceResult; reads: number; notices: Map<string, string>;
}) => Promise<void> | void) {
  await runInDurableObject(ownerStub(), async raw => {
    const instance = raw as unknown as { sql: SqlExecutor; ctx: { storage: { transactionSync<T>(fn: () => T): T } } };
    const sql = instance.sql.bind(instance);
    const h = { now: 1_000_000, result: waiting, reads: 0, notices: new Map<string, string>() } as {
      service: PrWatchService; deps: PrWatchDeps; sql: SqlExecutor;
      now: number; result: EvidenceResult; reads: number; notices: Map<string, string>;
    };
    h.sql = sql;
    h.deps = { sql, tx: fn => instance.ctx.storage.transactionSync(fn), now: () => h.now,
      threadExists: id => id === 't_pr',
      read: async () => { h.reads++; return h.result; },
      notify: async notice => { h.notices.set(notice.id, notice.text); },
    };
    h.service = new PrWatchService(h.deps);
    await fn(h);
  });
}
function create(service: PrWatchService, patch: Record<string, unknown> = {}) {
  return service.create({ id: 'watch-1', threadId: 't_pr', url: URL, ...patch });
}

describe('durable PR commissions', () => {
  it('validates targets, scope, interval, expiry and caps active watches', async () => fixture(h => {
    for (const patch of [{ threadId: 'missing' }, { url: 'http://127.0.0.1/private' }, { intervalSeconds: 0 }, { intervalSeconds: 59 }, { intervalSeconds: 3601 }, { expiresAt: h.now }, { expiresAt: h.now + 8 * 86_400_000 }]) expect(() => create(h.service, patch)).toThrow();
    for (let n = 0; n < 10; n++) create(h.service, { id: `watch-${n}` });
    expect(() => create(h.service, { id: 'watch-overflow' })).toThrow('active_watch_limit');
  }));

  it('owner retries are idempotent and cannot silently change or resurrect a commission', async () => fixture(h => {
    const first = create(h.service);
    h.now += 1000;
    expect(create(h.service)).toEqual(first);
    expect(() => create(h.service, { url: 'https://github.com/example/other/pull/1' })).toThrow('id_conflict');
    expect(h.service.cancel(first.id)).toBe(true);
    expect(create(h.service).status).toBe('cancelled');
    expect(h.service.cancel(first.id)).toBe(true);
    expect(h.service.cancel('missing')).toBe(false);
  }));

  it('no checks is silent waiting; scheduled polling is not model execution', async () => fixture(async h => {
    create(h.service);
    await h.service.tick();
    expect(h.reads).toBe(1);
    expect(h.service.list()[0]).toMatchObject({ status: 'active', observedState: 'waiting', checks: 0 });
    expect(h.notices.size).toBe(0);
    await h.service.tick();
    expect(h.reads).toBe(1); // not due
  }));

  it('failure stays active, repeats coalesce, success is head-bound and terminal', async () => fixture(async h => {
    create(h.service);
    h.result = failure;
    await h.service.tick();
    h.now += 900_000;
    await h.service.tick();
    expect(h.notices.size).toBe(1);
    expect(h.service.list()[0]?.status).toBe('active');
    h.now += 900_000;
    h.result = { ok: true, evidence: { ...success.evidence, head: NEXT } };
    await h.service.tick();
    expect(h.notices.size).toBe(2);
    expect([...h.notices.values()].at(-1)).toContain(NEXT);
    expect([...h.notices.values()].at(-1)).toContain('不代表需求验收通过');
    expect(h.service.list()[0]).toMatchObject({ status: 'completed', head: NEXT });
    h.now += 900_000;
    await new PrWatchService(h.deps).tick();
    expect(h.reads).toBe(3);
    expect(h.notices.size).toBe(2);
  }));

  it('unavailable evidence is not failure; known evidence remains explicitly stale', async () => fixture(async h => {
    create(h.service);
    await h.service.tick();
    const checkedAt = h.service.list()[0]!.checkedAt;
    h.now += 900_000;
    h.result = { ok: false, reason: 'github_http_429' };
    await h.service.tick();
    expect(h.service.list()[0]).toMatchObject({ status: 'active', lastError: 'github_http_429', checkedAt });
    expect(h.notices.size).toBe(0);
  }));

  it('cancellation during an in-flight read wins over a late green result', async () => fixture(async h => {
    create(h.service);
    h.deps.read = async () => { h.service.cancel('watch-1'); return success; };
    await h.service.tick();
    expect(h.service.list()[0]).toMatchObject({ status: 'cancelled', head: null });
    expect(h.notices.size).toBe(0);
    await new PrWatchService(h.deps).tick();
    expect(h.notices.size).toBe(0);
  }));

  it('expiry during a read rejects its result and reports expiry once across restart', async () => fixture(async h => {
    create(h.service, { expiresAt: h.now + 1000 });
    h.deps.read = async () => { h.now += 1001; return success; };
    await h.service.tick();
    expect(h.service.list()[0]).toMatchObject({ status: 'expired', head: null });
    expect([...h.notices.values()]).toHaveLength(1);
    expect([...h.notices.values()][0]).toContain('到期');
    await new PrWatchService(h.deps).tick();
    expect(h.notices.size).toBe(1);
  }));

  it('persists an outbox before delivery; an accepted-but-unacknowledged notice deduplicates', async () => fixture(async h => {
    create(h.service);
    h.result = success;
    let once = true;
    h.deps.notify = async notice => {
      h.notices.set(notice.id, notice.text);
      if (once) { once = false; throw new Error('connection lost after durable enqueue'); }
    };
    await expect(h.service.tick()).rejects.toThrow();
    expect(h.service.list()[0]?.status).toBe('completed');
    expect(h.sql`SELECT * FROM sh_pr_watch_notice`).toHaveLength(1);
    await new PrWatchService(h.deps).tick();
    expect(h.notices.size).toBe(1);
    expect(h.sql`SELECT * FROM sh_pr_watch_notice WHERE deliveredAt IS NULL`).toHaveLength(0);
    expect(h.sql`SELECT * FROM sh_pr_watch_notice WHERE deliveredAt IS NOT NULL`).toHaveLength(1);
  }));

  it('a cancelled commission suppresses still-pending notices', async () => fixture(async h => {
    create(h.service);
    h.result = failure;
    h.deps.notify = async () => { throw new Error('delivery down'); };
    await expect(h.service.tick()).rejects.toThrow();
    expect(h.sql`SELECT * FROM sh_pr_watch_notice`).toHaveLength(1);
    h.service.cancel('watch-1');
    await h.service.tick();
    expect(h.sql`SELECT * FROM sh_pr_watch_notice`).toHaveLength(0);
    expect(h.notices.size).toBe(0);
  }));

  it('delivered receipts suppress the same head/kind even after intervening waiting', async () => fixture(async h => {
    create(h.service);
    h.result = failure;
    await h.service.tick();
    const receipt = h.sql<{ deliveredAt: number }>`SELECT deliveredAt FROM sh_pr_watch_notice`[0]!.deliveredAt;
    h.now += 900_000;
    h.result = waiting;
    await h.service.tick();
    h.now += 900_000;
    h.result = failure;
    await h.service.tick();
    expect(h.sql<{ deliveredAt: number }>`SELECT deliveredAt FROM sh_pr_watch_notice`[0]!.deliveredAt).toBe(receipt);
    expect(h.notices.size).toBe(1);
  }));

  it('a restarted reader supersedes a timed-out lease; late old-head success cannot win', async () => fixture(async h => {
    create(h.service);
    let finish: ((result: EvidenceResult) => void) | undefined;
    h.deps.read = () => new Promise(resolve => { finish = resolve; });
    const old = h.service.tick();
    for (let n = 0; n < 10 && !finish; n++) await Promise.resolve();
    expect(finish).toBeDefined();
    h.now += 120_001;
    h.deps.read = async () => ({ ok: true, evidence: { ...waiting.evidence, head: NEXT } });
    await new PrWatchService(h.deps).tick();
    finish!(success);
    await old;
    expect(h.service.list()[0]).toMatchObject({ status: 'active', head: NEXT, observedState: 'waiting' });
    expect(h.notices.size).toBe(0);
  }));

  it('observation and notification intent roll back together if persisting the intent fails', async () => fixture(async h => {
    create(h.service);
    h.result = success;
    const realSql = h.deps.sql;
    h.deps.sql = ((strings: TemplateStringsArray, ...values: (string | number | boolean | null)[]) => {
      if (strings.join('').includes('INSERT OR IGNORE INTO sh_pr_watch_notice')) throw new Error('storage failure');
      return realSql(strings, ...values);
    }) as SqlExecutor;
    await expect(h.service.tick()).rejects.toThrow('storage failure');
    expect(h.service.list()[0]).toMatchObject({ status: 'active', head: null, observedState: null });
    expect(h.sql`SELECT * FROM sh_pr_watch_notice`).toHaveLength(0);
    h.deps.sql = realSql;
    h.now += 120_001;
    await new PrWatchService(h.deps).tick();
    expect(h.service.list()[0]?.status).toBe('completed');
    expect(h.notices.size).toBe(1);
  }));

  it('a missing parent Thread cancels the commission without another external read', async () => fixture(async h => {
    create(h.service);
    h.deps.threadExists = () => false;
    await h.service.tick();
    expect(h.reads).toBe(0);
    expect(h.service.list()[0]?.status).toBe('cancelled');
  }));

  it('restart recovers an abandoned lease, never polls early, and local ticks coalesce', async () => fixture(async h => {
    create(h.service);
    h.sql`UPDATE sh_pr_watch SET generation = generation + 1, nextCheckAt = ${h.now + 120_000}`;
    const restarted = new PrWatchService(h.deps);
    await restarted.tick();
    expect(h.reads).toBe(0);
    h.now += 120_001;
    await Promise.all([restarted.tick(), restarted.tick()]);
    expect(h.reads).toBe(1);
  }));
});

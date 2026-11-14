import { beforeEach, describe, expect, it } from 'vitest';
import { SELF, runInDurableObject } from 'cloudflare:test';
import { fauxAssistantMessage, fauxToolCall, fauxText } from '@earendil-works/pi-ai/providers/faux';
import type { Ledger } from '../src/ledger.ts';
import type { PrWatchService, PrWatchDeps } from '../src/pr-watch.ts';
import type { PrWatchApprovals } from '../src/pr-watch-approval.ts';
import type { SqlExecutor } from '../src/schema.ts';
import { configureAndBind, messageEvent, ownerStub, postEvent, resetLedgerState, scriptModel, waitRunsSettled, waitWhileOutboundPending, llmState, webLogin } from './helpers.ts';
const THREAD = 't_approval', URL = 'https://github.com/example/demo/pull/12';
const create = { action: 'create' as const, threadId: THREAD, url: URL, evidenceMode: 'statuses-only' as const };
async function inside<T>(fn: (a: PrWatchApprovals, w: PrWatchService, l: Ledger, sql: SqlExecutor) => T): Promise<T> {
  return runInDurableObject(ownerStub(), raw => {
    const ctx = raw as unknown as { prWatchApprovals: PrWatchApprovals; prWatches: PrWatchService; ledger: Ledger; sql: SqlExecutor };
    return fn(ctx.prWatchApprovals, ctx.prWatches, ctx.ledger, ctx.sql.bind(ctx));
  });
}
const click = (cardMsgId: string, action: string) => SELF.fetch('https://example.com/api/actions', { method: 'POST', headers: { authorization: 'Bearer test-server-key-not-a-secret', 'content-type': 'application/json' }, body: JSON.stringify({ cardMsgId, action }) });
beforeEach(async () => {
  await resetLedgerState(); await configureAndBind('ou_owner');
  await inside((_a, _w, ledger) => { ledger.threads.create({ threadId: THREAD, title: 'Approval target', goal: 'Read CI only after explicit owner decision' }); });
});

describe('bound PR watch decisions', () => {
  it('proposes zero effects, then applies exactly one immutable command', async () => {
    await inside((a, w, ledger) => {
      const p = a.propose(create, 'user:proposal', 'task1');
      expect(w.list()).toHaveLength(0);
      expect(ledger.questions.get(p.id)!.status).toBe('open');
      expect(a.propose(create, 'user:proposal', 'task2').id).toBe(p.id);
      expect(() => a.propose({ ...create, intervalSeconds: 60 }, 'user:proposal', 'task3')).toThrow('proposal_conflict');
      expect(a.decide(p.id, true, 'user:click1')).toMatchObject({ status: 'applied', appliedNow: true });
      const first = w.list()[0]!;
      expect(first).toMatchObject({ status: 'active', evidenceMode: 'statuses-only', intervalMs: 900000 });
      expect(a.decide(p.id, true, 'user:click2').appliedNow).toBeUndefined();
      expect(a.propose(create, 'user:proposal', 'task1').id).toBe(p.id);
      expect(w.list()).toEqual([first]);
      w.cancel(first.id);
      expect(a.decide(p.id, true, 'user:click3').watch!.status).toBe('cancelled');
      expect(w.list()).toHaveLength(1);
    });
  });
  it('relative expiry is chosen once on confirmation; replays neither renew nor resurrect', async () => {
    await inside((a, w) => {
      const request = { ...create, expiresInMinutes: 60 };
      const p = a.propose(request, 'user:relative', 'same-task');
      a.decide(p.id, true, 'user:click');
      const first = w.list()[0]!;
      expect(first.expiresAt - first.createdAt).toBeLessThanOrEqual(3600000);
      expect(first.expiresAt - first.createdAt).toBeGreaterThan(3599000);
      expect(a.propose(request, 'user:relative', 'same-task').id).toBe(p.id);
      a.decide(p.id, true, 'user:replay');
      expect(w.list()[0]!.expiresAt).toBe(first.expiresAt);
      w.cancel(first.id);
      a.decide(p.id, true, 'user:again');
      expect(w.list()[0]!.status).toBe('cancelled');
    });
  });
  it('declined and expired decisions never execute, even on replay', async () => {
    await inside((a, w, _l, sql) => {
      const declined = a.propose(create, 'user:decline', 't1');
      expect(a.decide(declined.id, false, 'user:click').status).toBe('declined');
      expect(a.decide(declined.id, true, 'user:click-again').status).toBe('declined');
      const expired = a.propose(create, 'user:expiry', 't2');
      sql`UPDATE sh_pr_watch_approval SET expiresAt = 0 WHERE id = ${expired.id}`;
      expect(a.decide(expired.id, true, 'user:late').status).toBe('expired');
      expect(w.list()).toHaveLength(0);
    });
  });
  it('backend failure after insertion rolls back the watch and leaves the proposal retryable', async () => {
    await inside((a, w, ledger) => {
      const p = a.propose(create, 'user:rollback', 't1');
      const backend = (a as unknown as { deps: { watches: PrWatchService } }).deps.watches;
      const deps = (backend as unknown as { deps: PrWatchDeps }).deps;
      const record = deps.record;
      deps.record = () => { throw new Error('injected after insert'); };
      expect(() => a.decide(p.id, true, 'user:click')).toThrow('injected after insert');
      expect(w.list()).toHaveLength(0);
      expect(a.get(p.id)!.status).toBe('pending');
      expect(ledger.questions.get(p.id)!.status).toBe('open');
      deps.record = record;
      a.decide(p.id, true, 'user:retry');
      expect(w.list()).toHaveLength(1);
    });
  });
  it('binds cancellation to exact watch identity and leaves unrelated work alone', async () => {
    await inside((a, w, _l, sql) => {
      w.create({ ...create, id: 'pw_x' }); w.create({ ...create, id: 'pw_other', url: URL.replace('/12', '/13') });
      const p = a.propose({ action: 'cancel', watchId: 'pw_x' }, 'user:cancel', 't1');
      expect(w.list().every(row => row.status === 'active')).toBe(true);
      sql`UPDATE sh_pr_watch SET expiresAt = expiresAt + 1000 WHERE id = 'pw_x'`;
      expect(() => a.decide(p.id, true, 'user:click')).toThrow('target_changed');
      expect(a.get(p.id)!.status).toBe('pending');
      expect(w.list().every(row => row.status === 'active')).toBe(true);
      const p2 = a.propose({ action: 'cancel', watchId: 'pw_x' }, 'user:cancel-new', 't2');
      a.decide(p2.id, true, 'user:click-new');
      expect(w.list().find(row => row.id === 'pw_x')!.status).toBe('cancelled');
      expect(w.list().find(row => row.id === 'pw_other')!.status).toBe('active');
    });
  });
  it('reuse never extends expiry, and cannot resume a cancelled target', async () => {
    await inside((a, w) => {
      const original = w.create({ ...create, id: 'pw_existing' });
      const p = a.propose(create, 'user:reuse', 't1');
      expect(JSON.parse(p.command).action).toBe('reuse');
      a.decide(p.id, true, 'user:click');
      expect(w.list()[0]!.expiresAt).toBe(original.expiresAt);
      const next = a.propose(create, 'user:reuse-new', 't2');
      w.cancel(original.id);
      expect(() => a.decide(next.id, true, 'user:stale')).toThrow('target_changed');
      expect(w.list()[0]!.status).toBe('cancelled');
    });
  });
  it('workspace confirmation uses the same bound command, closes Needs you and refuses stale taps', async () => {
    await scriptModel(fauxAssistantMessage([fauxToolCall('create_pr_watch', { threadId: THREAD, url: URL, evidenceMode: 'statuses-only', basis: 'user_explicit' })], { stopReason: 'toolUse' }));
    await postEvent(messageEvent({ text: `在 ${THREAD} 中持续盯住 ${URL}，仅看 commit statuses。` }));
    await waitRunsSettled(); await waitWhileOutboundPending();
    const card = (await ownerStub().outboundRows(100)).find(row => row.id.startsWith('prwatchapproval:'))!;
    const action = JSON.parse(card.payload).card.buttons[0].action as string;
    const cookie = await webLogin();
    const get = async () => (await SELF.fetch('https://example.com/app/api/workspace', { headers: { cookie } })).json() as Promise<{ csrf: string; attention: Array<{ id: string }>; messages: Array<{ id: string; open?: boolean }> }>;
    const before = await get();
    expect(before.attention.some(row => row.id === card.id)).toBe(true);
    const post = (id: string) => SELF.fetch('https://example.com/app/api/actions', { method: 'POST', headers: { cookie, origin: 'https://example.com', 'x-csrf-token': before.csrf, 'content-type': 'application/json' }, body: JSON.stringify({ id, cardId: card.id, action }) });
    expect((await post('approve-first')).status).toBe(202);
    for (let i = 0; i < 100 && (await inside((_a, w) => w.list().filter(row => row.status === 'active'))).length === 0; i++) await new Promise(resolve => setTimeout(resolve, 50));
    expect(await inside((_a, w) => w.list().filter(row => row.status === 'active'))).toHaveLength(1);
    const after = await get();
    expect(after.attention.some(row => row.id === card.id)).toBe(false);
    expect(after.messages.find(row => row.id === card.id)?.open).toBe(false);
    expect((await post('approve-first')).status).toBe(202);
    expect((await post('approve-stale')).status).toBe(409);
    expect(await inside((_a, w) => w.list().filter(row => row.status === 'active'))).toHaveLength(1);
  });
  it('model calls only emit a bound owner message; arbitrary actions/ordinary replies cannot apply it', async () => {
    await inside((_a, w) => { w.create({ ...create, id: 'history' }); w.cancel('history'); });
    await scriptModel(fauxAssistantMessage([fauxToolCall('create_pr_watch', { threadId: THREAD, url: URL, evidenceMode: 'statuses-only', basis: 'user_explicit' })], { stopReason: 'toolUse' }), fauxAssistantMessage([fauxText('This must not be used to claim creation.') ]));
    await postEvent(messageEvent({ text: `帮我盯住 ${URL}，仅看 commit statuses。` })); await waitRunsSettled(); await waitWhileOutboundPending();
    const card = (await ownerStub().outboundRows(100)).find(row => row.id.startsWith('prwatchapproval:'))!;
    expect(card).toBeDefined();
    const payload = JSON.parse(card.payload);
    expect(payload.card.text).toContain('确认前不会开始跟进');
    expect(payload.card.text).toContain('请使用专用确认／不执行按钮；文字回复不会执行。');
    expect(payload.card.text).not.toContain('也可以直接回复');
    expect(payload.card.text).toContain('未验证 Checks/Actions');
    const action = payload.card.buttons[0].action as string;
    expect(await inside((_a, w) => w.list().filter(row => row.status === 'active'))).toHaveLength(0);
    await click('some-other-message', action);
    await click(card.providerMsgId!, action.replace(':confirm', ':forged'));
    const qid = card.questionId!;
    await click(card.providerMsgId!, `ask:${qid}:0`);
    expect(await inside((_a, w) => w.list().filter(row => row.status === 'active'))).toHaveLength(0);
    const runsBefore = (await llmState()).runs.length;
    await inside((_a, _w, ledger) => { ledger.questions.insert({ qid: 'q_unrelated', threadId: THREAD, text: 'Unrelated decision' }); });
    await postEvent(messageEvent({ text: '同意，确认执行', parentId: card.providerMsgId! }));
    expect(await inside((_a, w, ledger) => ({ active: w.list().filter(row => row.status === 'active').length, other: ledger.questions.get('q_unrelated')!.status }))).toEqual({ active: 0, other: 'open' });
    expect((await llmState()).runs.length).toBe(runsBefore);
    expect((await click(card.providerMsgId!, action)).status).toBe(200);
    expect(await inside((_a, w) => w.list().filter(row => row.status === 'active'))).toHaveLength(1);
    await click(card.providerMsgId!, action);
    expect(await inside((_a, w) => w.list().filter(row => row.status === 'active'))).toHaveLength(1);
    expect((await llmState()).runs.length).toBe(runsBefore);
  });
});

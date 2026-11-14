// Scripted model tests exercise tool boundaries, not real-model intent recognition.
import { beforeEach, describe, expect, it } from 'vitest';
import { SELF, runInDurableObject } from 'cloudflare:test';
import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import type { Ledger } from '../src/ledger.ts';
import { buildStewardExtension, type StewardExtensionContext } from '../src/llm/extension.ts';
import type { PrWatchService, PrWatchDeps, PrWatchRow } from '../src/pr-watch.ts';
import { configureAndBind, messageEvent, modelRequests, ownerStub, postEvent, resetLedgerState, scriptModel, waitRunsSettled, waitWhileOutboundPending, llmState } from './helpers.ts';

const THREAD = 't_watch_tools';
const URL = 'https://github.com/example/project/pull/42';
const OTHER = 'https://github.com/example/project/pull/43';
const args = { threadId: THREAD, url: URL, evidenceMode: 'statuses-only', basis: 'user_explicit' };
async function inside<T>(fn: (ledger: Ledger, watches: PrWatchService) => T): Promise<T> {
  return runInDurableObject(ownerStub(), raw => {
    const ctx = raw as unknown as { ledger: Ledger; prWatches: PrWatchService };
    return fn(ctx.ledger, ctx.prWatches);
  });
}
async function history(id: string, url = URL, threadId = THREAD) {
  await inside((_ledger, watches) => {
    watches.create({ id, url, threadId, evidenceMode: 'statuses-only' }); watches.cancel(id);
  });
}
async function call(name: string, parameters: Parameters<typeof fauxToolCall>[1], text: string) {
  await scriptModel(fauxAssistantMessage([fauxToolCall(name, parameters)], { stopReason: 'toolUse' }),
    ...(['create_pr_watch', 'cancel_pr_watch'].includes(name) ? [] : [fauxAssistantMessage([fauxText('已处理。')])]));
  const response = await postEvent(messageEvent({ text }));
  expect(response.status).toBe(200);
  await waitRunsSettled();
}
async function active(): Promise<PrWatchRow[]> { return inside((_ledger, watches) => watches.list().filter(w => w.status === 'active')); }
async function results() { return JSON.stringify((await llmState()).raw) + (await modelRequests()).map(r => r.lastToolResult).join('\n'); }
async function confirmLatest(mode = 'statuses-only') {
  await waitWhileOutboundPending();
  const rows = (await ownerStub().outboundRows(100)).filter(row => row.id.startsWith('prwatchapproval:'));
  let card: (typeof rows)[number] | undefined;
  for (const row of rows) if (await inside(ledger => ledger.questions.get(row.questionId ?? '')?.status === 'open')) { card = row; break; }
  expect(card).toBeDefined();
  if (!card) throw new Error('missing approval card');
  expect(JSON.parse(card.payload).card.text).toContain(mode === 'statuses-only' ? '仅 commit statuses' : 'check runs + commit statuses');
  const response = await SELF.fetch('https://example.com/api/actions', { method: 'POST', headers: { authorization: 'Bearer test-server-key-not-a-secret', 'content-type': 'application/json' }, body: JSON.stringify({ cardMsgId: card.providerMsgId, action: JSON.parse(card.payload).card.buttons[0].action }) });
  expect(response.status).toBe(200);
}

beforeEach(async () => {
  await resetLedgerState(); await configureAndBind('ou_owner');
  await inside((ledger, watches) => {
    ledger.threads.create({ threadId: THREAD, title: '测试事项甲乙', goal: 'Follow this PR without a worker' });
    (watches as unknown as { deps: PrWatchDeps }).deps.read = async () => ({ ok: true, evidence: { head: 'a'.repeat(40), state: 'waiting', checks: 0, failed: 0, pending: 0 } });
  });
  await history('old-pr');
});

describe('owner-controlled PR watch tools', () => {
  it('creates via explicit owner URL and unique stored association, no worker or follow-up', async () => {
    await call('create_pr_watch', args, `帮我盯住 ${URL}，仅看 commit statuses，通过后通知，不要改代码。`);
    expect(await active()).toHaveLength(0); await confirmLatest();
    expect(await active()).toHaveLength(1);
    expect((await active())[0]).toMatchObject({ threadId: THREAD, url: URL, evidenceMode: 'statuses-only' });
    const snap = await ownerStub().debugSnapshot();
    expect(snap.threads.flatMap(t => t.workers)).toHaveLength(0);
    expect(snap.followups).toHaveLength(0);
    expect(await results()).toContain('未验证 Checks/Actions');
  });

  it('reuses the unique PR of an explicitly named Thread without a URL', async () => {
    const { url, ...withoutUrl } = args;
    await call('create_pr_watch', withoutUrl, '盯住测试事项甲乙的这个 PR，仅看 commit statuses。');
    await confirmLatest();
    expect(await active()).toHaveLength(1);
    expect((await active())[0]?.url).toBe(URL);
  });

  it('does not guess when a Thread has multiple PRs or the owner gives multiple links', async () => {
    await history('other-pr', OTHER);
    await call('create_pr_watch', args, '盯住测试事项甲乙的这个 PR，仅看 commit statuses。');
    expect(await active()).toHaveLength(0);
    expect(await results()).toContain('ask_user');
    await call('create_pr_watch', args, `盯住 ${URL} 和 ${OTHER}，仅看 commit statuses。`);
    expect(await active()).toHaveLength(0);
  });

  it('refuses a model-invented link or a URL different from the owner instruction', async () => {
    await call('create_pr_watch', { ...args, url: OTHER }, `盯住 ${URL}，仅看 commit statuses。`);
    expect(await active()).toHaveLength(0);
    expect(await results()).toContain('不能凭模型补链接');
  });

  it('refuses ambiguous cross-Thread associations', async () => {
    await inside(ledger => { ledger.threads.create({ threadId: 't_second', title: '另一个事项', goal: 'Different matter' }); });
    await history('second-history', URL, 't_second');
    await call('create_pr_watch', args, `盯住 ${URL}，仅看 commit statuses。`);
    expect(await active()).toHaveLength(0);
    expect(await results()).toContain('所属 Thread 不明确');
  });

  it('duplicate Thread titles do not authorize choosing one by name', async () => {
    await inside(ledger => { ledger.threads.create({ threadId: 't_same_title', title: '测试事项甲乙', goal: 'Different matter with same title' }); });
    await history('same-title-history', URL, 't_same_title');
    const { url, ...withoutUrl } = args;
    await call('create_pr_watch', withoutUrl, '盯住测试事项甲乙的 PR，仅看 commit statuses。');
    expect(await active()).toHaveLength(0);
  });

  it('limited scope needs owner words; full scope remains available without silent downgrades', async () => {
    await call('create_pr_watch', args, `盯住 ${URL} 的完整 CI。`);
    expect(await active()).toHaveLength(0);
    await call('create_pr_watch', { ...args, evidenceMode: 'checks-and-statuses' }, `盯住 ${URL} 的 check runs 和 commit statuses。`);
    await confirmLatest('checks-and-statuses');
    expect(await active()).toHaveLength(1);
    expect((await active())[0]?.evidenceMode).toBe('checks-and-statuses');
  });

  it('CI plus commit statuses requests full evidence, never a limited downgrade', async () => {
    await call('create_pr_watch', { ...args, evidenceMode: 'checks-and-statuses' }, `持续盯住 ${URL} 的 CI 和 commit statuses，有变化提醒我。`);
    await confirmLatest('checks-and-statuses');
    expect(await active()).toHaveLength(1);
    expect((await active())[0]!.evidenceMode).toBe('checks-and-statuses');
    expect(await results()).toContain('等待用户点击专用确认卡');
  });

  it.each([
    `帮我看下 ${URL} 的 CI。`,
    `现在只查这一次 ${URL}，不要创建持续跟进。`,
    `持续盯住 ${URL}，但只看一次 commit statuses。`,
    `Check ${URL} only once; do not create a watch.`,
    'https://github.com/watch/monitor/pull/42 帮我看下状态。',
  ])('cannot create persistent work from absent/negated/one-shot intent: %s', async text => {
    await call('create_pr_watch', args, text);
    expect(await active()).toHaveLength(0);
    expect(await results()).toContain('未明确授权持续 PR 跟进');
  });

  it.each(['not only commit statuses', 'no statuses-only'])('does not invert an English scope negation: %s', async negation => {
    const text = `Watch ${URL} for full CI, ${negation}.`;
    await call('create_pr_watch', args, text);
    expect(await active()).toHaveLength(0);
    expect(await results()).toContain('验证范围与用户原话不一致');
    await call('create_pr_watch', { ...args, evidenceMode: 'checks-and-statuses' }, text);
    await confirmLatest('checks-and-statuses');
    expect(await active()).toHaveLength(1);
    expect((await active())[0]!.evidenceMode).toBe('checks-and-statuses');
  });

  it('one-shot wording cannot re-arm an existing watch under the reuse path', async () => {
    await call('create_pr_watch', args, `持续盯住 ${URL}，仅看 commit statuses。`);
    await confirmLatest();
    const first = (await active())[0]!;
    await call('create_pr_watch', args, `现在只看一次 ${URL} 的 commit statuses，不要持续跟进。`);
    expect(await active()).toHaveLength(1);
    expect((await active())[0]).toMatchObject({ id: first.id, expiresAt: first.expiresAt, status: 'active', intervalMs: first.intervalMs });
    expect(await results()).toContain('未明确授权持续 PR 跟进');
  });

  it('negated CI does not authorize full scope without clarifying statuses-only', async () => {
    await call('create_pr_watch', { ...args, evidenceMode: 'checks-and-statuses' }, `持续盯住 ${URL} 的 commit statuses，CI 不用管。`);
    expect(await active()).toHaveLength(0);
    expect(await results()).toContain('明确是仅 commit statuses');
  });

  it('repeating an owner request reuses the active watch without extending expiry', async () => {
    await call('create_pr_watch', args, `盯住 ${URL}，仅看 commit statuses。`);
    await confirmLatest();
    const first = (await active())[0]!;
    await call('create_pr_watch', args, `继续盯住 ${URL}，仅看 commit statuses。`);
    await confirmLatest();
    expect(await active()).toHaveLength(1);
    expect((await active())[0]).toMatchObject({ id: first.id, expiresAt: first.expiresAt });
    expect(await results()).toContain('不会创建第二条');
  });

  it('forged context provenance cannot replace the recorded owner turn for a proposal', async () => {
    await runInDurableObject(ownerStub(), async raw => {
      const instance = raw as unknown as { stewardToolContext(): StewardExtensionContext; prWatches: PrWatchService };
      const extension = buildStewardExtension({ ...instance.stewardToolContext(),
        currentRun: async () => ({ operationId: 'user:replay-fixture', kind: 'user', provenance: 'user:replay-fixture', routedThreadId: THREAD }),
        checkProvenanceRef: async () => true,
        ownerMessageText: async () => `盯住 ${URL}，仅看 commit statuses，一小时后到期。`,
      });
      const tool = extension.tools!.find(t => t.name === 'create_pr_watch') as unknown as {
        execute(args: Record<string, unknown>, api: { taskId: string }): Promise<{ isError?: boolean }>;
      };
      const input = { ...args, expiresInMinutes: 60 };
      expect((await tool.execute(input, { taskId: 'replay_fixture' })).isError).toBe(true);
      expect(instance.prWatches.list().filter(w => w.status === 'active')).toHaveLength(0);
    });
  });

  it('listing returns known targets and watch state through get_thread', async () => {
    await call('get_thread', { threadId: THREAD }, '看看测试事项甲乙');
    expect(await results()).toContain('pullRequests');
    expect(await results()).toContain(URL);
    await call('list_pr_watches', { threadId: THREAD }, '有哪些 PR 跟进？');
    expect(await results()).toContain('old-pr');
  });

  it('cancels exactly one owner-selected watch, but does not guess among multiple matches', async () => {
    await call('create_pr_watch', args, `盯住 ${URL}，仅看 commit statuses。`);
    await confirmLatest();
    const first = (await active())[0]!;
    await inside((_ledger, watches) => { watches.create({ id: 'another', url: URL, threadId: THREAD, evidenceMode: 'statuses-only' }); });
    await call('cancel_pr_watch', { watchId: first.id, basis: 'user_explicit' }, `不用盯住 ${URL} 了。`);
    expect(await active()).toHaveLength(2);
    expect(await results()).toContain('ask_user');
    await call('cancel_pr_watch', { watchId: first.id, basis: 'user_explicit' }, `取消跟进 ${first.id}`);
    expect(await active()).toHaveLength(2);
    await confirmLatest();
    expect((await active()).map(w => w.id)).toEqual(['another']);
  });

  it('a PR attempt cannot be followed by a worker or duplicate scheduled fallback in the same turn', async () => {
    await scriptModel(
      fauxAssistantMessage([
        fauxToolCall('create_pr_watch', args),
        fauxToolCall('set_followup', { threadId: THREAD, afterMinutes: 30, reason: 'unwanted duplicate' }),
        fauxToolCall('start_worker', { repoRef: 'repo-a', newTitle: 'unwanted fallback', prompt: 'poll PR', basis: 'user_explicit', mode: 'readonly' }),
      ], { stopReason: 'toolUse' }),
    );
    await postEvent(messageEvent({ text: `盯住 ${URL}，仅看 commit statuses。` }));
    await waitRunsSettled();
    expect(await active()).toHaveLength(0);
    await confirmLatest();
    expect(await active()).toHaveLength(1);
    const snap = await ownerStub().debugSnapshot();
    expect(snap.followups).toHaveLength(0);
    expect(snap.threads.flatMap(t => t.workers)).toHaveLength(0);
    expect(await results()).toContain('不能再派 worker');
    // A later owner turn can still request an unrelated follow-up.
    await call('set_followup', { threadId: THREAD, afterMinutes: 60, reason: 'new owner turn' }, '一小时后回看测试事项甲乙');
    expect((await ownerStub().debugSnapshot()).followups).toHaveLength(1);
  });

  it('a scheduled/event run cannot create a PR commission', async () => {
    await call('set_followup', { threadId: THREAD, afterMinutes: 60, reason: 'event authorization test' }, '一小时后回看测试事项甲乙');
    const followup = (await ownerStub().debugSnapshot()).followups[0]!;
    await scriptModel(fauxAssistantMessage([fauxToolCall('create_pr_watch', args)], { stopReason: 'toolUse' }), fauxAssistantMessage([fauxText('结束。')]));
    await ownerStub().fireFollowup({ followupId: followup.followupId });
    await waitRunsSettled();
    expect(await active()).toHaveLength(0);
    expect(await results()).toContain('事件/例行运行不能创建');
  });
});

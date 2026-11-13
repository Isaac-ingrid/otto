// Scripted model tests exercise tool boundaries, not real-model intent recognition.
import { beforeEach, describe, expect, it } from 'vitest';
import { runInDurableObject } from 'cloudflare:test';
import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import type { Ledger } from '../src/ledger.ts';
import { buildStewardExtension, type StewardExtensionContext } from '../src/llm/extension.ts';
import type { PrWatchService, PrWatchDeps, PrWatchRow } from '../src/pr-watch.ts';
import { configureAndBind, messageEvent, modelRequests, ownerStub, postEvent, resetLedgerState, scriptModel, waitRunsSettled } from './helpers.ts';

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
  await scriptModel(fauxAssistantMessage([fauxToolCall(name, parameters)], { stopReason: 'toolUse' }), fauxAssistantMessage([fauxText('已处理。')]));
  const response = await postEvent(messageEvent({ text }));
  expect(response.status).toBe(200);
  await waitRunsSettled();
}
async function active(): Promise<PrWatchRow[]> { return inside((_ledger, watches) => watches.list().filter(w => w.status === 'active')); }
async function results() { return (await modelRequests()).map(r => r.lastToolResult).join('\n'); }

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
    expect(await active()).toHaveLength(1);
    expect((await active())[0]?.evidenceMode).toBe('checks-and-statuses');
  });

  it('repeating an owner request reuses the active watch without extending expiry', async () => {
    await call('create_pr_watch', args, `盯住 ${URL}，仅看 commit statuses。`);
    const first = (await active())[0]!;
    await call('create_pr_watch', args, `继续盯住 ${URL}，仅看 commit statuses。`);
    expect(await active()).toHaveLength(1);
    expect((await active())[0]).toMatchObject({ id: first.id, expiresAt: first.expiresAt });
    expect(await results()).toContain('不重复创建');
  });

  it('replaying a tool task with relative expiry neither renews it nor resurrects cancellation', async () => {
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
      expect((await tool.execute(input, { taskId: 'replay_fixture' })).isError).not.toBe(true);
      const first = instance.prWatches.list().find(w => w.id === 'pw_replay_fixture')!;
      await new Promise(resolve => setTimeout(resolve, 10));
      expect((await tool.execute(input, { taskId: 'replay_fixture' })).isError).not.toBe(true);
      expect(instance.prWatches.list().find(w => w.id === first.id)!.expiresAt).toBe(first.expiresAt);
      instance.prWatches.cancel(first.id);
      await tool.execute(input, { taskId: 'replay_fixture' });
      expect(instance.prWatches.list().find(w => w.id === first.id)!.status).toBe('cancelled');
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
    const first = (await active())[0]!;
    await inside((_ledger, watches) => { watches.create({ id: 'another', url: URL, threadId: THREAD, evidenceMode: 'statuses-only' }); });
    await call('cancel_pr_watch', { watchId: first.id, basis: 'user_explicit' }, `不用盯住 ${URL} 了。`);
    expect(await active()).toHaveLength(2);
    expect(await results()).toContain('ask_user');
    await call('cancel_pr_watch', { watchId: first.id, basis: 'user_explicit' }, `取消跟进 ${first.id}`);
    expect((await active()).map(w => w.id)).toEqual(['another']);
  });

  it('a PR attempt cannot be followed by a worker or duplicate scheduled fallback in the same turn', async () => {
    await scriptModel(
      fauxAssistantMessage([fauxToolCall('create_pr_watch', args)], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxToolCall('set_followup', { threadId: THREAD, afterMinutes: 30, reason: 'unwanted duplicate' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxToolCall('start_worker', { repoRef: 'repo-a', newTitle: 'unwanted fallback', prompt: 'poll PR', basis: 'user_explicit', mode: 'readonly' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxText('结束。')]),
    );
    await postEvent(messageEvent({ text: `盯住 ${URL}，仅看 commit statuses。` }));
    await waitRunsSettled();
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

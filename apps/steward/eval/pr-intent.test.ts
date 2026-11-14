// Offline only: scripted faux choices test observation/scoring, NOT real-model intent accuracy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { buildStewardModels } from '../src/llm/models.ts';
import { INTENT_CASES, PR, THREAD, observeIntentCalls, runIntentCase, scoreIntent } from './pr-intent.ts';

const create = (mode = 'checks-and-statuses') => ({ threadId: THREAD, evidenceMode: mode, basis: 'user_explicit' });
const ask = { question: '请确认要跟进哪个 PR、所属事项及验证范围？', candidates: [] };
async function scripted(id: number, calls: Array<[string, Parameters<typeof fauxToolCall>[1]]>, reply = '工具执行结果如上。') {
  const built = buildStewardModels({ provider: 'faux', modelId: 'faux-1', explicit: true }, undefined);
  built.faux!.setSteps([
    ...calls.map(([name, args]) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: 'toolUse' })),
    fauxAssistantMessage([fauxText(reply)]),
  ]);
  return runIntentCase(INTENT_CASES.find(c => c.id === id)!, built.models, { model: { provider: 'faux', modelId: 'faux-1' }, thinkingLevel: 'off' });
}

test('all twelve intent fixtures have an offline acceptance path', { timeout: 90000 }, async t => {
  for (const c of INTENT_CASES) await t.test(`intent ${c.id}: ${c.expected.kind}`, async () => {
    let calls: Array<[string, Parameters<typeof fauxToolCall>[1]]>;
    if (c.expected.kind === 'create') calls = [['get_thread', { threadId: THREAD }], ['create_pr_watch', { ...create(c.expected.mode), ...(c.id === 1 ? { url: PR } : {}) }]];
    else if (c.expected.kind === 'list') calls = [['list_pr_watches', {}]];
    else if (c.expected.kind === 'cancel') calls = [['list_pr_watches', {}], ['cancel_pr_watch', { watchId: 'pw_x', basis: 'user_explicit' }]];
    else if (c.expected.kind === 'ask') calls = [['ask_user', ask]];
    else if (c.expected.kind === 'refusal') calls = [['create_pr_watch', { ...create(), url: PR }], ['ask_user', ask]];
    else calls = [['start_worker', { threadId: THREAD, repoRef: 'repo-eval', mode: 'readonly', basis: 'user_explicit', prompt: '只读查询这个 PR 当前状态，只查一次，不写代码、不创建定时任务。' }]];
    const result = await scripted(c.id, calls);
    assert.equal(result.verdict, 'pass', JSON.stringify(result.observation));
    assert.deepEqual(result.observation.issues, []);
    assert.deepEqual(result.observation.toolCalls.map(call => call.name), calls.map(([name]) => name));
    if (c.expected.kind === 'create') {
      assert.equal(result.watches.filter(w => w.status === 'active').length, 1);
      assert.equal(result.watches.find(w => w.status === 'active')!.evidenceMode, c.expected.mode);
      assert.equal(result.effects.dispatches.length, 0, 'watch creation is not a worker dispatch in intent measurement');
      if (c.expected.mode === 'statuses-only') assert.match(result.observation.toolCalls.at(-1)!.result!.text, /未验证 Checks\/Actions/);
    }
    if (c.expected.kind === 'cancel') {
      assert.equal(result.watches.find(w => w.id === 'pw_x')!.status, 'cancelled');
      assert.equal(result.watches.find(w => w.id === 'pw_other')!.status, 'active');
    }
  });
});

test('rejected PR creation and policy-blocked fallbacks all appear as attempts', async () => {
  const result = await scripted(9, [
    ['create_pr_watch', { ...create(), url: PR }],
    ['start_worker', { threadId: THREAD, repoRef: 'repo-eval', mode: 'readonly', basis: 'user_explicit', prompt: 'poll PR' }],
    ['set_followup', { threadId: THREAD, afterMinutes: 30, reason: 'fallback' }],
    ['create_routine', { instruction: 'poll PR', scheduleKind: 'interval' }],
  ]);
  assert.equal(result.verdict, 'wrong_tool');
  assert.equal(result.observation.toolCalls.length, 4);
  assert.ok(result.observation.toolCalls.every(call => call.result?.isError === true));
  assert.equal(result.effects.dispatches.length, 0);
  assert.equal(result.watches.filter(w => w.status === 'active').length, 0);
});

test('scope downgrade is detected even when production refuses the attempted call', async () => {
  const result = await scripted(10, [['create_pr_watch', create('statuses-only')]]);
  assert.equal(result.verdict, 'scope_mismatch');
  assert.equal(result.observation.toolCalls[0]!.result!.isError, true);
  assert.equal(result.watches.filter(w => w.status === 'active').length, 0);
});

test('ambiguous target must ask, not guess a watch even if the tool refuses', async () => {
  const result = await scripted(8, [['create_pr_watch', { ...create(), url: PR }]]);
  assert.equal(result.verdict, 'missed_ask');
  assert.equal(result.observation.toolCalls[0]!.result!.isError, true);
});

test('one-shot watch attempts remain selection failures but the tool prevents persistence', async () => {
  for (const id of [11, 12]) {
    const result = await scripted(id, [['create_pr_watch', create(id === 12 ? 'statuses-only' : 'checks-and-statuses')]]);
    assert.equal(result.verdict, 'unexpected_persistence');
    // The model chose wrongly, but the production guard must now reject the write.
    // A REAL-model run must still demonstrate correct tool choice; refusal is not a pass.
    assert.equal(result.observation.toolCalls[0]!.result!.isError, true);
    assert.match(result.observation.toolCalls[0]!.result!.text, /未明确授权持续 PR 跟进/);
    assert.equal(result.watches.filter(w => w.status === 'active').length, 0);
  }
});

test('prose mentioning tools is not a tool call or functional pass', async () => {
  const result = await scripted(1, [], '已创建 create_pr_watch，后续会提醒你。');
  assert.equal(result.verdict, 'not_verified');
  assert.deepEqual(result.observation.toolCalls, []);
});

test('refusal without ask remains explicitly pending human prose review', async () => {
  const result = await scripted(9, [['create_pr_watch', { ...create(), url: PR }]], '未创建，服务暂时不可用。');
  assert.equal(result.verdict, 'refusal_observed');
});

test('missing and duplicate result boundaries cannot become a passing measurement', () => {
  const message = fauxAssistantMessage([fauxToolCall('list_pr_watches', {})], { stopReason: 'toolUse' });
  const incomplete = observeIntentCalls([message]);
  assert.match(incomplete.issues.join('\n'), /missing result/);
  assert.equal(scoreIntent(INTENT_CASES[3]!, incomplete), 'incomplete');
  assert.match(observeIntentCalls([message, message]).issues.join('\n'), /duplicate call id/);
});

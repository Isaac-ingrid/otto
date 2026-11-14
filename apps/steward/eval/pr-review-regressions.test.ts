// Independent-review repros. Faux choices force adversarial tool sequences; no paid calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { buildStewardModels } from '../src/llm/models.ts';
import { INTENT_CASES, PR, THREAD, runIntentCase, type IntentCase } from './pr-intent.ts';
const create = (extra = {}) => ({ threadId: THREAD, url: PR, evidenceMode: 'checks-and-statuses', basis: 'user_explicit', ...extra });
async function scripted(c: IntentCase, calls: Array<[string, Parameters<typeof fauxToolCall>[1]]>) {
  const built = buildStewardModels({ provider: 'faux', modelId: 'faux-1', explicit: true }, undefined);
  built.faux!.setSteps([...calls.map(([name, args]) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: 'toolUse' })), fauxAssistantMessage([fauxText('Done.')])]);
  return runIntentCase(c, built.models, { model: { provider: 'faux', modelId: 'faux-1' }, thinkingLevel: 'off' });
}
const fixture = (id: number) => structuredClone(INTENT_CASES.find(c => c.id === id)!);

test('review P1-1: listing/retaining/negating cancellation cannot cancel an active watch', async () => {
  for (const text of ['现在都在盯哪些 PR？', '不要取消 pw_x', '保留 pw_x，继续盯着', 'Do not cancel pw_x', 'Keep watch pw_x']) {
    const c = { ...fixture(5), text };
    const result = await scripted(c, [['list_pr_watches', {}], ['cancel_pr_watch', { watchId: 'pw_x', basis: 'user_explicit' }]]);
    assert.equal(result.watches.find(w => w.id === 'pw_x')!.status, 'active', text);
    assert.equal(result.observation.toolCalls.at(-1)!.result!.isError, true, text);
  }
});

test('review P1-2: every positive English intent verb has a negative counterpart', async () => {
  for (const verb of ['follow', 'track', 'watch', 'monitor', 'keep tracking', 'notify me when it passes']) {
    const result = await scripted({ ...fixture(1), text: `Do not ${verb} ${PR}.` }, [['create_pr_watch', create()]]);
    assert.equal(result.watches.filter(w => w.status === 'active').length, 0, verb);
    assert.equal(result.observation.toolCalls[0]!.result!.isError, true, verb);
  }
});

test('review P1-3: invented find_threads query cannot disambiguate PR ownership', async () => {
  for (const query of [THREAD, 'api-gateway 重构']) {
    const result = await scripted(fixture(8), [['find_threads', { query }], ['create_pr_watch', create()]]);
    assert.equal(result.watches.filter(w => w.status === 'active').length, 0, query);
    assert.equal(result.observation.toolCalls.at(-1)!.result!.isError, true, query);
  }
});

test('review P1-4: Chinese not-only never authorizes limited evidence', async () => {
  for (const prefix of ['不仅看', '不只看', '不只是看', '不仅仅看']) {
    const c = { ...fixture(10), text: `持续盯住 ${PR}，${prefix} commit statuses，也要看 CI。` };
    const limited = await scripted(c, [['create_pr_watch', create({ evidenceMode: 'statuses-only' })]]);
    assert.equal(limited.watches.filter(w => w.status === 'active').length, 0, prefix);
    const full = await scripted(c, [['create_pr_watch', create()]]);
    assert.equal(full.watches.filter(w => w.status === 'active').length, 1, prefix);
    assert.equal(full.watches.find(w => w.status === 'active')!.evidenceMode, 'checks-and-statuses');
  }
});

test('review P2-5: readonly start followed by a write-mode relay is not a one-shot pass', async () => {
  const result = await scripted(fixture(11), [
    ['start_worker', { threadId: THREAD, repoRef: 'repo-eval', mode: 'readonly', basis: 'user_explicit', prompt: 'Check the PR once.' }],
    ['send_to_worker', { workerId: 'w_gw_refactor', text: 'Keep polling this PR every minute', intent: 'after', basis: 'user_explicit' }],
  ]);
  assert.notEqual(result.verdict, 'pass');
  assert.equal(result.observation.toolCalls[1]!.result!.isError, false, 'the relay really reached the old stub');
});

test('review P2-6: local watch backend enforces production intervals', async () => {
  for (const intervalSeconds of [1, 59, 3601, 60.5]) {
    const result = await scripted(fixture(1), [['create_pr_watch', create({ intervalSeconds })]]);
    assert.equal(result.watches.filter(w => w.status === 'active').length, 0, String(intervalSeconds));
    assert.notEqual(result.verdict, 'pass');
    assert.equal(result.observation.toolCalls[0]!.result!.isError, true);
  }
});

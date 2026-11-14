// New independent re-review repros for fixed be11d13. Intentionally red until corrected.
// They do not change any routing/intent labels and use only a scripted faux provider.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { buildStewardModels } from '../src/llm/models.ts';
import { INTENT_CASES, PR, THREAD, runIntentCase } from './pr-intent.ts';
async function probe(id: number, text: string, name: string, args: Parameters<typeof fauxToolCall>[1]) {
  const built = buildStewardModels({ provider: 'faux', modelId: 'faux-1', explicit: true }, undefined);
  built.faux!.setSteps([fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: 'toolUse' }), fauxAssistantMessage([fauxText('Done.')])]);
  const c = { ...structuredClone(INTENT_CASES.find(c => c.id === id)!), text };
  return runIntentCase(c, built.models, { model: { provider: 'faux', modelId: 'faux-1' }, thinkingLevel: 'off' });
}
const create = { threadId: THREAD, url: PR, evidenceMode: 'checks-and-statuses', basis: 'user_explicit' };
test('follow-up P1: explicit Chinese refusal cannot create a watch', async () => {
  const result = await probe(1, `不要持续关注 ${PR}。`, 'create_pr_watch', create);
  assert.equal(result.watches.filter(w => w.status === 'active').length, 0);
});
test('follow-up P1: inventory question cannot create a watch', async () => {
  const { url, ...withoutUrl } = create;
  const result = await probe(4, '现在都在盯哪些 PR？', 'create_pr_watch', withoutUrl);
  assert.equal(result.watches.filter(w => w.status === 'active').length, 0);
});
test('follow-up P1: stopping a worker is not cancelling its PR watch', async () => {
  const result = await probe(5, '停止 worker，继续盯这个 PR。', 'cancel_pr_watch', { watchId: 'pw_x', basis: 'user_explicit' });
  assert.equal(result.watches.find(w => w.id === 'pw_x')!.status, 'active');
});

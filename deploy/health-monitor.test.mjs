import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transition } from './health-monitor.mjs';

test('deduplicates failures, reminds after six hours, emits recovery once', () => {
  let seq = 0;
  const id = () => String(++seq);
  const first = transition({}, ['otto active', 'otto active'], 0, id);
  assert.equal(first.pending.length, 1);
  assert.equal(first.pending[0].event, 'failure');
  assert.deepEqual(transition(first, ['otto active'], 15 * 60_000, id), first);
  const reminder = transition(first, ['otto active'], 6 * 3600_000, id);
  assert.equal(reminder.pending.at(-1).event, 'reminder');
  const recovery = transition(reminder, [], 7 * 3600_000, id);
  assert.equal(recovery.pending.at(-1).event, 'recovery');
  assert.deepEqual(transition(recovery, [], 8 * 3600_000, id), recovery);
  assert.equal(first.pending.length, 1); // does not mutate the durable input
});

test('retains stable pending notice IDs across outage/restart and a new incident', () => {
  let seq = 0;
  const id = () => String(++seq);
  const failed = transition({}, ['nginx active'], 0, id);
  const restarted = transition(JSON.parse(JSON.stringify(failed)), [], 60_000, id);
  assert.equal(restarted.pending[0].id, failed.pending[0].id);
  assert.deepEqual(restarted.pending.map(e => e.event), ['failure', 'recovery']);
  const again = transition(restarted, ['nginx active'], 120_000, id);
  assert.equal(again.pending.at(-1).event, 'failure');
  assert.notEqual(again.pending.at(-1).id, failed.pending[0].id);
});

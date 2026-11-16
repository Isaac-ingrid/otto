import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { cases, accepted } from './run-tla.mjs';
import { root } from './toolchain.mjs';

const result = (status, stdout) => ({ status, stdout, signal: null });
test('baseline requires real completion and an empty exploration queue', () => {
  const baseline = cases[0];
  assert.equal(accepted(baseline, result(0, 'Model checking completed. No error has been found.\n1545 distinct states found, 0 states left on queue.')), true);
  assert.equal(accepted(baseline, result(0, 'Starting...')), false);
  assert.equal(accepted(baseline, result(150, 'Model checking completed. No error has been found.\n0 states left on queue')), false);
});
test('negative controls require their precise counterexample, not any failure', () => {
  for (const [index, status, text] of [[1, 12, 'Invariant AckAfterPersist is violated.'], [2, 13, 'Temporal property AllResolved was violated.']]) {
    const control = cases[index];
    assert.equal(accepted(control, result(status, `${text}\nState 1: <Initial predicate>`)), true);
    assert.equal(accepted(control, result(150, 'Parsing or semantic analysis failed')), false);
    assert.equal(accepted(control, result(0, `${text}\nState 1:`)), false);
    assert.equal(accepted(control, result(status, text)), false);
    assert.equal(accepted(control, { ...result(status, `${text}\nState 1:`), signal: 'SIGTERM' }), false);
  }
});
test('unknown CLI inputs fail before setup, model checking or app launch', () => {
  const run = spawnSync(process.execPath, [resolve(root, 'scripts/verification/verify-otto.mjs'), 'run', 'conversation', '--unknown'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, OTTO_JAVA: 'must-not-run-this' },
  });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /Usage:/);
  assert.doesNotMatch(run.stdout, /Evidence retained|PASS/);
});

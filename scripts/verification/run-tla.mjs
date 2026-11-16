import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { root, cache, toolchain, javaEnv, sha256 } from './toolchain.mjs';

export const cases = [
  { name: 'baseline', config: 'EventDelivery.cfg', exit: 0, text: /Model checking completed\. No error has been found\./ },
  { name: 'ack-before-persist', config: 'AckBeforePersist.cfg', exit: 12, text: /Invariant AckAfterPersist is violated\./ },
  { name: 'poison-event', config: 'PoisonEvent.cfg', exit: 13, text: /Temporal property AllResolved was violated\./ },
];
export function accepted(test, result) {
  return !result.error && !result.signal && result.status === test.exit && test.text.test(result.stdout ?? '') &&
    (test.exit === 0 ? /0 states left on queue/.test(result.stdout) : /State 1:/.test(result.stdout));
}
export function runFormal(output) {
  const tools = toolchain();
  mkdirSync(output, { recursive: true });
  const inputs = ['formal/EventDelivery.tla', ...cases.map(test => `formal/${test.config}`), 'scripts/verification/toolchain.json', 'scripts/verification/run-tla.mjs'];
  const fingerprint = () => Object.fromEntries(inputs.map(file => [file, sha256(readFileSync(resolve(root, file)))]));
  const before = fingerprint();
  const boundOf = config => {
    const source = readFileSync(resolve(root, 'formal', config), 'utf8');
    const value = name => {
      const match = new RegExp(`^\\s*${name}\\s*=\\s*(\\d+)\\s*$`, 'm').exec(source);
      if (!match) throw new Error(`Missing literal bound ${name} in ${config}`);
      return Number(match[1]);
    };
    return { workers: 1, events: value('MaxEvents'), environmentalCrashes: value('MaxCrashes') };
  };
  const bound = boundOf('EventDelivery.cfg');
  const results = [];
  for (const test of cases) {
    const dir = resolve(output, test.name);
    mkdirSync(dir, { recursive: true });
    copyFileSync(resolve(root, 'formal/EventDelivery.tla'), resolve(dir, 'EventDelivery.tla'));
    copyFileSync(resolve(root, 'formal', test.config), resolve(dir, 'Model.cfg'));
    const scratch = mkdtempSync(join(cache, 'tlc-states-'));
    try {
      const args = ['-XX:+UseParallelGC', '-Xmx512m', '-cp', tools.jar, 'tlc2.TLC', '-workers', '1', '-seed', '0', '-fp', '0',
        '-config', 'Model.cfg', '-metadir', scratch, 'EventDelivery'];
      const result = spawnSync(tools.java, args, { cwd: dir, encoding: 'utf8', env: javaEnv(), timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
      writeFileSync(resolve(dir, 'tlc.log'), `${result.stdout ?? ''}${result.stderr ?? ''}`);
      const ok = accepted(test, result);
      results.push({ name: test.name, bound: boundOf(test.config), expectedExit: test.exit, actualExit: result.status, signal: result.signal,
        error: result.error?.message ?? null, accepted: ok, command: [tools.java, ...args],
        states: /([\d,]+) distinct states found/.exec(result.stdout ?? '')?.[1] ?? null });
      console.log(`${ok ? 'PASS' : 'FAIL'} ${test.name}: exit ${result.status}, expected ${test.exit}`);
    } finally {
      // Only our model-checking scratch is disposable. Logs/configs/traces survive.
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  const after = fingerprint();
  const inputStable = JSON.stringify(before) === JSON.stringify(after);
  const summary = { model: 'EventDelivery', bound,
    node: process.version, javaVersion: tools.javaVersion, jarSha256: tools.jarSha256,
    inputs: before, inputStable, results, passed: inputStable && results.every(result => result.accepted) };
  writeFileSync(resolve(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  return summary;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length !== 2) throw new Error('Usage: node scripts/verification/run-tla.mjs');
  const output = resolve(root, '.verification/evidence', `formal-${randomUUID()}`);
  try {
    const result = runFormal(output);
    console.log(`Evidence: ${output}`);
    process.exitCode = result.passed ? 0 : 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

// Real adapter/process parsing with scripted CLI stand-ins, never real provider calls.
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentAdapter, StartSpec } from '../src/agent.ts';
import type { AgentModelObservation } from '@isaac2ingrid/protocol';
import { fakeClaudeAdapter, fakePiAdapter, tmpDir, writeClaudeScenario, writeScenario } from './helpers.ts';
let dir: string;
let adapter: AgentAdapter | undefined;
const workerId = 'w-model-adapter';
beforeEach(() => { dir = tmpDir('otto-adapter-model'); });
afterEach(async () => {
  await adapter?.stopProcess(workerId);
  await new Promise(resolve => setTimeout(resolve, 100));
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});
const spec = (dir: string, observation: AgentModelObservation[], model?: string): StartSpec => ({ workerId, threadId: 'model', cwd: dir, mode: 'write', prompt: 'scripted test', commandId: 'model-test', model, onModelObserved: value => observation.push(value) });
describe('CLI model observations', () => {
  it('records pi provider/id only from get_state', async () => {
    const scenario = writeScenario(dir, 'state', [[]], undefined, { model: { provider: 'provider', id: 'actual' } });
    adapter = fakePiAdapter(dir, scenario);
    const observed: AgentModelObservation[] = [];
    await adapter.start(spec(dir, observed, 'provider/actual'));
    expect(observed).toEqual([expect.objectContaining({ id: 'provider/actual', source: 'state' })]);
  });
  it('rejects pi resolving a different model before delivering the task prompt', async () => {
    const scenario = writeScenario(dir, 'mismatch', [[]], undefined, { model: { provider: 'provider', id: 'different' } });
    const log = join(dir, 'prompts.log');
    adapter = fakePiAdapter(dir, scenario, { FAKE_PI_LOG: log });
    await expect(adapter.start(spec(dir, [], 'provider/requested'))).rejects.toMatchObject({ code: 'model_mismatch' });
    expect(existsSync(log) ? readFileSync(log, 'utf8') : '').toBe('');
  });
  it('does not manufacture an actual model when pi state omits it', async () => {
    adapter = fakePiAdapter(dir, writeScenario(dir, 'unknown', [[]]));
    const observed: AgentModelObservation[] = [];
    await adapter.start(spec(dir, observed, 'provider/requested'));
    expect(observed).toEqual([]);
  });
  it('keeps a Claude alias request distinct from the concrete system/init model', async () => {
    adapter = fakeClaudeAdapter(dir, writeClaudeScenario(dir, 'init', [[{ delayMs: 1000 }]], { model: 'claude-concrete-version' }));
    const observed: AgentModelObservation[] = [];
    await adapter.start(spec(dir, observed, 'sonnet'));
    expect(observed).toEqual([expect.objectContaining({ id: 'claude-concrete-version', source: 'init' })]);
  });
});

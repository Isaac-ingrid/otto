// Real adapter/process parsing with scripted CLI stand-ins, never real provider calls.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentAdapter, RawAdapterEvent, StartSpec } from '../src/agent.ts';
import type { AgentModelObservation } from '@isaac2ingrid/protocol';
import { ClaudeAdapter } from '../src/claude-adapter.ts';
import { fakeClaudeAdapter, fakePiAdapter, tmpDir, waitFor, writeClaudeScenario, writeScenario } from './helpers.ts';

let dir: string;
let adapter: AgentAdapter | undefined;
const workerId = 'w-model-adapter';

beforeEach(() => {
  dir = tmpDir('otto-adapter-model');
});

afterEach(async () => {
  await adapter?.stopProcess(workerId);
  await new Promise(resolve => setTimeout(resolve, 100));
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const spec = (dir: string, observation: AgentModelObservation[], model?: string): StartSpec => ({
  workerId,
  threadId: 'model',
  cwd: dir,
  mode: 'write',
  prompt: 'scripted test',
  commandId: 'model-test',
  model,
  onModelObserved: value => observation.push(value),
});

describe('CLI model observations and Claude model validation', () => {
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

  it('advertises launch model selection on ClaudeAdapter and validates opaque Claude model IDs', () => {
    const claude = new ClaudeAdapter({ stateDir: dir, workerLogsDir: null });
    expect(claude.modelCatalog).toMatchObject({
      status: 'ready',
      capabilities: {
        selection: 'launch',
        discovery: 'suggested',
        customModelInput: true,
        actualModelObservation: true,
        thinkingSelection: false,
        idFormat: 'opaque',
      },
    });
    expect(claude.modelCatalog.models.map(m => m.id)).toEqual(['sonnet', 'opus', 'haiku', 'opusplan']);
    expect(claude.validateModel('sonnet')).toBe(true);
    expect(claude.validateModel('sonnet[1m]')).toBe(true);
    expect(claude.validateModel('claude-sonnet-4-5@20250929')).toBe(true);
    expect(claude.validateModel('sonnet[')).toBe(false);
    expect(claude.validateModel('--help')).toBe(false);
  });

  it('keeps a Claude alias request distinct from the concrete system/init model and extracts result.errors on invalid model runs', async () => {
    const scenario = writeClaudeScenario(
      dir,
      'init-and-err',
      [
        [
          {
            result: {
              subtype: 'error_during_execution',
              is_error: true,
              result: '',
              errors: ["There's an issue with the selected model (nonexistent-model). It may not exist or you may not have access to it."],
            },
          },
        ],
      ],
      { model: 'claude-concrete-version' },
    );
    adapter = fakeClaudeAdapter(dir, scenario);
    const events: RawAdapterEvent[] = [];
    adapter.on('worker-event', e => events.push(e));
    const observed: AgentModelObservation[] = [];
    await adapter.start(spec(dir, observed, 'sonnet'));
    expect(observed).toEqual([expect.objectContaining({ id: 'claude-concrete-version', source: 'init' })]);

    await waitFor(() => events.some(e => e.type === 'settled'), 5_000, 'claude error settle');
    const settled = events.find(e => e.type === 'settled');
    expect(settled).toMatchObject({
      outcome: 'error',
      errorClass: 'unknown',
      errorMessage: expect.stringContaining('issue with the selected model'),
    });
  });

  it('preserves pre-init stdout result error detail when claude exits before emitting system/init', async () => {
    const preInitFailRunner = join(dir, 'pre-init-error.mjs');
    writeFileSync(
      preInitFailRunner,
      [
        'process.stdin.resume();',
        'process.stdin.on("end", () => {',
        '  process.stdout.write(JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["Invalid model identifier: bogus-model"] }) + "\\n");',
        '  process.exit(1);',
        '});',
      ].join('\n'),
      'utf8',
    );
    adapter = new ClaudeAdapter({
      stateDir: dir,
      command: [process.execPath, preInitFailRunner],
      workerLogsDir: null,
    });
    await expect(adapter.start(spec(dir, [], 'bogus-model'))).rejects.toMatchObject({
      code: 'startup_failed',
      message: expect.stringContaining('Invalid model identifier: bogus-model'),
    });
  });
});

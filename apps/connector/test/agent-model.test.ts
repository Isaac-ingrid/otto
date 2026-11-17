// Generic fake adapter: no real process, CLI login, network, git or model call.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentModelCatalog } from '@isaac2ingrid/protocol';
import type { AgentAdapter, RawAdapterEvent, StartSpec } from '../src/agent.ts';
import { LocalStore } from '../src/store.ts';
import { WorkerManager } from '../src/worker-manager.ts';
import { classifyError } from '../src/adjudication.ts';

const catalog: AgentModelCatalog = { capabilities: { selection: 'launch', discovery: 'suggested', customModelInput: true, actualModelObservation: true, thinkingSelection: false }, models: [{ id: 'suggested', name: 'Suggested' }], status: 'ready' };
class FakeAdapter implements AgentAdapter {
  readonly kind = 'codex' as const; // Extensibility test; not a real Codex implementation.
  readonly capabilities = { steer: true, followUp: true, interrupt: true, resume: true, history: false, images: false, structuredReport: true, readonly: true };
  modelCatalog: AgentModelCatalog | undefined = catalog;
  specs: StartSpec[] = [];
  observes = true;
  resumeCalls = 0;
  live = new Set<string>();
  listener: ((event: RawAdapterEvent) => void) | undefined;
  on(_event: 'worker-event', listener: (event: RawAdapterEvent) => void) { this.listener = listener; }
  async start(spec: StartSpec) {
    this.specs.push(spec);
    this.live.add(spec.workerId);
    if (this.observes) spec.onModelObserved?.({ id: `observed-${this.specs.length}`, source: 'state', observedAt: this.specs.length });
    return { workerId: spec.workerId, sessionId: spec.workerId, cwd: spec.cwd };
  }
  async send() { return {}; }
  async interrupt() { return { returned: [] }; }
  async resume() { this.resumeCalls++; }
  isRunning(id: string) { return this.live.has(id); }
  isStreaming() { return false; }
  async stopProcess(id: string) {
    if (!this.live.delete(id)) return;
    this.listener?.({ type: 'process_exit', workerId: id, code: 0, signal: null, unexpected: false });
  }
}
let dir: string;
let store: LocalStore;
let adapter: FakeAdapter;
let manager: WorkerManager;
let events: Record<string, unknown>[];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'otto-model-contract-'));
  store = new LocalStore(join(dir, 'state.sqlite'));
  store.addRepo({ repoId: 'repo', name: 'plain', path: dir, capability: { kind: 'plain' } });
  adapter = new FakeAdapter();
  events = [];
  manager = new WorkerManager({ store, stateDir: dir, adapters: [adapter], recovery: { autoResumeBackoffMs: 10 }, emit: (_id, fields) => { events.push(fields); } });
});
afterEach(async () => {
  await manager.stopProcess('w-model').catch(() => {});
  manager.stop();
  await new Promise(resolve => setTimeout(resolve, 0));
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
const args = (model?: string) => ({ workerId: 'w-model', threadId: 'thread', repoId: 'repo', mode: 'readonly' as const, prompt: 'test', agent: 'codex', ...(model === undefined ? {} : { model }) });

describe('worker model selection contract', () => {
  it('allows defaults on an old adapter, but gates explicit model requests before any launch or row', async () => {
    adapter.modelCatalog = undefined;
    await expect(manager.startWorker('blocked', args('custom'))).rejects.toMatchObject({ code: 'unsupported_model' });
    expect(store.listWorkers()).toEqual([]);
    expect(adapter.specs).toEqual([]);
    await manager.startWorker('default', args());
    expect(adapter.specs[0]?.model).toBeUndefined();
    expect(store.getWorker('w-model')?.requestedModel).toBeNull();
  });
  it('accepts unlisted IDs only when the adapter permits custom suggestions', async () => {
    await manager.startWorker('custom', args('custom/provider-model'));
    expect(adapter.specs[0]?.model).toBe('custom/provider-model');
    expect(store.getWorker('w-model')).toMatchObject({ requestedModel: 'custom/provider-model', modelSource: 'override' });
    expect(events.find(event => event.type === 'started')).toMatchObject({ requestedModel: 'custom/provider-model', lastObservedModel: { id: 'observed-1' } });
  });
  it('rejects malformed raw arguments instead of silently dropping the model override', async () => {
    for (const model of [42, '', '--help', 'a b', 'a\nb', 'x'.repeat(257)]) {
      await expect(manager.handleCommand('invalid', 'start_worker', { ...args(), model })).rejects.toMatchObject({ code: 'invalid_model' });
    }
    expect(store.listWorkers()).toEqual([]);
  });
  it('enforces complete catalogs and keeps the first model request immutable', async () => {
    adapter.modelCatalog = { ...catalog, capabilities: { ...catalog.capabilities, discovery: 'enumerated' } };
    await expect(manager.startWorker('bad', args('unlisted'))).rejects.toMatchObject({ code: 'unsupported_model' });
    await manager.startWorker('listed', args('suggested'));
    await expect(manager.startWorker('change', args())).rejects.toMatchObject({ code: 'model_mismatch' });
    store.upsertWorker({ workerId: 'w-model', threadId: 'thread', repoId: 'repo', mode: 'readonly', state: 'idle', requestedModel: 'replacement' });
    expect(store.getWorker('w-model')?.requestedModel).toBe('suggested');
  });
  it('does not automatically resume or replace the model after model_not_found', async () => {
    await manager.startWorker('model-not-found', args('configured/bad-model'));
    const message = '404: {"message":"模型不存在","type":"model_not_found","code":"model_not_found"}';
    adapter.listener?.({ type: 'settled', workerId: 'w-model', outcome: 'error', errorClass: classifyError(message), errorMessage: message });
    // Longer than the test-configured 10ms backoff: an accidental retry must become visible.
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(adapter.specs).toHaveLength(1);
    expect(adapter.resumeCalls).toBe(0);
    expect(store.countResumes('w-model')).toBe(0);
    expect(store.getWorker('w-model')).toMatchObject({ requestedModel: 'configured/bad-model', lastOutcome: 'error' });
    expect(events.some(event => event.type === 'report')).toBe(false);
    expect(events.find(event => event.type === 'settled')).toMatchObject({ outcome: 'error', errorMessage: message });
  });
  it('keeps an unknown first-launch model unknown when a later resume can observe a model', async () => {
    adapter.observes = false;
    await manager.startWorker('unknown-first', args());
    await manager.stopProcess('w-model');
    await new Promise(resolve => setTimeout(resolve, 0));
    adapter.observes = true;
    store.setWorkerState('w-model', 'lost');
    await manager.handleCommand('known-later', 'resume', { workerId: 'w-model' });
    expect(store.getWorker('w-model')?.launchObservedModel).toBeNull();
    expect(JSON.parse(store.getWorker('w-model')!.lastObservedModel!)).toMatchObject({ id: 'observed-2' });
  });
  it('keeps the model snapshot across reopening the SQLite store and rebuilding the manager', async () => {
    await manager.startWorker('persist', { ...args('persistent-model'), modelSource: 'task-default' });
    await manager.stopProcess('w-model');
    await new Promise(resolve => setTimeout(resolve, 0));
    manager.stop();
    store.close();
    store = new LocalStore(join(dir, 'state.sqlite'));
    manager = new WorkerManager({ store, stateDir: dir, adapters: [adapter], emit: (_id, fields) => { events.push(fields); } });
    store.setWorkerState('w-model', 'lost');
    await manager.handleCommand('after-restart', 'resume', { workerId: 'w-model' });
    expect(adapter.specs[1]?.model).toBe('persistent-model');
    expect(store.getWorker('w-model')).toMatchObject({ requestedModel: 'persistent-model', modelSource: 'task-default' });
  });
  for (const path of ['send-relaunch', 'resume', 'stall'] as const) it(`preserves the request on ${path} and separates launch/latest observations`, async () => {
    await manager.startWorker('initial', { ...args('chosen'), modelSource: 'task-default' });
    if (path === 'stall') {
      await (manager as unknown as { handleStallStrike(id: string, strike: 1, why: string): Promise<void> }).handleStallStrike('w-model', 1, 'test');
    } else {
      await manager.stopProcess('w-model');
      await new Promise(resolve => setTimeout(resolve, 0));
      store.setWorkerState('w-model', path === 'resume' ? 'lost' : 'idle');
      await manager.handleCommand('continuation', path === 'resume' ? 'resume' : 'send', { workerId: 'w-model', text: 'continue', intent: 'auto' });
    }
    expect(adapter.specs).toHaveLength(2);
    expect(adapter.specs[1]?.model).toBe('chosen');
    const worker = store.getWorker('w-model')!;
    expect(worker.modelSource).toBe('task-default');
    expect(JSON.parse(worker.launchObservedModel!)).toMatchObject({ id: 'observed-1' });
    expect(JSON.parse(worker.lastObservedModel!)).toMatchObject({ id: 'observed-2' });
  });
});

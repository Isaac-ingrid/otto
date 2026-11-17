import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PiAdapter } from '../src/pi-adapter.ts';
import { ConnectorApp } from '../src/connector-app.ts';
import { LocalStore } from '../src/store.ts';
import { startMockSteward } from './mock-steward.ts';
import { waitFor } from './helpers.ts';
const fake = fileURLToPath(new URL('./fake-pi.mjs', import.meta.url));
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'otto-model-catalog-test-')); roots.push(root);
  const script = join(root, 'scenario.json'), rpc = join(root, 'rpc.jsonl'), argv = join(root, 'argv.jsonl');
  const options = { stateDir: root, command: [process.execPath, fake], workerLogsDir: null,
    env: { FAKE_PI_SCRIPT: script, FAKE_PI_RPC_LOG: rpc, FAKE_PI_ARGV_LOG: argv, FAKE_PI_SESSIONS_DIR: join(root, 'sessions') } };
  return { root, script, rpc, argv, options, adapter: new PiAdapter(options) };
}
describe('pi local model discovery (no prompt or upstream model probe)', () => {
  it('advertises startup discovery and answers live metadata refresh without a worker or durable command', async () => {
    const s = setup(); writeFileSync(s.script, JSON.stringify({ models: [{ provider: 'mine', id: 'first', name: 'First' }] }));
    const store = new LocalStore(join(s.root, 'connector.sqlite')), mock = startMockSteward();
    const port = await mock.listen();store.saveCredentials({ serverUrl: `http://127.0.0.1:${port}`, deviceId: mock.deviceId, token: mock.token });
    const app = new ConnectorApp({ stateDir: s.root, store, adapter: s.adapter });
    try {
      await app.start();await mock.waitHello();
      expect(mock.hellos()[0]?.agents).toEqual([expect.objectContaining({ kind: 'pi', modelCatalog: expect.objectContaining({ source: 'local-pi', models: [{ id: 'mine/first', name: 'First' }] }) })]);
      writeFileSync(s.script, JSON.stringify({ discoveryDelayMs: 80, models: [{ provider: 'mine', id: 'second', name: 'Second' }] }));
      mock.sendAgentModels('refresh-1');mock.sendAgentModels('refresh-2');
      expect(await waitFor(() => mock.modelsFor('refresh-2'))).toMatchObject({ ok: false, code: 'busy' });
      expect(await waitFor(() => mock.modelsFor('refresh-1'))).toMatchObject({ ok: true, catalog: { models: [{ id: 'mine/second', name: 'Second' }] } });
      expect(store.listWorkers()).toEqual([]);
      expect(store.database.prepare('SELECT COUNT(*) AS n FROM command').get()).toEqual({ n: 0 });
      expect(mock.events()).toEqual([]);
      expect(readFileSync(s.rpc, 'utf8')).not.toContain('prompt');
    } finally { app.stop();await mock.close();store.close(); }
  });
  it('uses local runtime results, strips unrelated/secret fields, and cleans its scratch process', async () => {
    const s = setup();
    writeFileSync(s.script, JSON.stringify({ model: { provider: 'mine', id: 'flash', apiKey: 'synthetic-secret' }, models: [
      { provider: 'mine', id: 'flash', name: 'Local Flash', headers: { authorization: 'synthetic-secret' } },
      { provider: 'mine', id: 'other', name: 'Other' }, { provider: 'mine', id: 'flash', name: 'duplicate' },
      { provider: 'bad provider', id: 'invalid', name: 'Invalid' },
    ] }));
    expect(s.adapter.modelCatalog.models).toEqual([]);
    const catalog = await s.adapter.refreshModels();
    expect(catalog).toMatchObject({ status: 'ready', source: 'local-pi', defaultModel: 'mine/flash', truncated: false,
      models: [{ id: 'mine/flash', name: 'Local Flash' }, { id: 'mine/other', name: 'Other' }] });
    const rpcs = readFileSync(s.rpc, 'utf8').trim().split('\n').map(x => JSON.parse(x));
    expect(rpcs.map(x => x.type).sort()).toEqual(['get_available_models', 'get_state']);
    expect(existsSync(rpcs[0].cwd)).toBe(false);
    const argv = JSON.parse(readFileSync(s.argv, 'utf8').trim());
    for (const flag of ['--offline', '--no-session', '--no-extensions', '--no-mcp', '--no-context-files', '--no-approve']) expect(argv).toContain(flag);
    expect(argv).not.toContain('--model');
    expect(JSON.stringify(catalog)).not.toContain('synthetic-secret');
    expect(readFileSync(join(s.root, 'model-catalog-pi.json'), 'utf8')).not.toContain('synthetic-secret');
    expect(existsSync(join(s.root, 'sessions'))).toBe(false);
  });
  it('persists only local metadata; failures and restarts retain a visibly stale snapshot, not library suggestions', async () => {
    const s = setup(); writeFileSync(s.script, JSON.stringify({ model: { provider: 'mine', id: 'a' }, models: [{ provider: 'mine', id: 'a', name: 'A' }] }));
    const good = await s.adapter.refreshModels();
    const restarted = new PiAdapter(s.options);
    expect(restarted.modelCatalog).toMatchObject({ status: 'unavailable', models: good.models, discoveredAt: good.discoveredAt });
    writeFileSync(s.script, JSON.stringify({ discoveryError: true }));
    const failed = await restarted.refreshModels();
    expect(failed).toMatchObject({ status: 'unavailable', models: good.models, defaultModel: 'mine/a', discoveredAt: good.discoveredAt });
    expect(failed.attemptedAt).toBeGreaterThanOrEqual(good.attemptedAt!);
    writeFileSync(join(s.root, 'model-catalog-pi.json'), 'corrupt');
    expect(new PiAdapter(s.options).modelCatalog.models).toEqual([]);
  });
  it('coalesces concurrent reads and labels truncation rather than claiming an exhaustive whitelist', async () => {
    const s = setup(); writeFileSync(s.script, JSON.stringify({ discoveryDelayMs: 100, models: Array.from({ length: 105 }, (_, i) => ({ provider: 'mine', id: `m${i}`, name: `Model ${i}` })) }));
    const a = s.adapter.refreshModels(), b = s.adapter.refreshModels(); expect(a).toBe(b);
    const result = await a;
    expect(result.models).toHaveLength(100); expect(result.truncated).toBe(true);
    expect(result.capabilities).toMatchObject({ discovery: 'suggested', customModelInput: true });
    expect(readFileSync(s.argv, 'utf8').trim().split('\n')).toHaveLength(1);
  });
  it('cancels an in-flight probe without recreating removed connector state or leaving its scratch directory', async () => {
    const s = setup();writeFileSync(s.script, JSON.stringify({ discoveryDelayMs: 5000 }));
    const pending = s.adapter.refreshModels();await waitFor(() => existsSync(s.rpc));
    const scratch = JSON.parse(readFileSync(s.rpc, 'utf8').trim().split('\n')[0]!).cwd;
    s.adapter.stopDiscovery();rmSync(s.root, { recursive: true, force: true });
    expect(await pending).toMatchObject({ status: 'unavailable', models: [] });
    expect(existsSync(scratch)).toBe(false);expect(existsSync(s.root)).toBe(false);
  });
  it('bounds timeouts and permits following default or advanced input without fabricating a list', async () => {
    const s = setup(); writeFileSync(s.script, JSON.stringify({ discoveryDelayMs: 500 }));
    const adapter = new PiAdapter({ ...s.options, getStateTimeoutMs: 100 });
    expect(await adapter.refreshModels()).toMatchObject({ status: 'unavailable', models: [], capabilities: { selection: 'launch', customModelInput: true } });
  });
});

import { SELF, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Steward } from '../src/steward.ts';
import type { AgentModelCatalog } from '@isaac2ingrid/protocol';
import { configureAndBind, connectAndHello, ownerStub, pairDevice, resetLedgerState, webLogin } from './helpers.ts';

const catalog: AgentModelCatalog = { capabilities: { selection: 'launch', discovery: 'suggested', customModelInput: true, actualModelObservation: true, thinkingSelection: false }, models: [{ id: 'model-a', name: 'Model A' }], status: 'ready' };
let sockets: WebSocket[];
beforeEach(async () => {
  sockets = []; await resetLedgerState(); await configureAndBind('ou_owner');
  await runInDurableObject(ownerStub(), (instance: Steward) => {
    (instance as unknown as { connectorProto: { setModelDiscoveryTimeoutForTest(ms: number): void } }).connectorProto.setModelDiscoveryTimeoutForTest(15_000);
  });
});
afterEach(async () => { for (const socket of sockets) socket.close(); await resetLedgerState(); });
async function machine(name: string, modern = true, modelCatalog = catalog) {
  const paired = await pairDevice(name);
  const connected = await connectAndHello(paired.deviceId, paired.token, 1, {
    agents: [{ kind: 'codex', version: 'fake', capabilities: {}, ...(modern ? { modelCatalog } : {}) }],
    repos: [{ repoId: `${name}-repo`, name: 'repo', path: '/repo', defaultBranch: 'main', remote: '' }],
  });
  sockets.push(connected.ws);
  return { ...paired, ...connected };
}
async function browser() {
  const cookie = await webLogin();
  const { csrf } = await (await SELF.fetch('https://example.com/app/api/workspace', { headers: { cookie } })).json() as { csrf: string };
  const set = (deviceId: string, model: unknown, token = csrf) => SELF.fetch('https://example.com/app/api/settings/agent-model', { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': token }, body: JSON.stringify({ deviceId, agent: 'codex', model }) });
  const settings = async () => (await SELF.fetch('https://example.com/app/api/settings', { headers: { cookie } })).json() as Promise<{ localAgentModels: { deviceId: string; model: string | null; catalog: AgentModelCatalog | null }[] }>;
  const refresh = (deviceId: string, token = csrf, origin: string | null = 'https://example.com') => SELF.fetch('https://example.com/app/api/settings/agent-model/refresh', { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': token, ...(origin ? { origin } : {}) }, body: JSON.stringify({ deviceId, agent: 'codex' }) });
  return { set, settings, refresh };
}

describe('machine × agent model defaults', () => {
  it('refreshes metadata only through the owning live connection, retaining the chosen task default', async () => {
    const local: AgentModelCatalog = { ...catalog, source: 'local-pi', refreshable: true, discoveredAt: 100, models: [{ id: 'mine/a', name: 'A' }] };
    const a = await machine('local-a', true, local), b = await machine('local-b', true, local);
    const { refresh, settings, set } = await browser();
    expect((await refresh(a.deviceId, 'wrong')).status).toBe(403);
    expect((await refresh(a.deviceId, undefined, null)).status).toBe(403);
    await set(a.deviceId, 'mine/a');
    const pending = refresh(a.deviceId);
    const request = await a.reader.nextWhere(frame => frame.t === 'agent_models');
    expect((await refresh(a.deviceId)).status).toBe(429);
    const fresh = { ...local, discoveredAt: 200, defaultModel: 'mine/b', models: [{ id: 'mine/b', name: 'B' }], apiKey: 'synthetic-secret' };
    b.ws.send(JSON.stringify({ t: 'agent_models_result', re: request.id, ok: true, catalog: { ...fresh, defaultModel: 'foreign/model' } }));
    b.ws.send(JSON.stringify({ t: 'ping', id: 'foreign-fence' }));await b.reader.nextWhere(frame => frame.t === 'pong' && frame.re === 'foreign-fence');
    expect((await settings()).localAgentModels.find(e => e.deviceId === a.deviceId)?.catalog?.discoveredAt).toBe(100);
    a.ws.send(JSON.stringify({ t: 'agent_models_result', re: request.id, ok: true, catalog: fresh }));
    expect(await (await pending).json()).toEqual({ ok: true });
    const entries = (await settings()).localAgentModels;
    expect(entries.find(e => e.deviceId === a.deviceId)).toMatchObject({ model: 'mine/a', catalog: { discoveredAt: 200, defaultModel: 'mine/b' } });
    expect(entries.find(e => e.deviceId === b.deviceId)?.catalog?.discoveredAt).toBe(100);
    expect(JSON.stringify(entries)).not.toContain('synthetic-secret');
    expect((await ownerStub().debugSnapshot()).threads).toHaveLength(0);
  });

  it('keeps cached local metadata on timeout and ignores late results', async () => {
    const local: AgentModelCatalog = { ...catalog, source: 'local-pi', refreshable: true, discoveredAt: 100 };
    const m = await machine('timeout', true, local), { refresh, settings } = await browser();
    await runInDurableObject(ownerStub(), (instance: Steward) => {
      (instance as unknown as { connectorProto: { setModelDiscoveryTimeoutForTest(ms: number): void } }).connectorProto.setModelDiscoveryTimeoutForTest(40);
    });
    const pending = refresh(m.deviceId), request = await m.reader.nextWhere(frame => frame.t === 'agent_models');
    expect(await (await pending).json()).toEqual({ ok: false, code: 'discovery_unavailable' });
    m.ws.send(JSON.stringify({ t: 'agent_models_result', re: request.id, ok: true, catalog: { ...local, discoveredAt: 200 } }));
    m.ws.send(JSON.stringify({ t: 'ping', id: 'late-fence' }));await m.reader.nextWhere(frame => frame.t === 'pong' && frame.re === 'late-fence');
    expect((await settings()).localAgentModels[0]?.catalog).toMatchObject({ status: 'unavailable', discoveredAt: 100, models: local.models });
  });

  it('returns an explicit failure rather than hanging when catalog persistence fails', async () => {
    const m = await machine('store-failure', true, { ...catalog, source: 'local-pi', refreshable: true }), { refresh } = await browser();
    await runInDurableObject(ownerStub(), (instance: Steward) => {
      const sql = (instance as unknown as { sql: (s: TemplateStringsArray, ...v: unknown[]) => unknown }).sql.bind(instance);
      sql`CREATE TRIGGER fail_model_catalog BEFORE UPDATE OF modelCatalogs ON sh_machine BEGIN SELECT RAISE(ABORT, 'catalog test failure'); END`;
      sql`CREATE TRIGGER fail_model_log BEFORE INSERT ON sh_channel_log BEGIN SELECT RAISE(ABORT, 'audit test failure'); END`;
    });
    try {
      const pending = refresh(m.deviceId), request = await m.reader.nextWhere(frame => frame.t === 'agent_models');
      m.ws.send(JSON.stringify({ t: 'agent_models_result', re: request.id, ok: true, catalog }));
      expect(await (await pending).json()).toEqual({ ok: false, code: 'discovery_unavailable' });
    } finally {
      await runInDurableObject(ownerStub(), (instance: Steward) => {
        const sql = (instance as unknown as { sql: (s: TemplateStringsArray, ...v: unknown[]) => unknown }).sql.bind(instance);
        sql`DROP TRIGGER fail_model_catalog`;
        sql`DROP TRIGGER fail_model_log`;
      });
    }
  });

  it('does not probe legacy connectors and cancels reads when the machine disconnects', async () => {
    const legacy = await machine('old'), { refresh } = await browser();
    expect((await refresh(legacy.deviceId)).status).toBe(409);
    const m = await machine('gone', true, { ...catalog, source: 'local-pi', refreshable: true });
    const pending = refresh(m.deviceId);await m.reader.nextWhere(frame => frame.t === 'agent_models');m.ws.close();
    expect(await (await pending).json()).toEqual({ ok: false, code: 'discovery_unavailable' });
  });
  it('is owner/CSRF guarded and only allows default mode for old connectors', async () => {
    const m = await machine('legacy', false);
    const { set, settings } = await browser();
    expect((await set(m.deviceId, 'model-a', 'wrong')).status).toBe(403);
    expect((await set(m.deviceId, 'model-a')).status).toBe(409);
    expect((await set(m.deviceId, null)).status).toBe(200);
    expect((await set(m.deviceId, '--help')).status).toBe(400);
    expect((await settings()).localAgentModels).toEqual([expect.objectContaining({ deviceId: m.deviceId, model: null, catalog: null })]);
  });

  it('persists independent machine defaults and allows custom IDs only by declared capability', async () => {
    const a = await machine('a');
    const b = await machine('b');
    const { set, settings } = await browser();
    expect((await set(a.deviceId, 'custom/model')).status).toBe(200);
    expect((await set(b.deviceId, 'model-b')).status).toBe(200);
    expect((await settings()).localAgentModels).toEqual(expect.arrayContaining([
      expect.objectContaining({ deviceId: a.deviceId, model: 'custom/model' }), expect.objectContaining({ deviceId: b.deviceId, model: 'model-b' }),
    ]));
    await set(a.deviceId, null);
    expect((await settings()).localAgentModels.find(entry => entry.deviceId === b.deviceId)?.model).toBe('model-b');
  });

  it('freezes the resolved default on the worker and command; duplicate dispatch ignores a later default', async () => {
    const m = await machine('a');
    const { set } = await browser();
    await set(m.deviceId, 'model-a');
    const input = { prompt: 'do the task', repoRef: 'repo', newTitle: 'models', agent: 'codex', cmdId: 'model-dedup' };
    const first = await ownerStub().dispatchForTest(input);
    expect(first.kind).toBe('dispatched');
    const command = await m.reader.nextWhere(frame => frame.t === 'cmd');
    expect(command.args).toMatchObject({ model: 'model-a', modelSource: 'task-default' });
    await set(m.deviceId, 'model-b');
    const replay = await ownerStub().dispatchForTest(input);
    expect(replay).toMatchObject({ workerId: (first as { workerId: string }).workerId, created: false });
    const snapshot = await ownerStub().debugSnapshot();
    expect(snapshot.threads[0]!.workers[0]).toMatchObject({ requestedModel: 'model-a', modelSource: 'task-default', lastObservedModel: null });
    const workerId = (first as { workerId: string }).workerId;
    m.ws.send(JSON.stringify({ t: 'events', id: 'observed', batch: [{ workerId, seq: 1, ts: Date.now(), type: 'started', sessionId: workerId,
      launchObservedModel: { id: 'actual-model-a', source: 'init', observedAt: 1 }, lastObservedModel: { id: 'actual-model-a', source: 'init', observedAt: 1 } }] }));
    await m.reader.nextWhere(frame => frame.t === 'events_ack');
    await expect.poll(async () => (await ownerStub().debugSnapshot()).threads[0]!.workers[0]?.lastObservedModel?.id).toBe('actual-model-a');
    const continuation = await ownerStub().dispatchForTest({ prompt: 'continue', repoRef: 'repo', threadId: (first as { threadId: string }).threadId, agent: 'codex' });
    expect(continuation).toMatchObject({ continuation: { action: 'resume' } });
    expect((await ownerStub().debugSnapshot()).threads[0]!.workers[0]?.requestedModel).toBe('model-a');
    const override = await ownerStub().dispatchForTest({ prompt: 'explicit override', repoRef: 'repo', threadId: (first as { threadId: string }).threadId, agent: 'codex', model: 'model-c' });
    expect(override).toMatchObject({ continuation: { action: 'new_session', reason: 'model_switch' } });
    expect((await ownerStub().debugSnapshot()).threads[0]!.workers).toEqual(expect.arrayContaining([expect.objectContaining({ requestedModel: 'model-c', modelSource: 'override' })]));
  });

  it('keeps an offline command frozen even if its task default changes', async () => {
    const m = await machine('offline');
    const { set } = await browser();
    await set(m.deviceId, 'model-a');
    await runInDurableObject(ownerStub(), (instance: Steward) => {
      (instance as unknown as { ledger: { machines: { setOnline(id: string, online: boolean): void } } }).ledger.machines.setOnline(m.deviceId, false);
    });
    expect((await ownerStub().dispatchForTest({ prompt: 'offline task', repoRef: 'repo', newTitle: 'offline model', agent: 'codex', cmdId: 'model-offline' })).kind).toBe('asked_offline');
    await set(m.deviceId, 'model-b');
    await runInDurableObject(ownerStub(), (instance: Steward) => {
      const sql = (instance as unknown as { sql: (s: TemplateStringsArray, ...v: unknown[]) => { payload: string }[] }).sql.bind(instance);
      const row = sql`SELECT payload FROM outbox WHERE cmdId = 'model-offline'`[0]!;
      expect(JSON.parse(row.payload)).toMatchObject({ model: 'model-a', modelSource: 'task-default' });
    });
  });
});

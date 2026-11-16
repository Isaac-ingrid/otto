// Candidate lifecycle over real SQLite and crypto. Only the provider network boundary is
// scripted where success/in-flight timing is needed; real providers are never contacted.
import { SELF, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ModelConfigStore } from '../src/model-config.ts';
import { ownerStub, webLogin } from './helpers.ts';

const candidate = { provider: 'openai-compatible', modelId: 'candidate', baseUrl: 'https://gateway.invalid/v1', apiKey: 'candidate-secret', headers: { 'X-Test': 'header-secret' }, thinkingLevel: 'auto' as const, importedModelIds: ['candidate', 'imported'] };
type Internals = { modelConfigStore: ModelConfigStore; testingModel: boolean };
const internals = (instance: unknown) => instance as Internals;
async function reset() {
  await ownerStub().channelLogEntries(1);
  await runInDurableObject(ownerStub(), (_instance, state) => {
    for (const table of ['sh_model_draft', 'sh_model', 'sh_provider_key', 'sh_saved_model', 'sh_verified_model', 'sh_model_thinking_probe']) state.storage.sql.exec(`DELETE FROM ${table}`);
  });
}
beforeEach(reset);
afterEach(reset);
async function browser() {
  const cookie = await webLogin();
  const workspace = await (await SELF.fetch('https://example.com/app/api/workspace', { headers: { cookie } })).json() as { csrf: string };
  const post = (path: string, body: unknown, csrf = workspace.csrf) => SELF.fetch(`https://example.com/app/api/settings/model${path}`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify(body) });
  const settings = async () => (await SELF.fetch('https://example.com/app/api/settings', { headers: { cookie } })).json() as Promise<{ modelDrafts: Record<string, unknown>[] }>;
  return { post, settings };
}

describe('sealed model candidate lifecycle', () => {
  it('persists only a sealed snapshot; fresh settings exposes status but no secret or headers', async () => {
    await ownerStub().setModelConfig('deepseek', 'old-key', 'deepseek-flash');
    const { post, settings } = await browser();
    const saved = await (await post('', { ...candidate, autoTest: false })).json() as { draftId: string; revision: number };
    const fresh = await settings();
    expect(fresh.modelDrafts).toEqual([expect.objectContaining({ id: saved.draftId, revision: saved.revision, status: 'saved' })]);
    expect(JSON.stringify(fresh)).not.toContain('candidate-secret');
    expect(JSON.stringify(fresh)).not.toContain('header-secret');
    await runInDurableObject(ownerStub(), (_instance, state) => {
      const rows = state.storage.sql.exec('SELECT * FROM sh_model_draft').toArray();
      expect(JSON.stringify(rows)).not.toContain('candidate-secret');
      expect(JSON.stringify(rows)).not.toContain('header-secret');
    });
    expect(await ownerStub().modelConfig()).toMatchObject({ provider: 'deepseek', apiKey: 'old-key' });
    expect((await post('/draft', { id: saved.draftId, revision: saved.revision, action: 'delete' }, 'wrong')).status).toBe(403);
    expect((await post('/draft', { id: saved.draftId, revision: 0, action: 'activate' })).status).toBe(400);
    await post('/draft', { id: saved.draftId, revision: saved.revision, action: 'delete' });
    expect((await settings()).modelDrafts).toEqual([]);
  });

  it('cannot enable an untested candidate, and persists a real deterministic test failure', async () => {
    const { post, settings } = await browser();
    const saved = await (await post('', { provider: 'deepseek', modelId: 'not-in-catalog', apiKey: 'bad-key', autoTest: false })).json() as { draftId: string; revision: number };
    const action = { id: saved.draftId, revision: saved.revision };
    expect(await (await post('/draft', { ...action, action: 'activate' })).json()).toMatchObject({ activated: false });
    expect(await (await post('/draft', { ...action, action: 'verify' })).json()).toMatchObject({ status: 'verification_failed', testError: 'unknown_model' });
    expect((await settings()).modelDrafts).toEqual([expect.objectContaining({ status: 'verification_failed', testError: 'unknown_model' })]);
  });

  it('does not activate while another connection test owns the slot', async () => {
    const { post } = await browser();
    await runInDurableObject(ownerStub(), instance => { internals(instance).testingModel = true; });
    try {
      expect(await (await post('', { ...candidate, autoTest: true })).json()).toMatchObject({ activated: false, status: 'busy' });
    } finally {
      await runInDurableObject(ownerStub(), instance => { internals(instance).testingModel = false; });
    }
  });

  it('busy leaves a verified draft pending; a later explicit activation commits once, including imports', async () => {
    await runInDurableObject(ownerStub(), async (instance, state) => {
      const store = internals(instance).modelConfigStore;
      await store.setModelConfig('deepseek', 'old-key', 'deepseek-flash');
      const saved = await store.saveDraft(candidate);
      const original = store.verifyAndProbe;
      try {
        store.verifyAndProbe = async () => ({ ok: true, acceptedThinkingLevels: ['low', 'high'] });
        await store.verifyDraft(saved.draftId!, saved.revision!);
        expect(state.storage.sql.exec('SELECT * FROM sh_verified_model').toArray()).toEqual([]);
        expect(state.storage.sql.exec('SELECT * FROM sh_model_thinking_probe').toArray()).toEqual([]);
        expect(await store.activateDraft(saved.draftId!, saved.revision!, async () => true)).toMatchObject({ status: 'busy', activated: false });
        expect(await store.modelConfig()).toMatchObject({ provider: 'deepseek' });
        expect(store.drafts()[0]!.status).toBe('verified');
        expect(await store.activateDraft(saved.draftId!, saved.revision!, async () => false)).toMatchObject({ status: 'activated', activated: true });
        expect(await store.modelConfig()).toMatchObject({ provider: candidate.provider, apiKey: candidate.apiKey, baseUrl: candidate.baseUrl });
        expect(await store.headersFor(candidate.provider, candidate.modelId)).toEqual(candidate.headers);
        expect(store.savedModels().map(row => row.modelId)).toContain('imported');
        expect(await store.acceptedThinkingLevels(candidate.provider, candidate.modelId, candidate.baseUrl)).toEqual(['low', 'high']);
        expect((await store.activateDraft(saved.draftId!, saved.revision!, async () => false)).activated).toBe(false);
      } finally { store.verifyAndProbe = original; }
    });
  });

  it('a slow successful test cannot replace a newer selection or rotated inherited key', async () => {
    await runInDurableObject(ownerStub(), async instance => {
      const store = internals(instance).modelConfigStore;
      await store.setModelConfig(candidate.provider, 'inherited-key', 'old-model', candidate.baseUrl);
      const saved = await store.saveDraft({ ...candidate, apiKey: undefined });
      const original = store.verifyAndProbe;
      let release!: () => void;
      let started!: () => void;
      const entered = new Promise<void>(resolve => { started = resolve; });
      const wait = new Promise<void>(resolve => { release = resolve; });
      try {
        store.verifyAndProbe = async input => { expect(input.apiKey).toBe('inherited-key'); started(); await wait; return { ok: true }; };
        const test = store.verifyDraft(saved.draftId!, saved.revision!);
        await entered;
        await store.setModelConfig(candidate.provider, 'rotated-key', 'newer-model', candidate.baseUrl);
        release();
        await test;
        expect(await store.activateDraft(saved.draftId!, saved.revision!, async () => false)).toMatchObject({ status: 'conflict', activated: false });
        expect(await store.modelConfig()).toMatchObject({ modelId: 'newer-model', apiKey: 'rotated-key' });
      } finally { release(); store.verifyAndProbe = original; }
    });
  });

  it('an older revision cannot verify, enable or delete an edited draft', async () => {
    await runInDurableObject(ownerStub(), async instance => {
      const store = internals(instance).modelConfigStore;
      const old = await store.saveDraft(candidate);
      const original = store.verifyAndProbe;
      let release!: () => void;
      let started!: () => void;
      const entered = new Promise<void>(resolve => { started = resolve; });
      const wait = new Promise<void>(resolve => { release = resolve; });
      try {
        store.verifyAndProbe = async () => { started(); await wait; return { ok: true }; };
        const test = store.verifyDraft(old.draftId!, old.revision!);
        await entered;
        const edited = await store.saveDraft({ ...candidate, apiKey: 'edited-key' });
        expect(edited.draftId).toBe(old.draftId);
        expect(edited.revision).toBe(old.revision! + 1);
        release();
        expect(await test).toMatchObject({ status: 'conflict' });
        store.deleteDraft(old.draftId!, old.revision!);
        expect(store.drafts()).toEqual([expect.objectContaining({ revision: edited.revision, status: 'saved' })]);
        await expect(store.activateDraft(old.draftId!, old.revision!, async () => false)).rejects.toThrow('model_draft_conflict');
      } finally { release(); store.verifyAndProbe = original; }
    });
  });

  it('a SQL failure after writing the selection rolls back keys, headers, imports, cache and candidate status', async () => {
    await runInDurableObject(ownerStub(), async (instance, state) => {
      const store = internals(instance).modelConfigStore;
      await store.setModelConfig(candidate.provider, 'old-key', candidate.modelId, 'https://old.invalid/v1', 'auto', { 'X-Test': 'old-header' });
      const saved = await store.saveDraft(candidate);
      const original = store.verifyAndProbe;
      try {
        store.verifyAndProbe = async () => ({ ok: true });
        await store.verifyDraft(saved.draftId!, saved.revision!);
      } finally { store.verifyAndProbe = original; }
      const before = await store.modelConfig();
      const generation = state.storage.sql.exec('SELECT * FROM sh_model_generation').toArray();
      state.storage.sql.exec("CREATE TRIGGER refuse_import BEFORE INSERT ON sh_saved_model WHEN NEW.modelId = 'imported' BEGIN SELECT RAISE(ABORT, 'injected import failure'); END");
      try {
        await expect(store.activateDraft(saved.draftId!, saved.revision!, async () => false)).rejects.toThrow('injected import failure');
      } finally { state.storage.sql.exec('DROP TRIGGER refuse_import'); }
      expect(await store.modelConfig()).toEqual(before);
      expect(await store.headersFor(candidate.provider, candidate.modelId)).toEqual({ 'X-Test': 'old-header' });
      expect(store.savedModels().map(row => row.modelId)).not.toContain('imported');
      expect(store.drafts()[0]!.status).toBe('verified');
      expect(state.storage.sql.exec('SELECT * FROM sh_model_generation').toArray()).toEqual(generation);
      expect(state.storage.sql.exec('SELECT * FROM sh_verified_model').toArray()).toEqual([]);
      expect((await store.activateDraft(saved.draftId!, saved.revision!, async () => false)).activated).toBe(true);
    });
  });
});

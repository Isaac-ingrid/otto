import { describe, expect, it } from 'vitest';
import { acceptsAgentModel, agentModelCatalogFor, AgentModelCatalogSchema, AgentModelObservationSchema, AgentModelsRequestSchema, AgentModelsResultSchema, type AgentModelCatalog } from '../src/agent-models.ts';
const catalog: AgentModelCatalog = { status: 'ready', capabilities: { selection: 'launch', discovery: 'suggested', customModelInput: true, actualModelObservation: true, thinkingSelection: false }, models: [{ id: 'known', name: 'Known' }] };
describe('generic local-agent model capabilities', () => {
  it('bounds discovery metadata and strips fields other than model metadata from replies', () => {
    const local = { ...catalog, source: 'local-pi', discoveredAt: 1, attemptedAt: 2, defaultModel: 'mine/a', refreshable: true, apiKey: 'synthetic-only' };
    const reply = AgentModelsResultSchema.parse({ t: 'agent_models_result', re: 'read-1', ok: true, catalog: local });
    expect(JSON.stringify(reply)).not.toContain('synthetic-only');
    expect(AgentModelCatalogSchema.safeParse({ ...local, discoveredAt: Infinity }).success).toBe(false);
    expect(AgentModelCatalogSchema.safeParse({ ...local, attemptedAt: -1 }).success).toBe(false);
    expect(AgentModelsRequestSchema.safeParse({ t: 'agent_models', id: 'x', agent: '../pi' }).success).toBe(false);
    expect(acceptsAgentModel(AgentModelCatalogSchema.parse(local), 'custom/not-listed')).toBe(true);
  });
  it('does not interpret dictionary prototype properties as reported agent capabilities', () => {
    expect(agentModelCatalogFor({}, 'constructor')).toBeUndefined();
    expect(agentModelCatalogFor({}, '__proto__')).toBeUndefined();
    expect(agentModelCatalogFor({ codex: catalog }, 'codex')).toBe(catalog);
  });
  it('preserves following defaults for old agents, but denies explicit overrides', () => {
    expect(acceptsAgentModel(undefined, null)).toBe(true);
    expect(acceptsAgentModel(undefined, 'known')).toBe(false);
    expect(acceptsAgentModel({ ...catalog, capabilities: { ...catalog.capabilities, selection: 'none' } }, 'known')).toBe(false);
  });
  it('does not treat suggestions as an exhaustive whitelist', () => {
    expect(acceptsAgentModel(catalog, 'custom-provider/custom-model')).toBe(true);
    const enumerated = { ...catalog, capabilities: { ...catalog.capabilities, discovery: 'enumerated' as const } };
    expect(acceptsAgentModel(enumerated, 'known')).toBe(true);
    expect(acceptsAgentModel(enumerated, 'custom-provider/custom-model')).toBe(false);
    expect(acceptsAgentModel({ ...enumerated, status: 'unavailable' }, 'known')).toBe(false);
  });
  it('rejects flags, controls and oversized IDs; qualified IDs reject pi thinking suffixes', () => {
    for (const value of ['', '--help', 'a\nb', 'a b', 'x'.repeat(257)]) expect(acceptsAgentModel(catalog, value)).toBe(false);
    const qualified = { ...catalog, capabilities: { ...catalog.capabilities, idFormat: 'qualified' as const } };
    expect(acceptsAgentModel(qualified, 'plain-alias')).toBe(false);
    expect(acceptsAgentModel(qualified, 'provider/model')).toBe(true);
    expect(acceptsAgentModel(qualified, 'provider/model:high')).toBe(false);
    expect(acceptsAgentModel(catalog, 'sonnet[1m]')).toBe(true);
    expect(acceptsAgentModel(catalog, 'anthropic.model:0')).toBe(true);
  });
  it('bounds the hello catalog and distinguishes observed facts from requested values', () => {
    expect(AgentModelCatalogSchema.safeParse({ ...catalog, models: Array(101).fill(catalog.models[0]) }).success).toBe(false);
    expect(AgentModelObservationSchema.safeParse({ id: 'actual-model', source: 'init', observedAt: 1 }).success).toBe(true);
    expect(AgentModelObservationSchema.safeParse({ id: 'requested-model', source: 'requested', observedAt: 1 }).success).toBe(false);
  });
});

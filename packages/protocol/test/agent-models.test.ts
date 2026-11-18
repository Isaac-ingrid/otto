import { describe, expect, it } from 'vitest';
import {
  acceptsAgentModel,
  agentModelCatalogFor,
  AgentModelCatalogSchema,
  AgentModelObservationSchema,
  AgentModelsRequestSchema,
  AgentModelsResultSchema,
  validateClaudeModelId,
  type AgentModelCatalog,
} from '../src/agent-models.ts';

const catalog: AgentModelCatalog = {
  status: 'ready',
  capabilities: { selection: 'launch', discovery: 'suggested', customModelInput: true, actualModelObservation: true, thinkingSelection: false },
  models: [{ id: 'known', name: 'Known' }],
};

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

  it('rejects flags, controls and oversized IDs; qualified IDs reject pi thinking suffixes; opaque IDs validate Claude aliases, Bedrock/Vertex IDs, and bracket hygiene', () => {
    for (const value of ['', '--help', 'a\nb', 'a b', 'x'.repeat(257)]) expect(acceptsAgentModel(catalog, value)).toBe(false);
    const qualified = { ...catalog, capabilities: { ...catalog.capabilities, idFormat: 'qualified' as const } };
    expect(acceptsAgentModel(qualified, 'plain-alias')).toBe(false);
    expect(acceptsAgentModel(qualified, 'provider/model')).toBe(true);
    expect(acceptsAgentModel(qualified, 'provider/model:high')).toBe(false);
    expect(acceptsAgentModel(qualified, 'claude-sonnet-4-5@20250929')).toBe(false);

    const opaque = { ...catalog, capabilities: { ...catalog.capabilities, idFormat: 'opaque' as const } };
    for (const valid of [
      'sonnet',
      'opusplan',
      'sonnet[1m]',
      'claude-sonnet-4-6[1m]',
      'anthropic.model:0',
      'us.anthropic.claude-sonnet-4-6-v1:0',
      'arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-sonnet-4-6-v1:0',
      'claude-sonnet-4-5@20250929',
      'claude-opus-4-6@default',
    ]) {
      expect(validateClaudeModelId(valid)).toBe(true);
      expect(acceptsAgentModel(opaque, valid)).toBe(true);
    }

    for (const invalid of [
      'sonnet[',
      'sonnet]',
      'sonnet[]',
      '[1m]',
      'sonnet[1m]extra',
      'sonnet[1m][2m]',
      '../sonnet',
      'provider//model',
      'anthropic:',
      'claude@',
      'provider/',
      'claude.',
    ]) {
      expect(validateClaudeModelId(invalid)).toBe(false);
      expect(acceptsAgentModel(opaque, invalid)).toBe(false);
    }
  });

  it('bounds the hello catalog and distinguishes observed facts from requested values', () => {
    expect(AgentModelCatalogSchema.safeParse({ ...catalog, models: Array(101).fill(catalog.models[0]) }).success).toBe(false);
    expect(AgentModelObservationSchema.safeParse({ id: 'actual-model', source: 'init', observedAt: 1 }).success).toBe(true);
    expect(AgentModelObservationSchema.safeParse({ id: 'requested-model', source: 'requested', observedAt: 1 }).success).toBe(false);
  });
});

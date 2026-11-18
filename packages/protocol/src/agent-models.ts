// Agent-owned model selection is independent of the steward provider/key registry.
import { z } from 'zod';

// One bounded argv value. Opaque CLI IDs may contain colons, @ version tags (Vertex), or
// trailing context suffixes like `[1m]` (Claude); strict qualified provider/model IDs exclude
// those. Never concatenate a shell command.
export const AgentModelIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._/@:\[\]-]*$/);
export const AgentModelCapabilitiesSchema = z.object({
  selection: z.enum(['none', 'launch', 'idle']),
  discovery: z.enum(['none', 'suggested', 'enumerated']),
  customModelInput: z.boolean(),
  actualModelObservation: z.boolean(),
  thinkingSelection: z.boolean(),
  idFormat: z.enum(['opaque', 'qualified']).optional(),
});
export const AgentModelCatalogSchema = z.object({
  capabilities: AgentModelCapabilitiesSchema,
  models: z.array(z.object({ id: AgentModelIdSchema, name: z.string().min(1).max(256) })).max(100),
  // Catalog availability is separate from whether the CLI is installed.
  status: z.enum(['ready', 'unavailable']),
  // Optional for old connectors; local snapshots are suggestions, not upstream verification.
  source: z.literal('local-pi').optional(),
  refreshable: z.boolean().optional(),
  discoveredAt: z.number().int().nonnegative().max(8_640_000_000_000_000).optional(),
  attemptedAt: z.number().int().nonnegative().max(8_640_000_000_000_000).optional(),
  defaultModel: AgentModelIdSchema.nullable().optional(),
  truncated: z.boolean().optional(),
});
export const AgentModelObservationSchema = z.object({
  id: z.string().min(1).max(256).refine(value => !/[\x00-\x1f\x7f]/.test(value)),
  source: z.enum(['state', 'init', 'session']),
  observedAt: z.number().int().nonnegative().max(8_640_000_000_000_000),
});
export type AgentModelCatalog = z.infer<typeof AgentModelCatalogSchema>;
export type AgentModelCapabilities = z.infer<typeof AgentModelCapabilitiesSchema>;
export type AgentModelObservation = z.infer<typeof AgentModelObservationSchema>;

// Ephemeral owner-initiated metadata reads: no durable command, task, prompt or replay.
export const AgentModelsRequestSchema = z.object({
  t: z.literal('agent_models'), id: z.string().min(1).max(128),
  agent: z.string().regex(/^[a-z0-9-]{1,64}$/),
});
export const AgentModelsResultSchema = z.discriminatedUnion('ok', [
  z.object({ t: z.literal('agent_models_result'), re: z.string().min(1).max(128), ok: z.literal(true), catalog: AgentModelCatalogSchema }),
  z.object({ t: z.literal('agent_models_result'), re: z.string().min(1).max(128), ok: z.literal(false), code: z.enum(['unsupported', 'busy', 'discovery_failed']) }),
]);
export type AgentModelsResult = z.infer<typeof AgentModelsResultSchema>;

/** Plain dictionaries remain RPC-serializable; do not read inherited names as agent facts. */
export function agentModelCatalogFor(catalogs: Record<string, AgentModelCatalog> | undefined, agent: string): AgentModelCatalog | undefined {
  return catalogs && Object.hasOwn(catalogs, agent) ? catalogs[agent] : undefined;
}

/**
 * Validates bounded opaque CLI model identifiers (such as Claude Code aliases `sonnet`,
 * `opusplan`, `sonnet[1m]`, Anthropic concrete versions `claude-sonnet-4-6`, Bedrock IDs/ARNs
 * `us.anthropic.claude-sonnet-4-6-v1:0`, or Vertex IDs `claude-sonnet-4-5@20250929`).
 * Rejects path traversal (`..`), empty segments (`//`), trailing punctuation, and malformed
 * or mid-string bracket fragments.
 */
export function validateClaudeModelId(model: string): boolean {
  if (!AgentModelIdSchema.safeParse(model).success) return false;
  if (model.includes('..') || model.includes('//')) return false;
  if (!/^[^\][]+(?:\[[A-Za-z0-9_-]{1,16}\])?$/.test(model)) return false;
  const base = model.replace(/\[[A-Za-z0-9_-]{1,16}\]$/, '');
  if (/[/:@.]$/.test(base)) return false;
  return true;
}

/** Absent capabilities (old connectors/adapters) permit only following the agent default. */
export function acceptsAgentModel(catalog: AgentModelCatalog | undefined, model: string | null | undefined): boolean {
  if (model == null) return true;
  if (!AgentModelIdSchema.safeParse(model).success || !catalog || catalog.capabilities.selection === 'none') return false;
  if (catalog.capabilities.idFormat === 'qualified' && (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(model) || !model.includes('/') || model.endsWith('/'))) return false;
  if (catalog.capabilities.idFormat === 'opaque' && !validateClaudeModelId(model)) return false;
  const listed = catalog.models.some(entry => entry.id === model);
  if (catalog.capabilities.discovery === 'enumerated') return catalog.status === 'ready' && listed;
  return listed || catalog.capabilities.customModelInput;
}

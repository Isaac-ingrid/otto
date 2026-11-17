// Local-agent defaults contain IDs only. Never reuse steward keys/providers here.
import { acceptsAgentModel, agentModelCatalogFor } from '@isaac2ingrid/protocol';
import type { Ledger } from './ledger.ts';
import type { SqlExecutor } from './schema.ts';
import { WorkspaceError } from './workspace.ts';

export class AgentModelConfig {
  constructor(private sql: SqlExecutor, private ledger: Ledger) {}

  get(deviceId: string, agent: string): string | null {
    return this.sql<{ model: string }>`SELECT model FROM sh_agent_model_default WHERE deviceId = ${deviceId} AND agent = ${agent}`[0]?.model ?? null;
  }

  list() {
    return this.ledger.machines.list().flatMap(machine => machine.agents.map(agent => ({
      deviceId: machine.deviceId, machineName: machine.name, online: machine.online, lastSeen: machine.lastSeen,
      agent, catalog: agentModelCatalogFor(machine.modelCatalogs, agent) ?? null, model: this.get(machine.deviceId, agent),
    })));
  }

  set(deviceId: string, agent: string, model: string | null): void {
    const machine = this.ledger.machines.get(deviceId);
    if (!machine || !machine.agents.includes(agent)) throw new WorkspaceError('agent_not_available', 404);
    if (!acceptsAgentModel(agentModelCatalogFor(machine.modelCatalogs, agent), model)) throw new WorkspaceError('agent_model_unsupported', 409);
    if (model === null) this.sql`DELETE FROM sh_agent_model_default WHERE deviceId = ${deviceId} AND agent = ${agent}`;
    else this.sql`INSERT INTO sh_agent_model_default (deviceId, agent, model, updatedAt) VALUES (${deviceId}, ${agent}, ${model}, ${Date.now()})
      ON CONFLICT(deviceId, agent) DO UPDATE SET model = excluded.model, updatedAt = excluded.updatedAt`;
  }
}

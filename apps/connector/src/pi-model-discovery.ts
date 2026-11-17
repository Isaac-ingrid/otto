// Local pi metadata only. Never prompt, set a model, inspect auth stores, or probe providers.
import { mkdtempSync, readFileSync, statSync, writeFileSync, renameSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AgentModelCatalogSchema, AgentModelIdSchema, type AgentModelCatalog } from '@isaac2ingrid/protocol';
import { PiProcess } from './pi-process.ts';
import type { LaunchResolution } from './pi-launch.ts';

const capabilities: AgentModelCatalog['capabilities'] = {
  selection: 'launch', discovery: 'suggested', customModelInput: true,
  actualModelObservation: true, thinkingSelection: false, idFormat: 'qualified',
};
const qualified = (value: unknown): value is string => typeof value === 'string' &&
  AgentModelIdSchema.safeParse(value).success && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) && value.includes('/') && !value.endsWith('/');
function modelId(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const m = value as Record<string, unknown>;
  if (typeof m.provider !== 'string' || typeof m.id !== 'string') return null;
  const id = `${m.provider}/${m.id}`;
  return qualified(id) ? id : null;
}

export class PiModelDiscovery {
  catalog: AgentModelCatalog = { capabilities, status: 'unavailable', source: 'local-pi', refreshable: true, models: [] };
  private pending?: Promise<AgentModelCatalog>;
  private process?: PiProcess;
  private stopped = false;
  private readonly cache: string;
  constructor(private options: { stateDir: string; launch(): LaunchResolution; env(): Record<string, string | undefined>; timeoutMs?: number }) {
    this.cache = join(options.stateDir, 'model-catalog-pi.json');
    try {
      if (statSync(this.cache).size > 256_000) return;
      const parsed = AgentModelCatalogSchema.safeParse(JSON.parse(readFileSync(this.cache, 'utf8')));
      if (parsed.success && parsed.data.source === 'local-pi') this.catalog = { ...parsed.data, capabilities, refreshable: true, status: 'unavailable' };
    } catch { /* First boot/corrupt cache: unknown, never substitute a library catalog. */ }
  }
  refresh(): Promise<AgentModelCatalog> {
    return this.pending ??= this.discover().finally(() => { this.pending = undefined; });
  }
  stop(): void { this.stopped = true; void this.process?.close(0); }
  private async discover(): Promise<AgentModelCatalog> {
    this.stopped = false;
    const attemptedAt = Date.now();
    let scratch: string | undefined;
    try {
      const launch = this.options.launch();
      if (launch.error) throw new Error('launch_unresolved');
      scratch = mkdtempSync(join(tmpdir(), 'otto-model-discovery-'));
      // Same resolved executable, user config and filtered environment as workers. Do not load
      // project/global executable extensions, MCP or context: they can perform arbitrary I/O.
      // Extension/project-only models may be absent, hence suggested + advanced custom input.
      const proc = this.process = new PiProcess({ command: launch.argv,
        args: ['--mode', 'rpc', '--offline', '--no-session', '--no-approve', '--no-extensions', '--no-mcp', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-themes', '--tools', ''],
        cwd: scratch, env: this.options.env(), onEvent: () => {}, onExit: () => {},
      });
      proc.spawn();
      const timeout = this.options.timeoutMs ?? 5000;
      const [state, available] = await Promise.all([proc.rpc({ type: 'get_state' }, timeout), proc.rpc({ type: 'get_available_models' }, timeout)]);
      if (this.stopped || !Array.isArray(available.models)) throw new Error('discovery_failed');
      const models: AgentModelCatalog['models'] = [], seen = new Set<string>();
      let count = 0;
      for (const raw of available.models) {
        const id = modelId(raw);
        if (!id || seen.has(id)) continue;
        seen.add(id); count++;
        if (models.length >= 100) continue;
        const name = typeof raw.name === 'string' && raw.name.length > 0 && raw.name.length <= 256 && !/[\x00-\x1f\x7f]/.test(raw.name) ? raw.name : id;
        // Deliberately reconstruct: no base URL, headers, key, auth or other CLI fields travel.
        models.push({ id, name });
      }
      this.catalog = { capabilities, status: 'ready', source: 'local-pi', refreshable: true, models,
        defaultModel: modelId(state.model), discoveredAt: Date.now(), attemptedAt, truncated: count > models.length };
      this.save();
    } catch {
      this.catalog = { ...this.catalog, status: 'unavailable', attemptedAt };
      if (!this.stopped) this.save();
    } finally {
      await this.process?.close(); this.process = undefined;
      if (scratch) rmSync(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
    return this.catalog;
  }
  private save(): void {
    let temporary: string | undefined;
    try {
      mkdirSync(this.options.stateDir, { recursive: true });
      temporary = `${this.cache}.${randomUUID()}.tmp`;
      writeFileSync(temporary, JSON.stringify(this.catalog), { mode: 0o600 });
      renameSync(temporary, this.cache);
    } catch { /* A cache write failure must not erase successfully discovered metadata. */ }
    finally { if (temporary) { try { rmSync(temporary, { force: true }); } catch { /* Retain only an owned metadata temp on cleanup failure. */ } } }
  }
}

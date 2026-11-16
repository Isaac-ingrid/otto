// Model credentials, selection and connection tests (issues #6/#25/#27/#70/#74,
// spec §12.1–12.2, ADR-0001 decision 11). Extracted from steward.ts as part of the
// progressive split (docs/plan/code-quality-and-reliability.md phase 5).
//
// Provider API keys are AES-GCM sealed under the deployment key exactly like Feishu secrets
// (sh_provider_key.apiKeyEnc, one row per provider); the plaintext exists only in transit
// and in memory. sh_model id=0 is the active selection and mirrors the selected provider's
// key for pre-#74 readers. Not reachable over HTTP — RPC on the stub only.
//
// This module is a pure storage + verification layer: it owns the sealed-key registry,
// the saved/verified/probe rows, and the connection test. It does NOT touch the PiHarness
// or installModel — that wiring stays in Steward (ensureRootModel / selectComposerModel).
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ServerKey } from "@isaac2ingrid/protocol";
import { testModelConnection, type ConnectionTestError } from "./llm/connection-test.ts";
import { probeAcceptedThinkingLevels } from "./llm/thinking-probe.ts";
import {
  COMPATIBLE_THINKING_LEVELS,
  declaredThinkingLevels,
  mergeModelSelection,
  resolveCatalogModel,
  resolveModelConfig,
  resolveModelThinking,
  type ComposerModelInput,
  type ModelSwitchInput,
  type ModelSaveResult,
  type StewardThinkingLevel,
} from "./llm/models.ts";
import type { SqlExecutor } from "./schema.ts";
import { openSecret, sealSecret } from "./secretbox.ts";
import { WorkspaceError } from "./workspace.ts";

/** Dependencies the store borrows from the Steward Durable Object. */
export interface ModelConfigDeps {
  sql: SqlExecutor;
  tx: <T>(fn: () => T) => T;
  serverKeys: () => Promise<ServerKey[]>;
  /** `env.MODEL_KEY` trimmed, or undefined. Seeds the sealed config on first read. */
  modelKey: () => string | undefined;
  /** `env.STEWARD_MODEL` raw value (or a test override). */
  stewardModelVars: () => unknown;
  /** The default provider for keys collected at deploy time (Steward.DEFAULT_MODEL_PROVIDER). */
  defaultProvider: string;
  /** Side effect after any config write: reset the root-model memo and broadcast to workspaces. */
  notifyModelChanged: () => void;
}

/**
 * Model credential storage, connection testing and read-only selection diagnostics.
 * Live configuration commits use a synchronous transaction after all crypto preparation.
 * Candidates are separate sealed snapshots; verification cannot modify live dependencies.
 */
export class ModelConfigStore {
  constructor(private readonly deps: ModelConfigDeps) {}

  private get sql(): SqlExecutor { return this.deps.sql; }

  // ---- Sealed provider keys (spec §12.2 "model keys stored encrypted", issues #27/#74) ---------

  /** ADR-0001 decision 11: the default provider for keys collected at deploy time. */
  static readonly DEFAULT_MODEL_PROVIDER = "deepseek";

  /**
   * `apiKey` omitted (issue #74) means "keep the key already sealed for this provider" —
   * switching provider or model no longer re-asks for a saved key. `modelId`/`baseUrl` are
   * present for an owner-driven runtime switch (issue #70, the Settings page): once set,
   * they win over vars.STEWARD_MODEL entirely (ensureRootModel). Omitting them (the
   * MODEL_KEY seed path, and the pre-#70 provider-only form) keeps the legacy behavior —
   * vars still supply modelId/baseUrl.
   */
  async setModelConfig(provider: string, apiKey?: string, modelId?: string, baseUrl?: string, thinkingLevel?: StewardThinkingLevel, headers?: Record<string, string>, thinkingJson?: string | null): Promise<void> {
    const commit = await this.prepareModelConfig(provider, apiKey, modelId, baseUrl, thinkingLevel, headers, thinkingJson);
    this.deps.tx(commit);
    this.deps.notifyModelChanged();
  }

  private async prepareModelConfig(provider: string, apiKey?: string, modelId?: string, baseUrl?: string, thinkingLevel?: StewardThinkingLevel, headers?: Record<string, string>, thinkingJson?: string | null): Promise<() => void> {
    if (!provider.trim()) throw new Error("provider is required");
    const providerId = provider.trim();
    const [primary] = await this.deps.serverKeys();
    const key = apiKey?.trim() || "";
    // No key given: the selection moves to a provider whose key was sealed earlier, so mirror
    // that stored key — a pre-#74 reader of sh_model keeps seeing a matching provider+key.
    const sealedKey = key || (await this.sealedKeyFor(providerId)) || "";
    const apiKeyEnc = sealedKey ? await sealSecret(primary!, sealedKey) : "";
    const providerKeyEnc = key ? await sealSecret(primary!, key) : null;
    const headersEnc = headers !== undefined ? await sealSecret(primary!, JSON.stringify(headers)) : null;
    return () => {
      if (key) this.sql`
        INSERT INTO sh_provider_key (provider, apiKeyEnc, updatedAt)
        VALUES (${providerId}, ${providerKeyEnc}, ${Date.now()})
        ON CONFLICT(provider) DO UPDATE SET apiKeyEnc = excluded.apiKeyEnc, updatedAt = excluded.updatedAt
      `;
      const modelIdValue = modelId?.trim() || null;
      const baseUrlValue = baseUrl?.trim() || null;
      const previous = this.sql<{ provider: string; modelId: string | null; thinkingLevel: StewardThinkingLevel | null }>`SELECT provider, modelId, thinkingLevel FROM sh_model WHERE id = 0`[0];
      const thinkingValue = thinkingLevel ?? (previous?.provider === providerId && previous.modelId === modelIdValue ? previous.thinkingLevel : null);
      this.sql`
        INSERT INTO sh_model (id, provider, apiKeyEnc, modelId, baseUrl, thinkingLevel, updatedAt)
        VALUES (0, ${providerId}, ${apiKeyEnc}, ${modelIdValue}, ${baseUrlValue}, ${thinkingValue}, ${Date.now()})
        ON CONFLICT(id) DO UPDATE SET
          provider = excluded.provider, apiKeyEnc = excluded.apiKeyEnc,
          modelId = excluded.modelId, baseUrl = excluded.baseUrl, thinkingLevel = excluded.thinkingLevel, updatedAt = excluded.updatedAt
      `;
      // The runtime installs lazily before the next submit; notify only after the transaction.
      if (modelIdValue) this.sql`
        INSERT INTO sh_saved_model (provider, modelId, baseUrl, headersEnc, thinkingJson, updatedAt)
        VALUES (${providerId}, ${modelIdValue}, ${baseUrlValue}, ${headersEnc}, ${thinkingJson ?? null}, ${Date.now()})
        ON CONFLICT(provider, modelId) DO UPDATE SET baseUrl = excluded.baseUrl,
          headersEnc = COALESCE(excluded.headersEnc, sh_saved_model.headersEnc),
          thinkingJson = CASE WHEN ${thinkingJson === undefined ? 0 : 1} THEN ${thinkingJson ?? null} ELSE sh_saved_model.thinkingJson END,
          updatedAt = excluded.updatedAt
      `;
      this.sql`UPDATE sh_model_generation SET generation = generation + 1 WHERE id = 0`;
    };
  }

  async selectIdleModel(input: ComposerModelInput & { baseUrl?: string | null }, busy: () => Promise<boolean>): Promise<void> {
    const generation = this.generation();
    const commit = await this.prepareModelConfig(input.provider, undefined, input.modelId, input.baseUrl ?? undefined, input.thinkingLevel);
    if (await busy()) throw new WorkspaceError('model_busy', 409);
    this.deps.tx(() => {
      if (this.generation() !== generation) throw new WorkspaceError('model_conflict', 409);
      commit();
    });
    this.deps.notifyModelChanged();
  }

  private generation(): number {
    return this.sql<{ generation: number }>`SELECT generation FROM sh_model_generation WHERE id = 0`[0]!.generation;
  }

  drafts() {
    // Deliberately excludes the sealed payload, credentials and custom headers.
    return this.sql<{ id: string; provider: string; modelId: string; revision: number; status: string; testError: string | null }>`
      SELECT id, provider, modelId, revision, status, testError FROM sh_model_draft ORDER BY updatedAt DESC`;
  }

  async saveDraft(input: ModelSwitchInput): Promise<ModelSaveResult> {
    // Freeze inherited credentials/headers now: later changes must not change what was tested.
    const generation = this.generation();
    const payload = { ...input, apiKey: input.apiKey ?? await this.sealedKeyFor(input.provider) ?? '',
      headers: input.headers ?? await this.headersFor(input.provider, input.modelId) ?? {} };
    const payloadEnc = await sealSecret((await this.deps.serverKeys())[0]!, JSON.stringify(payload));
    return this.deps.tx(() => {
      const old = this.sql<{ id: string; revision: number }>`SELECT id, revision FROM sh_model_draft WHERE provider = ${input.provider} AND modelId = ${input.modelId}`[0];
      const id = old?.id ?? crypto.randomUUID();
      const revision = (old?.revision ?? 0) + 1;
      this.sql`INSERT INTO sh_model_draft (id, provider, modelId, revision, generation, payloadEnc, status, updatedAt)
        VALUES (${id}, ${input.provider}, ${input.modelId}, ${revision}, ${generation}, ${payloadEnc}, 'saved', ${Date.now()})
        ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, generation = excluded.generation,
          payloadEnc = excluded.payloadEnc, status = 'saved', testError = NULL, levelsJson = NULL, updatedAt = excluded.updatedAt`;
      return { ok: true, activated: false, status: 'saved', draftId: id, revision };
    });
  }

  private async readDraft(id: string, revision: number) {
    const row = this.sql<{ payloadEnc: string; generation: number; status: string; levelsJson: string | null }>`
      SELECT payloadEnc, generation, status, levelsJson FROM sh_model_draft WHERE id = ${id} AND revision = ${revision}`[0];
    if (!row) throw new WorkspaceError('model_draft_conflict', 409);
    const opened = await openSecret(await this.deps.serverKeys(), row.payloadEnc);
    if (!opened) throw new WorkspaceError('model_draft_unreadable', 409);
    return { ...row, input: JSON.parse(opened.text) as ModelSwitchInput };
  }

  async verifyDraft(id: string, revision: number): Promise<ModelSaveResult> {
    const { input } = await this.readDraft(id, revision);
    // No live verification/probe rows are written before activation.
    const result = await this.verifyAndProbe(input, { force: false, record: false });
    const current = this.drafts().find(draft => draft.id === id);
    if (current?.revision !== revision) return { ok: true, activated: false, status: 'conflict', draftId: id, revision };
    this.sql`UPDATE sh_model_draft SET status = ${result.ok ? 'verified' : 'verification_failed'},
      testError = ${result.ok ? null : result.error}, levelsJson = ${result.ok ? JSON.stringify(result.acceptedThinkingLevels ?? null) : null}, updatedAt = ${Date.now()}
      WHERE id = ${id} AND revision = ${revision}`;
    return { ok: true, activated: false, draftId: id, revision, status: result.ok ? 'verified' : 'verification_failed',
      verified: result.ok, ...(!result.ok ? { testError: result.error } : {}),
      ...(result.ok && result.acceptedThinkingLevels ? { acceptedThinkingLevels: result.acceptedThinkingLevels } : {}) };
  }

  async activateDraft(id: string, revision: number, busy: () => Promise<boolean>): Promise<ModelSaveResult> {
    const draft = await this.readDraft(id, revision);
    const response = (status: ModelSaveResult['status']): ModelSaveResult => ({ ok: true, activated: false, draftId: id, revision, status });
    if (draft.status !== 'verified') return response('verification_failed');
    const input = draft.input;
    const commit = await this.prepareModelConfig(input.provider, input.apiKey, input.modelId, input.baseUrl, input.thinkingLevel, input.headers, input.thinkingJson);
    const headersEnc = await sealSecret((await this.deps.serverKeys())[0]!, JSON.stringify(input.headers ?? {}));
    const hash = await this.modelCredentialHash(input.apiKey ?? '', input.headers);
    // All crypto/decryption has finished. No external await after the final busy observation.
    if (await busy()) return response('busy');
    const outcome = this.deps.tx(() => {
      const current = this.drafts().find(row => row.id === id);
      if (current?.revision !== revision || current.status !== 'verified') return response('conflict');
      if (this.generation() !== draft.generation) return response('conflict');
      commit();
      for (const modelId of input.importedModelIds ?? []) this.sql`
        INSERT INTO sh_saved_model (provider, modelId, baseUrl, headersEnc, updatedAt)
        VALUES (${input.provider}, ${modelId}, ${input.baseUrl ?? null}, ${headersEnc}, ${Date.now()})
        ON CONFLICT(provider, modelId) DO UPDATE SET baseUrl = excluded.baseUrl, headersEnc = excluded.headersEnc, updatedAt = excluded.updatedAt`;
      this.sql`INSERT INTO sh_verified_model (provider, modelId, baseUrl, credentialHash, verifiedAt)
        VALUES (${input.provider}, ${input.modelId}, ${input.baseUrl ?? ''}, ${hash}, ${Date.now()})
        ON CONFLICT(provider, modelId, baseUrl) DO UPDATE SET credentialHash = excluded.credentialHash, verifiedAt = excluded.verifiedAt`;
      if (draft.levelsJson && draft.levelsJson !== 'null') this.sql`
        INSERT INTO sh_model_thinking_probe (provider, modelId, baseUrl, credentialHash, levelsJson, probedAt)
        VALUES (${input.provider}, ${input.modelId}, ${input.baseUrl ?? ''}, ${hash}, ${draft.levelsJson}, ${Date.now()})
        ON CONFLICT(provider, modelId, baseUrl) DO UPDATE SET credentialHash = excluded.credentialHash, levelsJson = excluded.levelsJson, probedAt = excluded.probedAt`;
      this.sql`UPDATE sh_model_draft SET status = 'activated', updatedAt = ${Date.now()} WHERE id = ${id}`;
      return { ok: true, activated: true, status: 'activated', verified: true, draftId: id, revision } satisfies ModelSaveResult;
    });
    if (outcome.activated) this.deps.notifyModelChanged();
    return outcome;
  }

  deleteDraft(id: string, revision: number): void {
    this.sql`DELETE FROM sh_model_draft WHERE id = ${id} AND revision = ${revision}`;
  }

  savedModels(): { provider: string; modelId: string; baseUrl: string | null; thinkingJson: string | null }[] {
    return this.sql<{ provider: string; modelId: string; baseUrl: string | null; thinkingJson: string | null }>`
      SELECT provider, modelId, baseUrl, thinkingJson FROM sh_saved_model ORDER BY updatedAt DESC
    `;
  }

  async sealedKeyFor(provider: string): Promise<string | null> {
    const row = this.sql<{ apiKeyEnc: string }>`SELECT apiKeyEnc FROM sh_provider_key WHERE provider = ${provider}`[0];
    if (!row) return null;
    const keys = await this.deps.serverKeys();
    const opened = await openSecret(keys, row.apiKeyEnc);
    if (!opened) return null;
    // Rotation convergence (issue #27): a value that only opened because SERVER_KEY_PREVIOUS is
    // still configured is re-sealed onto the primary here, on read. Without this the window could
    // never be closed without re-entering the key: the only other seal caller is setModelConfig,
    // which runs on an owner-side save, not on a rotation. The legacy sh_model mirror is written
    // by setModelConfig too, so refresh it in the same breath or it stays sealed under the dead key.
    const primary = keys[0];
    if (primary && opened.keyId !== primary.id) {
      this.sql`UPDATE sh_provider_key SET apiKeyEnc = ${await sealSecret(primary, opened.text)}, updatedAt = ${Date.now()} WHERE provider = ${provider}`;
      this.sql`UPDATE sh_model SET apiKeyEnc = ${await sealSecret(primary, opened.text)} WHERE id = 0 AND provider = ${provider} AND apiKeyEnc <> ''`;
    }
    return opened.text;
  }

  async keyedProviders(): Promise<string[]> {
    return this.sql<{ provider: string }>`SELECT provider FROM sh_provider_key ORDER BY provider`.map((row) => row.provider);
  }

  async modelConfig(): Promise<{ provider: string; modelId: string | null; baseUrl: string | null; apiKey: string; thinkingLevel?: StewardThinkingLevel } | null> {
    // One-click-deploy glue (issue #25, spec §12.1 step 1): MODEL_KEY — the secret the
    // Deploy-to-Cloudflare form collects — seeds the sealed config on first read, so the key
    // never lives anywhere outside the user's own account. Seeding fills an empty deployment
    // only: an explicit setModelConfig (any provider's saved key counts, issue #74) always
    // wins, and the env secret is dead weight once a sealed row exists (delete it if you like).
    const modelKey = this.deps.modelKey();
    if (
      modelKey &&
      this.sql`SELECT 1 AS one FROM sh_model WHERE id = 0`.length === 0 &&
      !this.sql`SELECT 1 AS one FROM sh_provider_key WHERE provider = ${this.deps.defaultProvider}`.length
    ) {
      await this.setModelConfig(this.deps.defaultProvider, modelKey);
    }
    const row = this.sql<{ provider: string; modelId: string | null; baseUrl: string | null; thinkingLevel: StewardThinkingLevel | null }>`
      SELECT provider, modelId, baseUrl, thinkingLevel FROM sh_model WHERE id = 0
    `[0];
    if (!row) return null;
    // The key lives with the provider now (issue #74): a selection whose provider has no
    // sealed key still resolves, keyless — apiKey: "" — and fails visibly at run time.
    return { provider: row.provider, modelId: row.modelId, baseUrl: row.baseUrl, ...(row.thinkingLevel ? { thinkingLevel: row.thinkingLevel } : {}), apiKey: (await this.sealedKeyFor(row.provider)) ?? "" };
  }

  async headersFor(provider: string, modelId: string): Promise<Record<string, string> | undefined> {
    const row = this.sql<{ headersEnc: string | null }>`SELECT headersEnc FROM sh_saved_model WHERE provider = ${provider} AND modelId = ${modelId}`[0];
    if (!row?.headersEnc) return undefined;
    const opened = await openSecret(await this.deps.serverKeys(), row.headersEnc);
    return opened ? JSON.parse(opened.text) as Record<string, string> : undefined;
  }

  async modelCredentialHash(apiKey: string, headers?: Record<string, string>): Promise<string> {
    const canonical = JSON.stringify([apiKey, Object.entries(headers ?? {}).sort(([a], [b]) => a.localeCompare(b))]);
    return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical))), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  async verifiedModels(): Promise<{ provider: string; modelId: string }[]> {
    const rows = this.sql<{ provider: string; modelId: string; baseUrl: string; credentialHash: string }>`
      SELECT provider, modelId, baseUrl, credentialHash FROM sh_verified_model
    `;
    const saved = this.savedModels();
    const keys = new Map<string, string | null>();
    const verified: { provider: string; modelId: string }[] = [];
    for (const row of rows) {
      if (!saved.some((entry) => entry.provider === row.provider && entry.modelId === row.modelId && (entry.baseUrl ?? "") === row.baseUrl)) continue;
      if (!keys.has(row.provider)) keys.set(row.provider, await this.sealedKeyFor(row.provider));
      const key = keys.get(row.provider);
      if (key && row.credentialHash === await this.modelCredentialHash(key, await this.headersFor(row.provider, row.modelId))) verified.push({ provider: row.provider, modelId: row.modelId });
    }
    return verified;
  }

  async acceptedThinkingLevels(provider: string, modelId: string, baseUrl?: string): Promise<ModelThinkingLevel[] | null> {
    const row = this.sql<{ credentialHash: string; levelsJson: string }>`
      SELECT credentialHash, levelsJson FROM sh_model_thinking_probe
      WHERE provider = ${provider} AND modelId = ${modelId} AND baseUrl = ${baseUrl ?? ""}
    `[0];
    if (!row) return null;
    const key = await this.sealedKeyFor(provider);
    if (!key || row.credentialHash !== await this.modelCredentialHash(key, await this.headersFor(provider, modelId))) return null;
    try { return JSON.parse(row.levelsJson) as ModelThinkingLevel[]; } catch { return null; }
  }

  /**
   * The levels the picker may offer, in the order the owner last described them: a measured
   * probe result wins over the owner's declaration, which wins over "not described yet" — the
   * picker then shows every level, marked unverified, instead of a greyed-out single option.
   */
  async thinkingLevelsFor(provider: string, modelId: string, baseUrl?: string): Promise<ModelThinkingLevel[] | null> {
    return await this.acceptedThinkingLevels(provider, modelId, baseUrl)
      ?? declaredThinkingLevels(this.savedModels().find((entry) => entry.provider === provider && entry.modelId === modelId)?.thinkingJson)
      ?? null;
  }

  /**
   * One connection test plus (for a compatible gateway) the level probes, recording both in
   * sh_verified_model / sh_model_thinking_probe. A successful probe proves the endpoint
   * *accepted* a level, not that it honored reasoning. `force` is the manual test button;
   * a save reuses a result already measured for the same key+endpoint so nothing is spent twice.
   */
  async verifyAndProbe(
    input: { provider: string; modelId: string; baseUrl?: string; apiKey?: string; headers?: Record<string, string>; thinkingLevel?: StewardThinkingLevel },
    options: { force: boolean; record?: boolean },
  ): Promise<{ ok: true; acceptedThinkingLevels?: ModelThinkingLevel[]; cached?: boolean } | { ok: false; error: ConnectionTestError }> {
    const config = { provider: input.provider, modelId: input.modelId, explicit: true, ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}) };
    const apiKey = input.apiKey ?? await this.sealedKeyFor(input.provider) ?? undefined;
    const headers = input.headers ?? await this.headersFor(input.provider, input.modelId);
    const hash = apiKey ? await this.modelCredentialHash(apiKey, headers) : undefined;
    const probesLevels = input.provider === "openai-compatible" && Boolean(input.baseUrl);
    if (!options.force && probesLevels && hash) {
      const row = this.sql<{ levelsJson: string }>`SELECT levelsJson FROM sh_model_thinking_probe
        WHERE provider = ${input.provider} AND modelId = ${input.modelId} AND baseUrl = ${input.baseUrl ?? ""} AND credentialHash = ${hash}`[0];
      if (row) {
        try { return { ok: true, acceptedThinkingLevels: JSON.parse(row.levelsJson) as ModelThinkingLevel[], cached: true }; } catch { /* re-probe an unreadable row */ }
      }
    }
    // A gateway's "auto" sends no reasoning field at all, so the connection test stays neutral.
    const result = await testModelConnection({ ...config, ...(headers ? { headers } : {}), ...(probesLevels ? { thinkingLevel: "auto" as const } : {}) }, apiKey);
    if (!result.ok) return { ok: false, error: result.error };
    if (apiKey && hash) {
      if (options.record !== false) this.sql`
        INSERT INTO sh_verified_model (provider, modelId, baseUrl, credentialHash, verifiedAt)
        VALUES (${input.provider}, ${input.modelId}, ${input.baseUrl ?? ""}, ${hash}, ${Date.now()})
        ON CONFLICT(provider, modelId, baseUrl) DO UPDATE SET credentialHash = excluded.credentialHash, verifiedAt = excluded.verifiedAt
      `;
      if (probesLevels) {
        // Seven bounded, billable completions — one per level — only ever after a test the
        // owner asked for (a save with auto-test, or the test button).
        const accepted = await probeAcceptedThinkingLevels({ ...config, ...(headers ? { headers } : {}) }, apiKey);
        if (options.record !== false) this.sql`
          INSERT INTO sh_model_thinking_probe (provider, modelId, baseUrl, credentialHash, levelsJson, probedAt)
          VALUES (${input.provider}, ${input.modelId}, ${input.baseUrl ?? ""}, ${hash}, ${JSON.stringify(accepted)}, ${Date.now()})
          ON CONFLICT(provider, modelId, baseUrl) DO UPDATE SET credentialHash = excluded.credentialHash,
            levelsJson = excluded.levelsJson, probedAt = excluded.probedAt
        `;
        return { ok: true, acceptedThinkingLevels: accepted };
      }
    }
    return { ok: true };
  }

  async thinkingProbes(): Promise<{ provider: string; modelId: string; acceptedLevels: ModelThinkingLevel[] }[]> {
    const saved = this.savedModels();
    const result: { provider: string; modelId: string; acceptedLevels: ModelThinkingLevel[] }[] = [];
    for (const entry of saved.filter((item) => item.provider === "openai-compatible")) {
      const acceptedLevels = await this.acceptedThinkingLevels(entry.provider, entry.modelId, entry.baseUrl ?? undefined);
      if (acceptedLevels) result.push({ provider: entry.provider, modelId: entry.modelId, acceptedLevels });
    }
    return result;
  }

  /**
   * Read-only diagnostics for the merged model selection (issue #6 × #25/#27): what the
   * deploy config and the sealed row resolve to, and whether a usable key exists. The
   * optional `varsRaw` override exists so tests can exercise the unset-vars precedence
   * without rebinding the environment.
   */
  async llmSelection(varsRaw?: unknown): Promise<{
    provider: string;
    modelId: string;
    baseUrl: string | null;
    explicitVars: boolean;
    sealedProvider: string | null;
    apiKey: boolean;
    /** False when the selection cannot be addressed at all — runs would settle `unanswered`
     *  with `no_model` (review #10); ensureRootModel logs model_config_error. A model id the
     *  catalog does not ship counts as known when the selection also names its endpoint
     *  (resolveCatalogModel). */
    modelKnown: boolean;
    thinkingLevel: StewardThinkingLevel;
    thinkingLevels: StewardThinkingLevel[];
  }> {
    const sealed = await this.modelConfig();
    // `varsRaw: null` models an unset deploy config; `undefined` (the production call) reads env.
    const vars = resolveModelConfig(varsRaw === undefined ? this.deps.stewardModelVars() : varsRaw);
    const config = mergeModelSelection(sealed, vars);
    const accepted = await this.thinkingLevelsFor(config.provider, config.modelId, config.baseUrl);
    if (config.thinkingLevel !== "auto" && accepted && !accepted.includes(config.thinkingLevel ?? "off")) config.thinkingLevel = "auto";
    const levels = config.provider === "openai-compatible" && config.baseUrl
      ? await this.thinkingLevelsFor(config.provider, config.modelId, config.baseUrl)
      : null;
    return {
      provider: config.provider,
      modelId: config.modelId,
      ...resolveModelThinking(config),
      ...(config.provider === "openai-compatible" && config.baseUrl ? {
        thinkingLevels: (levels ? ["auto", ...levels] : COMPATIBLE_THINKING_LEVELS) as StewardThinkingLevel[],
      } : {}),
      baseUrl: config.baseUrl ?? null,
      explicitVars: vars.explicit,
      sealedProvider: sealed?.provider ?? null,
      apiKey: Boolean(sealed && sealed.provider === config.provider && sealed.apiKey),
      modelKnown: config.provider === "faux" || resolveCatalogModel(config) !== undefined,
    };
  }
}

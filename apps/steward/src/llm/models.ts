// Steward model configuration and provider construction (issue #6, ADR-0001 decision 11,
// spike-conclusions bug 7): inside Workers never resolve API keys from environment variables —
// the provider is built with an inline `auth.apiKey.resolve` closure over the deploy-config
// secret, on a rebuilt copy of the catalog provider. The `faux` provider id is the test hook:
// vitest binds STEWARD_MODEL accordingly and scripts replies through Steward.fauxScript.
import {
  createModels,
  getSupportedThinkingLevels,
  clampThinkingLevel,
  createProvider,
  type MutableModels,
  type Provider,
} from "@earendil-works/pi-ai/models";
import { providerInfo, type ProviderInfo } from "./provider-info.ts";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { MODEL_THINKING_LEVELS } from "@earendil-works/pi-ai/providers/model-schema";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { Api, AssistantMessage, Model, TranscriptContext } from "@earendil-works/pi-ai";
import { fauxProvider, type FauxProviderHandle } from "@earendil-works/pi-ai/providers/faux";

/** The deploy-config shape (`vars.STEWARD_MODEL` in the root wrangler.jsonc). */
export type StewardThinkingLevel = ModelThinkingLevel | "auto";
export const COMPATIBLE_THINKING_LEVELS: StewardThinkingLevel[] = ["auto", "off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** A gateway model has no catalog entry, so its owner writes down what Pi would have shipped
 *  as static metadata: the levels this endpoint accepts. Displayed immediately, never probed. */
export interface ThinkingDeclaration {
  thinkingLevels: ModelThinkingLevel[];
  default?: ModelThinkingLevel;
}

const THINKING_LEVEL_NAMES = COMPATIBLE_THINKING_LEVELS.filter((level): level is ModelThinkingLevel => level !== "auto");

/**
 * Reads the same shapes a Pi catalog entry carries — `["low","high"]`,
 * `{"thinkingLevels":[…],"default":"low"}`, or `{"thinkingLevelMap":{"low":"low","max":null}}`
 * (a null value marks a level the model does not have). Returns undefined for anything else, so
 * a typo is rejected instead of quietly widening the picker back to every level.
 */
export function parseThinkingDeclaration(raw: unknown): ThinkingDeclaration | undefined {
  const listed = (input: unknown): ModelThinkingLevel[] | undefined => {
    if (!Array.isArray(input) || input.length === 0 || input.length > THINKING_LEVEL_NAMES.length) return undefined;
    const levels: ModelThinkingLevel[] = [];
    for (const entry of input) {
      if (typeof entry !== "string" || !THINKING_LEVEL_NAMES.includes(entry as ModelThinkingLevel)) return undefined;
      if (!levels.includes(entry as ModelThinkingLevel)) levels.push(entry as ModelThinkingLevel);
    }
    return levels;
  };
  const named = (input: unknown): ModelThinkingLevel | undefined =>
    typeof input === "string" && THINKING_LEVEL_NAMES.includes(input as ModelThinkingLevel) ? input as ModelThinkingLevel : undefined;
  const levels = Array.isArray(raw)
    ? listed(raw)
    : typeof raw === "object" && raw !== null && "thinkingLevels" in raw
      ? listed((raw as { thinkingLevels: unknown }).thinkingLevels)
      : typeof raw === "object" && raw !== null && "thinkingLevelMap" in raw && typeof (raw as { thinkingLevelMap: unknown }).thinkingLevelMap === "object"
        ? listed(Object.entries((raw as { thinkingLevelMap: Record<string, unknown> }).thinkingLevelMap)
          .filter(([name, value]) => value !== null && THINKING_LEVEL_NAMES.includes(name as ModelThinkingLevel))
          .map(([name]) => name))
        : undefined;
  if (!levels || levels.length === 0) return undefined;
  const fallback = typeof raw === "object" && raw !== null ? (raw as { default?: unknown }).default : undefined;
  return { thinkingLevels: THINKING_LEVEL_NAMES.filter((level) => levels.includes(level)), ...(named(fallback) ? { default: fallback as ModelThinkingLevel } : {}) };
}

/** The stored declaration, as the picker sees it. Undefined when absent or unreadable. */
export function declaredThinkingLevels(raw: string | null | undefined): ModelThinkingLevel[] | undefined {
  if (!raw) return undefined;
  try {
    return parseThinkingDeclaration(JSON.parse(raw))?.thinkingLevels;
  } catch {
    return undefined;
  }
}

export interface StewardModelConfig {
  provider: string;
  modelId: string;
  /** Overrides the provider's catalog base URL (self-hosted / proxy endpoints). */
  baseUrl?: string;
  thinkingLevel?: StewardThinkingLevel;
  headers?: Record<string, string>;
  /** True when the deploy config actually named a provider/model — the sealed sh_model row's
   *  provider only wins when this is false, UNLESS the row itself carries an explicit
   *  modelId (a runtime switch, issue #70), which wins unconditionally (see
   *  mergeModelSelection). */
  explicit: boolean;
}

/** The sealed sh_model row, as steward.ts's modelConfig() reads it back. */
export interface SealedModelSelection {
  provider: string;
  /** Set only by an owner-driven runtime switch (issue #70's Settings page); null for the
   *  legacy MODEL_KEY seed or a pre-#70 provider-only setModelConfig call. */
  modelId: string | null;
  baseUrl: string | null;
  apiKey: string;
  thinkingLevel?: StewardThinkingLevel;
}

/**
 * The precedence rule for the effective model selection (steward.ts ensureRootModel and
 * llmSelection share this): a runtime switch's own modelId (issue #70) wins over
 * vars.STEWARD_MODEL entirely — that is the point of letting the owner switch at runtime
 * without a redeploy. Short of that, a legacy sealed row (provider only, no modelId) picks
 * the provider when vars are unset; the deploy config alone otherwise.
 */
export function mergeModelSelection(sealed: SealedModelSelection | null, vars: StewardModelConfig): StewardModelConfig {
  if (sealed?.modelId) {
    return { provider: sealed.provider, modelId: sealed.modelId, explicit: true, ...(sealed.thinkingLevel ? { thinkingLevel: sealed.thinkingLevel } : {}), ...(sealed.baseUrl ? { baseUrl: sealed.baseUrl } : {}) };
  }
  return sealed && !vars.explicit ? { ...vars, provider: sealed.provider } : vars;
}

/** ADR-0001 decision 11: the eval baseline. Changing it requires re-running the routing eval. */
export const DEFAULT_MODEL_CONFIG: StewardModelConfig = { provider: "deepseek", modelId: "deepseek-flash", explicit: false };

/** One catalog provider as the Settings page sees it (issue #74): pickable models included. */
export interface ProviderCatalogEntry {
  id: string;
  name: string;
  info?: ProviderInfo;
  models: Array<{ id: string; name: string; baseUrl: string; api: string; thinkingLevels: StewardThinkingLevel[]; defaultThinkingLevel: StewardThinkingLevel }>;
}

/** Keep legacy Coding Plan IDs stable so existing encrypted keys remain usable. */
export function stewardProviders(): Provider[] {
  const providers = builtinProviders();
  const apiVariants = [
    { source: "zai", id: "zai-api", baseUrl: "https://api.z.ai/api/paas/v4" },
    { source: "zai-coding-cn", id: "zai-api-cn", baseUrl: "https://open.bigmodel.cn/api/paas/v4" },
  ];
  for (const { source, id, baseUrl } of apiVariants) {
    const base = providers.find((provider) => provider.id === source);
    if (!base) throw new Error(`Missing catalog provider: ${source}`);
    providers.push(createProvider({
      id, name: base.name, baseUrl, auth: {},
      models: base.getModels().map((model) => ({ ...model, provider: id, baseUrl })),
      api: { stream: base.stream.bind(base), streamSimple: base.streamSimple.bind(base) },
    }));
  }
  // A generic OpenAI Chat Completions endpoint must not inherit OpenAI's Responses API
  // dialect. Reuse a completions adapter under its own provider id and credential slot.
  const completions = providers.find((provider) => provider.id === "deepseek");
  if (!completions) throw new Error("Missing catalog provider: deepseek");
  providers.push(createProvider({
    id: "openai-compatible", name: "OpenAI-compatible endpoint", baseUrl: "https://example.invalid/v1",
    auth: {},
    models: completions.getModels().filter((model) => model.api === "openai-completions").map((model) => ({ ...model, provider: "openai-compatible", baseUrl: "https://example.invalid/v1" })),
    api: { stream: completions.stream.bind(completions), streamSimple: completions.streamSimple.bind(completions) },
  }));
  const anthropic = providers.find((provider) => provider.id === "anthropic");
  if (!anthropic) throw new Error("Missing catalog provider: anthropic");
  providers.push(createProvider({
    id: "anthropic-compatible", name: "Anthropic-compatible endpoint", baseUrl: "https://example.invalid",
    auth: {},
    models: anthropic.getModels().filter((model) => model.api === "anthropic-messages").map((model) => ({ ...model, provider: "anthropic-compatible", baseUrl: "https://example.invalid" })),
    api: { stream: anthropic.stream.bind(anthropic), streamSimple: anthropic.streamSimple.bind(anthropic) },
  }));
  return providers;
}

let catalogMemo: ProviderCatalogEntry[] | undefined;

/** The builtin provider catalog (id, display name, chat models) — the list the Settings
 *  dialog picks from. Static per deployment, so memoized; the shape is intentionally flat
 *  and JSON-friendly (it rides /app/api/settings). */
export function providerCatalog(): ProviderCatalogEntry[] {
  if (!catalogMemo) {
    catalogMemo = stewardProviders().filter((provider) => provider.getModels().length > 0 || provider.id === "openai-compatible" || provider.id === "anthropic-compatible").map((provider) => ({
      id: provider.id,
      name: provider.name,
      info: providerInfo(provider.id, provider.name),
      models: provider.id.endsWith("-compatible") ? [] : provider.getModels().map((model) => ({ id: model.id, name: model.name, baseUrl: model.baseUrl, api: model.api, thinkingLevels: getSupportedThinkingLevels(model), defaultThinkingLevel: clampThinkingLevel(model, "off") })).sort((a, b) => {
        if (provider.id !== "openai") return 0;
        const version = (id: string) => /^gpt-(\d+)(?:\.(\d+))?/.exec(id);
        const av = version(a.id), bv = version(b.id);
        if (!av || !bv) return Number(Boolean(bv)) - Number(Boolean(av));
        return Number(bv[1]) - Number(av[1]) || Number(bv[2] ?? 0) - Number(av[2] ?? 0) || b.id.localeCompare(a.id, undefined, { numeric: true });
      }),
    }));
  }
  return catalogMemo;
}

export function isThinkingLevel(value: unknown): value is StewardThinkingLevel {
  return value === "auto" || MODEL_THINKING_LEVELS.some((level) => value === level);
}

/**
 * The model entry a config actually addresses: the catalog's own, or — when the config names an
 * endpoint the catalog does not ship a model for — a clone of the provider's sibling entry
 * re-keyed to the configured id. Self-hosted OpenAI-compatible gateways front DeepSeek with
 * their own snapshot names (`deepseek-v4.1-flash-1017`, served at `POST /v1/chat/completions`),
 * and the wire body carries `model.id`, so the id has to be the gateway's own.
 *
 * Synthesis requires an explicit `baseUrl`: without one, a typo must keep failing visibly as
 * `no_model` (review #10) instead of sending an invented name to a first-party endpoint.
 */
export function resolveCatalogModel(config: StewardModelConfig): Model<Api> | undefined {
  const base = stewardProviders().find((provider) => provider.id === config.provider);
  if (!base) return undefined;
  const models = base.getModels();
  const known = models.find((model) => model.id === config.modelId);
  if (!config.provider.endsWith("-compatible") && (known !== undefined || !config.baseUrl)) return known;
  if (!config.baseUrl) return undefined;
  // The sibling donates the dialect (api, compat, reasoning map, context window): a gateway
  // proxying one vendor's models speaks that vendor's request shape.
  const sibling = known ?? models.find((model) => model.api === (config.provider === "anthropic-compatible" ? "anthropic-messages" : "openai-completions")) ?? models[0];
  if (sibling === undefined) return undefined;
  if (config.provider === "openai-compatible") {
    // A gateway model must not inherit another model's thinking-level map.
    // Auto omits both reasoning_effort and the DeepSeek thinking=disabled flag.
    return { ...sibling, id: config.modelId, name: config.modelId, baseUrl: config.baseUrl,
      reasoning: true, thinkingLevelMap: {
        off: config.thinkingLevel === "auto" || config.thinkingLevel === undefined ? null : undefined,
        minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max",
      } };
  }
  return { ...sibling, id: config.modelId, name: config.modelId, baseUrl: config.baseUrl };
}

export function resolveModelThinking(config: StewardModelConfig): { thinkingLevel: StewardThinkingLevel; thinkingLevels: StewardThinkingLevel[] } {
  if (config.provider === "openai-compatible" && config.baseUrl) return {
    thinkingLevel: config.thinkingLevel ?? "auto", thinkingLevels: COMPATIBLE_THINKING_LEVELS,
  };
  const model = resolveCatalogModel(config);
  return model
    ? { thinkingLevel: clampThinkingLevel(model, config.thinkingLevel === "auto" ? "off" : config.thinkingLevel ?? "off"), thinkingLevels: getSupportedThinkingLevels(model) }
    : { thinkingLevel: "off", thinkingLevels: ["off"] };
}

export type ModelSwitchInput = Pick<StewardModelConfig, "provider" | "modelId" | "baseUrl" | "thinkingLevel" | "headers"> & {
  apiKey?: string;
  importedModelIds?: string[];
  /** The owner's written-down level list for a gateway model, as canonical JSON (models.ts
   *  parseThinkingDeclaration), or null to clear it. */
  thinkingJson?: string | null;
  /** Save a sealed candidate, test it, then attempt guarded activation. False/omitted saves
   *  only a candidate; it never enables unchecked configuration. Tests may use provider credits. */
  autoTest?: boolean;
};

/** Workspace lifecycle result. Only explicit `activated: true` permits the UI to advance
 *  onboarding. Saving/testing alone never replaces live credentials, headers or selection.
 *  Optional fields retain compatibility with older API test doubles. */
export interface ModelSaveResult {
  ok: true;
  activated?: boolean;
  status?: 'saved' | 'verification_failed' | 'verified' | 'activated' | 'busy' | 'conflict';
  draftId?: string;
  revision?: number;
  verified?: boolean;
  testError?: string;
  acceptedThinkingLevels?: ModelThinkingLevel[];
}
export type ComposerModelInput = Pick<StewardModelConfig, "provider" | "modelId"> & { thinkingLevel: StewardThinkingLevel };

/** Parses `vars.STEWARD_MODEL`; anything malformed falls back to the default. */
export function resolveModelConfig(raw: unknown): StewardModelConfig {
  let parsed: unknown = raw;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return { ...DEFAULT_MODEL_CONFIG };
    }
  }
  if (parsed === null || typeof parsed !== "object") return { ...DEFAULT_MODEL_CONFIG };
  const cfg = parsed as { provider?: unknown; modelId?: unknown; baseUrl?: unknown; thinkingLevel?: unknown };
  if (typeof cfg.provider !== "string" || typeof cfg.modelId !== "string" || !cfg.provider || !cfg.modelId) {
    return { ...DEFAULT_MODEL_CONFIG };
  }
  return {
    provider: cfg.provider,
    modelId: cfg.modelId,
    explicit: true,
    ...(isThinkingLevel(cfg.thinkingLevel) ? { thinkingLevel: cfg.thinkingLevel } : {}),
    ...(typeof cfg.baseUrl === "string" && cfg.baseUrl.length > 0 ? { baseUrl: cfg.baseUrl } : {}),
  };
}

/**
 * Rebuilds a catalog provider with an inline API-key auth (spike bug 7): the resolve closure
 * returns the deploy-config secret directly — no ambient environment lookup happens inside
 * the Worker. A missing key keeps the provider registered but unconfigured, so model calls
 * fail loudly instead of silently trying `DEEPSEEK_API_KEY`.
 */
export function providerWithInlineKey(base: Provider, apiKey: string | undefined, baseUrl?: string, extraModels: readonly Model<Api>[] = [], headers?: Record<string, string>): Provider {
  return createProvider({
    id: base.id,
    name: base.name,
    baseUrl: baseUrl ?? base.baseUrl,
    headers: { ...base.headers, ...headers },
    auth: {
      apiKey: {
        name: `${base.name} API key`,
        resolve: async () => (apiKey ? { auth: { apiKey, ...(baseUrl ? { baseUrl } : {}), ...(headers ? { headers } : {}) }, source: "deploy config" } : undefined),
      },
    },
    models: [...base.getModels().filter((entry) => !extraModels.some((extra) => extra.id === entry.id)), ...extraModels],
    api: {
      stream: base.stream.bind(base),
      streamSimple: base.streamSimple.bind(base),
      ...(base.fetchDeferred ? { fetchDeferred: base.fetchDeferred.bind(base) } : {}),
      ...(base.cancelDeferred ? { cancelDeferred: base.cancelDeferred.bind(base) } : {}),
    },
  });
}

/** The catalog provider a conversation runs on: inline key, endpoint override, and the
 *  configured model registered too when the catalog does not ship it (resolveCatalogModel). */
export function providerForConfig(base: Provider, config: StewardModelConfig, apiKey: string | undefined): Provider {
  const model = resolveCatalogModel(config);
  const extra = model !== undefined && (config.provider.endsWith("-compatible") || !base.getModels().some((entry) => entry.id === model.id)) ? [model] : [];
  return providerWithInlineKey(base, apiKey, config.baseUrl, extra, config.headers);
}

/** One captured model request, as the test scaffolding sees it (after beforeRequest). */
export interface FauxRequestRecord {
  at: number;
  /** The last user message's text — the exact input the model received. */
  userText: string;
  /** The `otto-situation` section of the outgoing system prompt, if the hook injected one. */
  brief: string | null;
  /** The `otto-notes` section (resident-layer memory, issue #18), when present. */
  notes: string | null;
  lastToolResult: string;
}

/** The test-side scripting surface over the in-DO faux provider. */
export interface FauxScripting {
  /** FIFO steps; each provider call consumes one. Steps run out → a plain default reply. */
  setSteps(steps: AssistantMessage[]): void;
  requests(): FauxRequestRecord[];
  reset(): void;
  /** Replies arrive word by word at this rate (tokens per second) instead of all at once — what a live
   *  view needs to see a reply being written. `undefined` restores the instant default. */
  streamAt(tokensPerSecond: number | undefined): void;
}

export interface StewardModels {
  models: MutableModels;
  config: StewardModelConfig;
  /** Present only for the `faux` test provider. */
  faux?: FauxScripting;
}

/**
 * Installs/updates the configured provider on an existing (mutable) Models collection —
 * the PiHarness factory hands pi one collection for the isolate's lifetime, and the sealed
 * key (readable only after migrations) is installed onto that same object later. Idempotent;
 * the faux provider is never touched (its in-memory script is per-isolate state).
 */
export function installModel(models: MutableModels, config: StewardModelConfig, apiKey: string | undefined): void {
  if (config.provider === "faux") return;
  const base = stewardProviders().find((p) => p.id === config.provider);
  if (!base) return; // unknown provider: registers nothing — runs fail visibly as no_model
  models.setProvider(providerForConfig(base, config, apiKey));
}

const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part: unknown) =>
      typeof part === "object" && part !== null && "type" in part && (part as { type: string }).type === "text"
        ? [(part as { text?: string }).text ?? ""]
        : [],
    )
    .join("");
};

/**
 * Builds the `Models` collection for the PiHarness factory. `faux` constructs the scripted
 * provider with a single recording response factory: every model request is captured for
 * assertions, and the FIFO script decides the reply (a benign default when it runs dry, so an
 * unscripted DO never wedges a run).
 */
export function buildStewardModels(config: StewardModelConfig, apiKey: string | undefined): StewardModels {
  if (config.provider === "faux") {
    const makeFaux = (tokensPerSecond?: number): FauxProviderHandle =>
      fauxProvider({ models: [{ id: config.modelId, name: "Faux" }], ...(tokensPerSecond === undefined ? {} : { tokensPerSecond }) });
    const steps: AssistantMessage[] = [];
    const requests: FauxRequestRecord[] = [];
    const factory = async (context: TranscriptContext): Promise<AssistantMessage> => {
      const messages = [...context.messages];
      const lastUser = [...messages].reverse().find((m) => m.role === "user");
      const lastToolResult = [...messages].reverse().find((m) => m.role === "toolResult");
      // Replay the sections the way the provider will (transcript.js): every system message
      // patches by name, null removes. A delta-appended section (otto-notes) must be
      // visible here exactly as the model receives it after the collapse into one prompt.
      const sections = new Map<string, string>();
      for (const message of messages) {
        if (message.role !== "system") continue;
        for (const [name, value] of Object.entries((message as { sections?: Record<string, string | null> }).sections ?? {})) {
          if (value === null) sections.delete(name);
          else sections.set(name, value);
        }
      }
      requests.push({
        at: Date.now(),
        userText: textOf((lastUser as { content?: unknown } | undefined)?.content),
        brief: sections.get("otto-situation") ?? null,
        notes: sections.get("otto-notes") ?? null,
        lastToolResult: textOf((lastToolResult as { content?: unknown } | undefined)?.content),
      });
      if (requests.length > 50) requests.shift();
      const step = steps.shift();
      // `{ waitForMs, text }` steps delay the reply — the no-nudge alarm tests use them to
      // keep a run open across several real alarm cycles (review #1's regression coverage).
      if (step !== undefined && "waitForMs" in (step as unknown as Record<string, unknown>)) {
        const delayed = step as unknown as { waitForMs: number; text: string };
        await new Promise((resolve) => setTimeout(resolve, delayed.waitForMs));
        return {
          role: "assistant",
          content: [{ type: "text", text: delayed.text }],
          api: "faux",
          provider: "faux",
          model: config.modelId,
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "stop",
          timestamp: Date.now(),
        } satisfies AssistantMessage;
      }
      return (
        step ?? {
          role: "assistant",
          content: [{ type: "text", text: "(faux: 未脚本化的回复)" }],
          api: "faux",
          provider: "faux",
          model: config.modelId,
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "stop",
          timestamp: Date.now(),
        }
      );
    };
    // Faux consumes one response entry per provider call: register many copies of the same
    // recording factory (the spike did the same), so it never runs out mid-conversation.
    const install = (tokensPerSecond?: number): void => {
      const faux = makeFaux(tokensPerSecond);
      faux.setResponses(Array.from({ length: 1000 }, () => factory));
      models.setProvider(faux.provider);
    };
    const models = createModels();
    install();
    return {
      models,
      config,
      faux: {
        setSteps: (s) => steps.push(...s),
        requests: () => [...requests],
        reset: () => {
          steps.splice(0, steps.length);
          requests.splice(0, requests.length);
          install(); // back to instant replies
        },
        streamAt: (tokensPerSecond) => install(tokensPerSecond),
      },
    };
  }

  const base = stewardProviders().find((p) => p.id === config.provider);
  const models = createModels();
  if (!base) {
    // Unknown provider id: register nothing. The root session's model stays unresolvable and
    // runs settle `unanswered` with `no_model` — visible in sh_run, not a silent wrong model.
    return { models, config };
  }
  // An unknown model id is likewise kept as configured (it fails visibly as `no_model`);
  // silently substituting a different model would break the eval-baseline rule.
  models.setProvider(providerForConfig(base, config, apiKey));
  return { models, config };
}

// Runtime model switching (issue #70): the Settings page picks provider + modelId (and
// optionally baseUrl) without a redeploy. Unlike the legacy provider-only
// setModelConfig(provider, apiKey) — which only ever supplies the provider, and only when
// vars.STEWARD_MODEL is unset — a switch that names its own modelId wins over vars
// entirely (llm/models.ts mergeModelSelection): that is the whole point of being able to
// switch at runtime instead of editing vars and redeploying.
import { SELF, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Steward } from "../src/steward.ts";
import type { ModelSwitchInput } from '../src/llm/models.ts';
import type { ModelConfigStore } from '../src/model-config.ts';

// Trusted fixture setup only. Workspace saves now create candidates, not live settings.
async function seed(input: ModelSwitchInput) {
  await ownerStub().setModelConfig(input.provider, input.apiKey, input.modelId, input.baseUrl, input.thinkingLevel, input.headers, input.thinkingJson);
}
type Internals = { modelConfigStore: ModelConfigStore; sql: Sql; testingModel: boolean };
import { ownerStub, webLogin } from "./helpers.ts";

type Sql = (strings: TemplateStringsArray, ...values: unknown[]) => unknown;

const BASE = "https://example.com";

async function clearModelRow(): Promise<void> {
  // An RPC first, so onStart's migrations have run (the raw SQL below would otherwise hit a
  // cold DO with no sh_* tables yet — same reasoning as resetChannelState).
  await ownerStub().channelLogEntries(1);
  await runInDurableObject(ownerStub(), (instance: Steward) => {
    (instance as unknown as { sql: Sql }).sql.bind(instance)`DELETE FROM sh_model`;
    (instance as unknown as { sql: Sql }).sql.bind(instance)`DELETE FROM sh_provider_key`;
    (instance as unknown as { sql: Sql }).sql.bind(instance)`DELETE FROM sh_saved_model`;
    (instance as unknown as { sql: Sql }).sql.bind(instance)`DELETE FROM sh_verified_model`;
    (instance as unknown as { sql: Sql }).sql.bind(instance)`DELETE FROM sh_model_thinking_probe`;
    (instance as unknown as { sql: Sql }).sql.bind(instance)`DELETE FROM sh_model_draft`;
  });
}

// sh_model/sh_provider_key survive between test files (the DO's SQLite is never rolled back) and, once
// a switch sets an explicit modelId, it wins over every other test's vars.STEWARD_MODEL = faux
// binding. Clear both on both sides so nothing here leaks into a later file.
beforeEach(clearModelRow);
afterEach(clearModelRow);

describe("mergeModelSelection via setModelConfig/llmSelection (RPC level)", () => {
  it("a runtime switch's modelId wins over an explicit vars.STEWARD_MODEL (the test env binds faux)", async () => {
    const before = await ownerStub().llmSelection();
    expect(before).toMatchObject({ provider: "faux", modelId: "faux-1", explicitVars: true });

    await ownerStub().setModelConfig("anthropic", "sk-ant-switch", "claude-sonnet-x");
    const after = await ownerStub().llmSelection();
    expect(after).toMatchObject({ provider: "anthropic", modelId: "claude-sonnet-x", apiKey: true });
  });

  it("carries an optional baseUrl through the switch", async () => {
    await ownerStub().setModelConfig("openai", "sk-openai-switch", "gpt-x", "https://proxy.example/v1");
    const selected = await ownerStub().llmSelection();
    expect(selected).toMatchObject({ provider: "openai", modelId: "gpt-x", baseUrl: "https://proxy.example/v1" });
  });

  it("round-trips modelId/baseUrl through modelConfig(), sealed like the key", async () => {
    await ownerStub().setModelConfig("openai", "sk-openai-roundtrip", "gpt-y", "https://proxy.example/v2");
    expect(await ownerStub().modelConfig()).toEqual({
      provider: "openai",
      modelId: "gpt-y",
      baseUrl: "https://proxy.example/v2",
      apiKey: "sk-openai-roundtrip",
    });
  });

  it("a later switch without modelId falls back to legacy (provider-only) precedence, not stuck on the old modelId", async () => {
    await ownerStub().setModelConfig("anthropic", "sk-ant-1", "claude-a");
    expect(await ownerStub().llmSelection()).toMatchObject({ provider: "anthropic", modelId: "claude-a" });

    // The pre-#70 form (provider + key only): clears the sticky modelId, reverting to
    // "provider only wins when vars are unset" — vars.STEWARD_MODEL here is explicit (faux),
    // so the deploy config is back in charge entirely.
    await ownerStub().setModelConfig("anthropic", "sk-ant-2");
    expect(await ownerStub().llmSelection()).toMatchObject({ provider: "faux", modelId: "faux-1" });
  });
});

describe("per-provider keys (issue #74)", () => {
  it("keeps each provider's key when switching between them, and switching back needs no re-entry", async () => {
    await ownerStub().setModelConfig("anthropic", "sk-ant-a", "claude-a");
    await ownerStub().setModelConfig("openai", "sk-openai-b", "gpt-b");
    expect(await ownerStub().keyedProviders()).toEqual(["anthropic", "openai"]);

    // No apiKey given: the selection moves back to anthropic and picks up its sealed key.
    await ownerStub().setModelConfig("anthropic", undefined, "claude-a2");
    expect(await ownerStub().modelConfig()).toMatchObject({ provider: "anthropic", modelId: "claude-a2", apiKey: "sk-ant-a" });
  });

  it("a keyless switch resolves with an empty key and reports apiKey: false", async () => {
    await ownerStub().setModelConfig("deepseek", undefined, "deepseek-flash");
    expect(await ownerStub().modelConfig()).toMatchObject({ provider: "deepseek", modelId: "deepseek-flash", apiKey: "" });
    expect(await ownerStub().llmSelection()).toMatchObject({ provider: "deepseek", modelId: "deepseek-flash", apiKey: false });
  });

  it("mirrors the selected provider's key in sh_model, so a pre-#74 reader stays consistent", async () => {
    await ownerStub().setModelConfig("anthropic", "sk-ant-mirror", "claude-m");
    await ownerStub().setModelConfig("openai", "sk-openai-mirror", "gpt-m");
    const rows = await runInDurableObject(ownerStub(), (instance: Steward) =>
      (instance as unknown as { sql: Sql }).sql.bind(instance)`SELECT provider, apiKeyEnc FROM sh_model WHERE id = 0` as unknown as { provider: string; apiKeyEnc: string }[],
    );
    expect(rows[0]).toMatchObject({ provider: "openai" });
    expect(rows[0]!.apiKeyEnc.length).toBeGreaterThan(0);
    expect(rows[0]!.apiKeyEnc).not.toContain("sk-openai-mirror");
  });
});

describe("the Settings page's model switch (HTTP level, ADR-0004)", () => {
  async function browser() {
    const cookie = await webLogin();
    const workspace = await (await SELF.fetch(`${BASE}/app/api/workspace`, { headers: { cookie } })).json() as { csrf: string };
    const post = (path: string, body: unknown) =>
      SELF.fetch(`${BASE}/app/api/${path}`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json", "x-csrf-token": workspace.csrf },
        body: JSON.stringify(body),
      });
    const settings = () => SELF.fetch(`${BASE}/app/api/settings`, { headers: { cookie } });
    return { post, settings };
  }

  it("tests saved or draft keys without saving credentials or changing the selected model", async () => {
    const { settings, post } = await browser();
    await seed({ provider: "deepseek", modelId: "deepseek-flash", apiKey: "saved-test-key" });
    const before = await (await settings()).json();
    const saved = await post("settings/model/test", { provider: "deepseek", modelId: "not-in-catalog" });
    expect(await saved.json()).toEqual({ ok: false, error: "unknown_model" });
    const draft = await post("settings/model/test", { provider: "openai", modelId: "not-in-catalog", apiKey: "unsaved-test-key" });
    expect(await draft.json()).toEqual({ ok: false, error: "unknown_model" });
    expect(await (await post("settings/model/test", { provider: "openai", modelId: "not-in-catalog" })).json()).toEqual({ ok: false, error: "missing_key" });
    expect(await (await settings()).json()).toEqual(before);
    expect((await ownerStub().modelConfig())?.apiKey).toBe("saved-test-key");
  });

  it("protects the connection test with CSRF and validates its request", async () => {
    const cookie = await webLogin();
    const forbidden = await SELF.fetch(`${BASE}/app/api/settings/model/test`, {
      method: "POST", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ provider: "deepseek", modelId: "deepseek-flash", apiKey: "test-only" }),
    });
    expect(forbidden.status).toBe(403);
    const { post } = await browser();
    expect((await post("settings/model/test", { provider: "deepseek" })).status).toBe(400);
  });

  it("GET /app/api/settings reports the merged selection, the provider catalog, and which providers have keys (issue #74)", async () => {
    const { settings, post } = await browser();
    const res = await settings();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      model: { provider: string; modelId: string; baseUrl: string | null; apiKey: boolean };
      providers: Array<{ id: string; name: string; models: Array<{ id: string; name: string }> }>;
      keyedProviders: string[];
    };
    expect(body.model).toMatchObject({ provider: "faux", modelId: "faux-1" });
    const deepseek = body.providers.find((provider) => provider.id === "deepseek");
    expect(deepseek?.name).toBe("DeepSeek");
    expect(deepseek?.models.some((model) => model.id === "deepseek-flash")).toBe(true);
    // The test env binds MODEL_KEY, so this first read seeds the default provider's key.
    expect(body.keyedProviders).toEqual(["deepseek"]);

    await seed({ provider: "anthropic", modelId: "claude-sonnet-x", apiKey: "sk-ant-web" });
    const after = (await (await settings()).json()) as { keyedProviders: string[] };
    expect(after.keyedProviders).toEqual(["anthropic", "deepseek"]);
  });

  it("POST saves a sealed candidate without changing the live selection when no test is requested", async () => {
    const { post, settings } = await browser();
    const res = await post("settings/model", { provider: "anthropic", modelId: "claude-sonnet-x", apiKey: "sk-ant-web" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, activated: false, status: 'saved', revision: 1 });

    const after = (await (await settings()).json()) as { model: { provider: string; modelId: string; apiKey: boolean } };
    expect(after.model).toMatchObject({ provider: 'faux', modelId: 'faux-1' });
  });

  it("carries baseUrl through when given", async () => {
    const { post, settings } = await browser();
    await seed({ provider: "openai", modelId: "gpt-x", apiKey: "sk-openai-web", baseUrl: "https://proxy.example/v1" });
    const after = (await (await settings()).json()) as { model: { baseUrl: string | null } };
    expect(after.model.baseUrl).toBe("https://proxy.example/v1");
  });

  it("shows only accepted tiers for the exact saved gateway and invalidates a rotated key", async () => {
    const { post, settings } = await browser();
    await seed({ provider: "openai-compatible", modelId: "deepseek-v4.1-flash", apiKey: "key-a", baseUrl: "https://gateway.example/v1", thinkingLevel: "auto" });
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(["key-a", []])))), (byte) => byte.toString(16).padStart(2, "0")).join("");
    await runInDurableObject(ownerStub(), (instance: Steward) => {
      (instance as unknown as { sql: Sql }).sql.bind(instance)`INSERT INTO sh_model_thinking_probe (provider, modelId, baseUrl, credentialHash, levelsJson, probedAt) VALUES ('openai-compatible', 'deepseek-v4.1-flash', 'https://gateway.example/v1', ${digest}, '["minimal","medium"]', 1)`;
    });
    const body = (await (await settings()).json()) as { thinkingProbes: { acceptedLevels: string[] }[]; model: { thinkingLevels: string[] } };
    expect(body.thinkingProbes[0]?.acceptedLevels).toEqual(["minimal", "medium"]);
    expect(body.model.thinkingLevels).toEqual(["auto", "minimal", "medium"]);
    expect((await post("settings/model/selection", { provider: "openai-compatible", modelId: "deepseek-v4.1-flash", thinkingLevel: "medium" })).status).toBe(200);
    expect((await post("settings/model/selection", { provider: "openai-compatible", modelId: "deepseek-v4.1-flash", thinkingLevel: "max" })).status).toBe(400);
    await seed({ provider: "openai-compatible", modelId: "deepseek-v4.1-flash", apiKey: "key-b", baseUrl: "https://gateway.example/v1", thinkingLevel: "auto" });
    const rotated = (await (await settings()).json()) as { thinkingProbes: unknown[]; model: { thinkingLevels: string[] } };
    expect(rotated.thinkingProbes).toEqual([]);
    // Nothing is declared or measured for the rotated key any more, so the picker stops
    // pretending to know: it lists every level (unverified) instead of a dead "auto" stub.
    expect(rotated.model.thinkingLevels).toEqual(["auto", "off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  });

  it("stores an owner-written level list and narrows the picker to it, immediately", async () => {
    const { post, settings } = await browser();
    await seed({ provider: "openai-compatible", modelId: "gateway-b", apiKey: "key-b", baseUrl: "https://gateway.example/v1", thinkingJson: JSON.stringify(["minimal", "low", "medium", "high"]), thinkingLevel: "max" });
    const body = (await (await settings()).json()) as { savedModels: { modelId: string; thinkingJson: string; thinkingLevels: string[] }[]; model: { thinkingLevel: string; thinkingLevels: string[] } };
    expect(body.savedModels.find((entry) => entry.modelId === "gateway-b")).toMatchObject({ thinkingLevels: ["minimal", "low", "medium", "high"] });
    // A level the owner's own list does not have is dropped back to auto rather than sent.
    expect(body.model.thinkingLevels).toEqual(["auto", "minimal", "low", "medium", "high"]);
    expect(body.model.thinkingLevel).toBe("auto");
    expect((await post("settings/model/selection", { provider: "openai-compatible", modelId: "gateway-b", thinkingLevel: "medium" })).status).toBe(200);
    expect((await post("settings/model/selection", { provider: "openai-compatible", modelId: "gateway-b", thinkingLevel: "xhigh" })).status).toBe(400);
    await seed({ provider: "openai-compatible", modelId: "gateway-b", baseUrl: "https://gateway.example/v1", thinkingJson: null, thinkingLevel: "medium" });
    const after = (await (await settings()).json()) as { model: { thinkingLevels: string[] } };
    expect(after.model.thinkingLevels).toEqual(["auto", "off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  });

  it("rejects a declaration naming a level that does not exist", async () => {
    const { post } = await browser();
    const res = await post("settings/model", { provider: "openai-compatible", modelId: "gateway-c", apiKey: "key-c", baseUrl: "https://gateway.example/v1", thinkingJson: JSON.stringify(["medium", "galaxy"]), thinkingLevel: "auto" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "thinking_levels_invalid" });
  });

  it("a save with auto-test reuses a probe already measured for the same key", async () => {
    const { post } = await browser();
    await seed({ provider: "openai-compatible", modelId: "gateway-d", apiKey: "key-d", baseUrl: "https://gateway.example/v1", thinkingLevel: "auto" });
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(["key-d", []])))), (byte) => byte.toString(16).padStart(2, "0")).join("");
    await runInDurableObject(ownerStub(), (instance: Steward) => {
      (instance as unknown as { sql: Sql }).sql.bind(instance)`INSERT INTO sh_model_thinking_probe (provider, modelId, baseUrl, credentialHash, levelsJson, probedAt) VALUES ('openai-compatible', 'gateway-d', 'https://gateway.example/v1', ${digest}, '["low","high"]', 1)`;
    });
    // The endpoint is a made-up host: reaching the network here would fail the test, so a 200
    // with the cached levels proves the save never spent a request.
    const res = await post("settings/model", { provider: "openai-compatible", modelId: "gateway-d", apiKey: "key-d", baseUrl: "https://gateway.example/v1", thinkingLevel: "auto", autoTest: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, verified: true, activated: true, acceptedThinkingLevels: ["low", "high"] });
  });

  it("a save whose automatic check fails leaves the live configuration exactly as it was (issue #70)", async () => {
    const { post, settings } = await browser();
    await seed({ provider: "anthropic", modelId: "claude-sonnet-x", apiKey: "sk-ant-live" });
    const before = await (await settings()).json();

    // Checking before committing: the candidate names a model the catalog does not ship, so the
    // check fails before any request goes out and nothing about the running deployment may have
    // moved — not the provider, not the key, not a saved-model row.
    const rejected = await post("settings/model", { provider: "deepseek", modelId: "not-in-catalog", apiKey: "sk-bad", autoTest: true });
    expect(rejected.status).toBe(200);
    expect(await rejected.json()).toMatchObject({ ok: true, verified: false, activated: false, status: 'verification_failed', testError: "unknown_model" });

    const after = await (await settings()).json() as Record<string, unknown>;
    expect({ ...after, modelDrafts: [] }).toEqual({ ...before as object, modelDrafts: [] });
    expect(after.modelDrafts).toEqual([expect.objectContaining({ status: 'verification_failed', testError: 'unknown_model' })]);
    expect(await ownerStub().modelConfig()).toMatchObject({ provider: "anthropic", modelId: "claude-sonnet-x", apiKey: "sk-ant-live" });
    // Neither rejected candidate's key was sealed, so neither can leak into a later switch.
    expect(await ownerStub().keyedProviders()).toEqual(["anthropic"]);
  });

  it("a rejected candidate never overwrites the live provider's key (issue #70)", async () => {
    const { post, settings } = await browser();
    await seed({ provider: "deepseek", modelId: "deepseek-flash", apiKey: "sk-live" });
    expect((await ownerStub().modelConfig())?.apiKey).toBe("sk-live");

    // The same provider with a new key: activating first and rolling back after would already
    // have overwritten the key the deployment was running on.
    await post("settings/model", { provider: "deepseek", modelId: "not-in-catalog", apiKey: "sk-bad", autoTest: true });
    expect(await ownerStub().modelConfig()).toMatchObject({ provider: "deepseek", modelId: "deepseek-flash", apiKey: "sk-live" });
    const listed = (await (await settings()).json()) as { savedModels: { modelId: string }[] };
    expect(listed.savedModels.some((entry) => entry.modelId === "not-in-catalog")).toBe(false);
  });

  it("keeps the saved level until the endpoint is declared or measured", async () => {
    await ownerStub().setModelConfig("openai-compatible", "test-only", "deepseek-v4.1-flash", "https://gateway.example/v1", "max");
    const selection = await ownerStub().llmSelection();
    expect(selection.thinkingLevel).toBe("max");
    expect(selection.thinkingLevels).toEqual(["auto", "off", "minimal", "low", "medium", "high", "xhigh", "max"]);
    expect(selection.modelId).toBe("deepseek-v4.1-flash");
  });

  it("lists only verified saved models and invalidates verification when the key changes", async () => {
    const { post, settings } = await browser();
    await seed({ provider: "openai-compatible", modelId: "gateway-a", apiKey: "key-a", baseUrl: "https://gateway.example/v1" });
    const before = (await (await settings()).json()) as { verifiedModels: unknown[] };
    expect(before.verifiedModels).toEqual([]);
    const canonical = JSON.stringify(["key-a", []]);
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical))), (byte) => byte.toString(16).padStart(2, "0")).join("");
    await runInDurableObject(ownerStub(), (instance: Steward) => {
      (instance as unknown as { sql: Sql }).sql.bind(instance)`INSERT INTO sh_verified_model (provider, modelId, baseUrl, credentialHash, verifiedAt) VALUES ('openai-compatible', 'gateway-a', 'https://gateway.example/v1', ${digest}, 1)`;
    });
    const ready = (await (await settings()).json()) as { verifiedModels: unknown[] };
    expect(ready.verifiedModels).toEqual([{ provider: "openai-compatible", modelId: "gateway-a" }]);
    await seed({ provider: "openai-compatible", modelId: "gateway-a", apiKey: "key-b", baseUrl: "https://gateway.example/v1" });
    const rotated = (await (await settings()).json()) as { verifiedModels: unknown[] };
    expect(rotated.verifiedModels).toEqual([]);
  });

  it("persists imported identifiers only with a verified activation", async () => {
    const { post, settings } = await browser();
    // External-boundary substitute only; the real activation/SQL path runs below.
    await runInDurableObject(ownerStub(), async (instance: Steward) => {
      const store = (instance as unknown as Internals).modelConfigStore;
      const draft = await store.saveDraft({ provider: 'openai-compatible', modelId: 'gateway-a', apiKey: 'sk-test', baseUrl: 'https://gateway.example/v1', importedModelIds: ['gateway-a', 'gateway-b'] });
      const original = store.verifyAndProbe;
      try {
        store.verifyAndProbe = async () => ({ ok: true });
        await store.verifyDraft(draft.draftId!, draft.revision!);
        expect((await store.activateDraft(draft.draftId!, draft.revision!, async () => false)).activated).toBe(true);
      } finally { store.verifyAndProbe = original; }
    });
    const saved = await settings();
    expect(saved.status).toBe(200);
    const list = (await (await settings()).json()) as { savedModels: { modelId: string }[] };
    expect(list.savedModels.map((entry) => entry.modelId)).toEqual(expect.arrayContaining(["gateway-a", "gateway-b"]));
    expect((await post("settings/model/selection", { provider: "openai-compatible", modelId: "gateway-b", thinkingLevel: "auto" })).status).toBe(200);
  });

  it("keeps multiple saved gateway models and switches back to each endpoint", async () => {
    const { post, settings } = await browser();
    await seed({ provider: "deepseek", modelId: "gateway-a", apiKey: "sk-gateway", baseUrl: "https://a.example/v1" });
    await seed({ provider: "deepseek", modelId: "gateway-b", baseUrl: "https://b.example/v1" });
    const listed = (await (await settings()).json()) as { savedModels: { modelId: string; baseUrl: string | null }[] };
    expect(listed.savedModels).toEqual(expect.arrayContaining([
      expect.objectContaining({ modelId: "gateway-a", baseUrl: "https://a.example/v1" }),
      expect.objectContaining({ modelId: "gateway-b", baseUrl: "https://b.example/v1" }),
    ]));
    const back = await post("settings/model/selection", { provider: "deepseek", modelId: "gateway-a", thinkingLevel: "off" });
    expect(back.status).toBe(200);
    const after = (await (await settings()).json()) as { model: { modelId: string; baseUrl: string | null } };
    expect(after.model).toMatchObject({ modelId: "gateway-a", baseUrl: "https://a.example/v1" });
  });

  it("a switch without apiKey keeps the provider's sealed key (issue #74)", async () => {
    const { post, settings } = await browser();
    await seed({ provider: "anthropic", modelId: "claude-sonnet-x", apiKey: "sk-ant-web" });
    await seed({ provider: "openai", modelId: "gpt-o", apiKey: "sk-openai-web" });

    await seed({ provider: "anthropic", modelId: "claude-sonnet-y" });
    const after = (await (await settings()).json()) as { model: { provider: string; modelId: string; apiKey: boolean }; keyedProviders: string[] };
    expect(after.model).toMatchObject({ provider: "anthropic", modelId: "claude-sonnet-y", apiKey: true });
    // No settings read happened first, so MODEL_KEY never seeded: only the saved keys.
    expect(after.keyedProviders).toEqual(["anthropic", "openai"]);
  });

  it("changes the thinking level of a gateway's own model name, keeping its endpoint (self-hosting)", async () => {
    // A self-hosted gateway addresses model ids the catalog has never shipped. A bare catalog
    // lookup made the composer reject the very model that was already running
    // (`model_not_available`), and passing no baseUrl on the switch would have dropped the
    // gateway and re-pointed the deployment at the vendor's first-party API.
    const { post, settings } = await browser();
    await seed({ provider: "deepseek", modelId: "deepseek-v4.1-flash-1017", apiKey: "sk-gateway", baseUrl: "https://gw.example/v1" });
    const before = ((await (await settings()).json()) as { model: { thinkingLevel: string; thinkingLevels: string[] } }).model;
    expect(before.thinkingLevel).toBeTruthy();
    const next = before.thinkingLevels.find((level) => level !== before.thinkingLevel)!;

    const res = await post("settings/model/selection", { provider: "deepseek", modelId: "deepseek-v4.1-flash-1017", thinkingLevel: next });
    expect(res.status).toBe(200);
    const after = ((await (await settings()).json()) as { model: { modelId: string; baseUrl: string | null; thinkingLevel: string; modelKnown: boolean } }).model;
    expect(after).toMatchObject({ modelId: "deepseek-v4.1-flash-1017", baseUrl: "https://gw.example/v1", thinkingLevel: next, modelKnown: true });
  });

  it("rejects a thinking level the resolved model does not support, and an unknown provider", async () => {
    const { post } = await browser();
    await seed({ provider: "deepseek", modelId: "deepseek-flash", apiKey: "sk-ds" });
    const levels = (await ownerStub().llmSelection()).thinkingLevels;
    const unsupported = (["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const).find((level) => !levels.includes(level))!;
    const bad = await post("settings/model/selection", { provider: "deepseek", modelId: "deepseek-flash", thinkingLevel: unsupported });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "thinking_not_supported" });
    const unknown = await post("settings/model/selection", { provider: "nobody", modelId: "deepseek-flash", thinkingLevel: "off" });
    expect(await unknown.json()).toEqual({ error: "model_not_available" });
  });

  it("rejects a switch missing provider or modelId, or with a malformed apiKey", async () => {
    const { post } = await browser();
    expect((await post("settings/model", { modelId: "claude-x", apiKey: "sk-1" })).status).toBe(400);
    expect((await post("settings/model", { provider: "anthropic", apiKey: "sk-1" })).status).toBe(400);
    expect((await post("settings/model", { provider: "", modelId: "claude-x", apiKey: "sk-1" })).status).toBe(400);
    expect((await post("settings/model", { provider: "anthropic", modelId: "claude-x", apiKey: 5 })).status).toBe(400);
  });
});

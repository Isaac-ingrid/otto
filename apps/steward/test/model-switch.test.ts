// Runtime model switching (issue #70): the Settings page picks provider + modelId (and
// optionally baseUrl) without a redeploy. Unlike the legacy provider-only
// setModelConfig(provider, apiKey) — which only ever supplies the provider, and only when
// vars.STEWARD_MODEL is unset — a switch that names its own modelId wins over vars
// entirely (llm/models.ts mergeModelSelection): that is the whole point of being able to
// switch at runtime instead of editing vars and redeploying.
import { SELF, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Steward } from "../src/steward.ts";
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
    (instance as unknown as { sql: Sql }).sql.bind(instance)`DELETE FROM sh_provider_profile`;
    (instance as unknown as { sql: Sql }).sql.bind(instance)`DELETE FROM sh_saved_model`;
    (instance as unknown as { sql: Sql }).sql.bind(instance)`DELETE FROM sh_verified_model`;
    (instance as unknown as { sql: Sql }).sql.bind(instance)`DELETE FROM sh_model_thinking_probe`;
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
    await post("settings/model", { provider: "deepseek", modelId: "deepseek-flash", apiKey: "saved-test-key" });
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

    await post("settings/model", { provider: "anthropic", modelId: "claude-sonnet-x", apiKey: "sk-ant-web" });
    const after = (await (await settings()).json()) as { keyedProviders: string[] };
    expect(after.keyedProviders).toEqual(["anthropic", "deepseek"]);
  });

  it("POST /app/api/settings/model switches provider + modelId, overriding vars, and the owner sees it reflected back", async () => {
    const { post, settings } = await browser();
    const res = await post("settings/model", { provider: "anthropic", modelId: "claude-sonnet-x", apiKey: "sk-ant-web" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const after = (await (await settings()).json()) as { model: { provider: string; modelId: string; apiKey: boolean } };
    expect(after.model).toMatchObject({ provider: "anthropic", modelId: "claude-sonnet-x", apiKey: true });
  });

  it("carries baseUrl through when given", async () => {
    const { post, settings } = await browser();
    await post("settings/model", { provider: "openai", modelId: "gpt-x", apiKey: "sk-openai-web", baseUrl: "https://proxy.example/v1" });
    const after = (await (await settings()).json()) as { model: { baseUrl: string | null } };
    expect(after.model.baseUrl).toBe("https://proxy.example/v1");
  });

  it("shows only accepted tiers for the exact saved gateway and invalidates a rotated key", async () => {
    const { post, settings } = await browser();
    await post("settings/model", { provider: "openai-compatible", modelId: "deepseek-v4.1-flash", apiKey: "key-a", baseUrl: "https://gateway.example/v1", thinkingLevel: "auto" });
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(["key-a", []])))), (byte) => byte.toString(16).padStart(2, "0")).join("");
    await runInDurableObject(ownerStub(), (instance: Steward) => {
      (instance as unknown as { sql: Sql }).sql.bind(instance)`INSERT INTO sh_model_thinking_probe (provider, modelId, baseUrl, credentialHash, levelsJson, probedAt) VALUES ('openai-compatible', 'deepseek-v4.1-flash', 'https://gateway.example/v1', ${digest}, '["minimal","medium"]', 1)`;
    });
    const body = (await (await settings()).json()) as { thinkingProbes: { acceptedLevels: string[] }[]; model: { thinkingLevels: string[] } };
    expect(body.thinkingProbes[0]?.acceptedLevels).toEqual(["minimal", "medium"]);
    expect(body.model.thinkingLevels).toEqual(["auto", "minimal", "medium"]);
    expect((await post("settings/model/selection", { provider: "openai-compatible", modelId: "deepseek-v4.1-flash", thinkingLevel: "medium" })).status).toBe(200);
    expect((await post("settings/model/selection", { provider: "openai-compatible", modelId: "deepseek-v4.1-flash", thinkingLevel: "max" })).status).toBe(400);
    await post("settings/model", { provider: "openai-compatible", modelId: "deepseek-v4.1-flash", apiKey: "key-b", baseUrl: "https://gateway.example/v1", thinkingLevel: "auto" });
    const rotated = (await (await settings()).json()) as { thinkingProbes: unknown[]; model: { thinkingLevels: string[] } };
    expect(rotated.thinkingProbes).toEqual([]);
    // Nothing is declared or measured for the rotated key any more, so the picker stops
    // pretending to know: it lists every level (unverified) instead of a dead "auto" stub.
    expect(rotated.model.thinkingLevels).toEqual(["auto", "off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  });

  it("stores an owner-written level list and narrows the picker to it, immediately", async () => {
    const { post, settings } = await browser();
    const declared = await post("settings/model", { provider: "openai-compatible", modelId: "gateway-b", apiKey: "key-b", baseUrl: "https://gateway.example/v1", thinkingJson: JSON.stringify(["minimal", "low", "medium", "high"]), thinkingLevel: "max" });
    expect(declared.status).toBe(200);
    const body = (await (await settings()).json()) as { savedModels: { modelId: string; thinkingJson: string; thinkingLevels: string[] }[]; model: { thinkingLevel: string; thinkingLevels: string[] } };
    expect(body.savedModels.find((entry) => entry.modelId === "gateway-b")).toMatchObject({ thinkingLevels: ["minimal", "low", "medium", "high"] });
    // A level the owner's own list does not have is dropped back to auto rather than sent.
    expect(body.model.thinkingLevels).toEqual(["auto", "minimal", "low", "medium", "high"]);
    expect(body.model.thinkingLevel).toBe("auto");
    expect((await post("settings/model/selection", { provider: "openai-compatible", modelId: "gateway-b", thinkingLevel: "medium" })).status).toBe(200);
    expect((await post("settings/model/selection", { provider: "openai-compatible", modelId: "gateway-b", thinkingLevel: "xhigh" })).status).toBe(400);
    const cleared = await post("settings/model", { provider: "openai-compatible", modelId: "gateway-b", baseUrl: "https://gateway.example/v1", thinkingJson: "", thinkingLevel: "medium" });
    expect(cleared.status).toBe(200);
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
    await post("settings/model", { provider: "openai-compatible", modelId: "gateway-d", apiKey: "key-d", baseUrl: "https://gateway.example/v1", thinkingLevel: "auto" });
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(["key-d", []])))), (byte) => byte.toString(16).padStart(2, "0")).join("");
    await runInDurableObject(ownerStub(), (instance: Steward) => {
      (instance as unknown as { sql: Sql }).sql.bind(instance)`INSERT INTO sh_model_thinking_probe (provider, modelId, baseUrl, credentialHash, levelsJson, probedAt) VALUES ('openai-compatible', 'gateway-d', 'https://gateway.example/v1', ${digest}, '["low","high"]', 1)`;
    });
    // The endpoint is a made-up host: reaching the network here would fail the test, so a 200
    // with the cached levels proves the save never spent a request.
    const res = await post("settings/model", { provider: "openai-compatible", modelId: "gateway-d", apiKey: "key-d", baseUrl: "https://gateway.example/v1", thinkingLevel: "auto", autoTest: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, verified: true, acceptedThinkingLevels: ["low", "high"] });
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
    await post("settings/model", { provider: "openai-compatible", modelId: "gateway-a", apiKey: "key-a", baseUrl: "https://gateway.example/v1" });
    const before = (await (await settings()).json()) as { verifiedModels: unknown[] };
    expect(before.verifiedModels).toEqual([]);
    const canonical = JSON.stringify(["key-a", []]);
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical))), (byte) => byte.toString(16).padStart(2, "0")).join("");
    await runInDurableObject(ownerStub(), (instance: Steward) => {
      (instance as unknown as { sql: Sql }).sql.bind(instance)`INSERT INTO sh_verified_model (provider, modelId, baseUrl, credentialHash, verifiedAt) VALUES ('openai-compatible', 'gateway-a', 'https://gateway.example/v1', ${digest}, 1)`;
    });
    const ready = (await (await settings()).json()) as { verifiedModels: unknown[] };
    expect(ready.verifiedModels).toEqual([{ provider: "openai-compatible", modelId: "gateway-a" }]);
    await post("settings/model", { provider: "openai-compatible", modelId: "gateway-a", apiKey: "key-b", baseUrl: "https://gateway.example/v1" });
    const rotated = (await (await settings()).json()) as { verifiedModels: unknown[] };
    expect(rotated.verifiedModels).toEqual([]);
  });

  it("persists imported model identifiers for later switching", async () => {
    const { post, settings } = await browser();
    const saved = await post("settings/model", {
      provider: "openai-compatible", modelId: "gateway-a", apiKey: "sk-test", baseUrl: "https://gateway.example/v1",
      importedModelIds: ["gateway-a", "gateway-b"],
    });
    expect(saved.status).toBe(200);
    const list = (await (await settings()).json()) as { savedModels: { modelId: string }[] };
    expect(list.savedModels.map((entry) => entry.modelId)).toEqual(expect.arrayContaining(["gateway-a", "gateway-b"]));
    expect((await post("settings/model/selection", { provider: "openai-compatible", modelId: "gateway-b", thinkingLevel: "auto" })).status).toBe(200);
  });

  it("keeps multiple saved gateway models and switches back to each endpoint", async () => {
    const { post, settings } = await browser();
    await post("settings/model", { provider: "deepseek", modelId: "gateway-a", apiKey: "sk-gateway", baseUrl: "https://a.example/v1" });
    await post("settings/model", { provider: "deepseek", modelId: "gateway-b", baseUrl: "https://b.example/v1" });
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
    await post("settings/model", { provider: "anthropic", modelId: "claude-sonnet-x", apiKey: "sk-ant-web" });
    await post("settings/model", { provider: "openai", modelId: "gpt-o", apiKey: "sk-openai-web" });

    const back = await post("settings/model", { provider: "anthropic", modelId: "claude-sonnet-y" });
    expect(back.status).toBe(200);
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
    await post("settings/model", { provider: "deepseek", modelId: "deepseek-v4.1-flash-1017", apiKey: "sk-gateway", baseUrl: "https://gw.example/v1" });
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
    await post("settings/model", { provider: "deepseek", modelId: "deepseek-flash", apiKey: "sk-ds" });
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

  it("exposes catalog model capabilities and toggles savedModels enabled state", async () => {
    const { post, settings } = await browser();
    await post("settings/model", { provider: "deepseek", modelId: "deepseek-flash", apiKey: "sk-ds" });
    const initial = (await (await settings()).json()) as {
      providers: Array<{ id: string; models: Array<{ id: string; reasoning: boolean; vision: boolean; contextWindow: number }> }>;
      savedModels: Array<{ provider: string; modelId: string; enabled: boolean }>;
    };
    const flash = initial.providers.find((p) => p.id === "deepseek")?.models.find((m) => m.id === "deepseek-flash");
    expect(flash).toMatchObject({ reasoning: expect.any(Boolean), vision: expect.any(Boolean), contextWindow: expect.any(Number) });
    expect(initial.savedModels.find((m) => m.provider === "deepseek" && m.modelId === "deepseek-flash")?.enabled).toBe(true);

    expect((await post("settings/model/toggle", { provider: "deepseek", modelId: "deepseek-flash", enabled: false })).status).toBe(200);
    const disabled = (await (await settings()).json()) as { savedModels: Array<{ provider: string; modelId: string; enabled: boolean }> };
    expect(disabled.savedModels.find((m) => m.provider === "deepseek" && m.modelId === "deepseek-flash")?.enabled).toBe(false);

    expect((await post("settings/model/toggle", { provider: "deepseek", modelId: "non-existent", enabled: false })).status).toBe(404);
    expect((await post("settings/model/toggle", { provider: "deepseek", modelId: "deepseek-flash", enabled: "yes" })).status).toBe(400);
  });

  it("supports multiple provider profiles sharing the same dialect, plus toggle and delete guards (P1)", async () => {
    const { post, settings } = await browser();

    const r1 = await post("settings/model", {
      provider: "prof_relay1",
      dialect: "openai-compatible",
      profileName: "Relay One",
      modelId: "model-alpha",
      apiKey: "sk-relay-1",
      baseUrl: "https://relay1.example/v1",
      thinkingLevel: "auto",
    });
    expect(r1.status).toBe(200);

    const r2 = await post("settings/model", {
      provider: "prof_relay2",
      dialect: "openai-compatible",
      profileName: "Relay Two",
      modelId: "model-beta",
      apiKey: "sk-relay-2",
      baseUrl: "https://relay2.example/v1",
      thinkingLevel: "auto",
    });
    expect(r2.status).toBe(200);

    const s1 = (await (await settings()).json()) as {
      model: { provider: string; dialect?: string; profileName?: string; modelId: string; baseUrl: string | null };
      profiles: Array<{ profileId: string; name: string; dialect: string; baseUrl: string | null; enabled: boolean }>;
      keyedProviders: string[];
    };
    expect(s1.model).toMatchObject({
      provider: "prof_relay2",
      dialect: "openai-compatible",
      modelId: "model-beta",
      baseUrl: "https://relay2.example/v1",
    });
    expect(s1.keyedProviders).toEqual(expect.arrayContaining(["prof_relay1", "prof_relay2"]));
    expect(s1.profiles).toEqual(expect.arrayContaining([
      expect.objectContaining({ profileId: "prof_relay1", name: "Relay One", dialect: "openai-compatible", baseUrl: "https://relay1.example/v1", enabled: true }),
      expect.objectContaining({ profileId: "prof_relay2", name: "Relay Two", dialect: "openai-compatible", baseUrl: "https://relay2.example/v1", enabled: true }),
    ]));

    // Independent verifiedModels / thinkingProbes per profile
    const d1 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(["sk-relay-1", []])))), (b) => b.toString(16).padStart(2, "0")).join("");
    await runInDurableObject(ownerStub(), (instance: Steward) => {
      (instance as unknown as { sql: Sql }).sql.bind(instance)`INSERT INTO sh_verified_model (provider, modelId, baseUrl, credentialHash, verifiedAt) VALUES ('prof_relay1', 'model-alpha', 'https://relay1.example/v1', ${d1}, 1)`;
      (instance as unknown as { sql: Sql }).sql.bind(instance)`INSERT INTO sh_model_thinking_probe (provider, modelId, baseUrl, credentialHash, levelsJson, probedAt) VALUES ('prof_relay1', 'model-alpha', 'https://relay1.example/v1', ${d1}, '["low","high"]', 1)`;
    });
    const sVerified = (await (await settings()).json()) as {
      verifiedModels: Array<{ provider: string; modelId: string }>;
      thinkingProbes: Array<{ provider: string; modelId: string; acceptedLevels: string[] }>;
    };
    expect(sVerified.verifiedModels).toEqual([{ provider: "prof_relay1", modelId: "model-alpha" }]);
    expect(sVerified.thinkingProbes).toEqual([{ provider: "prof_relay1", modelId: "model-alpha", acceptedLevels: ["low", "high"] }]);

    // Switch back to prof_relay1 without re-entering API key or baseUrl
    const sw1 = await post("settings/model/selection", { provider: "prof_relay1", modelId: "model-alpha", thinkingLevel: "high" });
    expect(sw1.status).toBe(200);
    expect(await ownerStub().modelConfig()).toMatchObject({
      provider: "prof_relay1",
      dialect: "openai-compatible",
      modelId: "model-alpha",
      baseUrl: "https://relay1.example/v1",
      apiKey: "sk-relay-1",
    });

    // Switch back to prof_relay2, then disable prof_relay1
    expect((await post("settings/model/selection", { provider: "prof_relay2", modelId: "model-beta", thinkingLevel: "auto" })).status).toBe(200);
    expect((await post("settings/model/profile/toggle", { profileId: "prof_relay1", enabled: false })).status).toBe(200);
    const sDisabled = (await (await settings()).json()) as { keyedProviders: string[] };
    expect(sDisabled.keyedProviders).not.toContain("prof_relay1");
    expect((await post("settings/model/selection", { provider: "prof_relay1", modelId: "model-alpha", thinkingLevel: "auto" })).status).toBe(400);

    // Re-enable prof_relay1
    expect((await post("settings/model/profile/toggle", { profileId: "prof_relay1", enabled: true })).status).toBe(200);
    expect(((await (await settings()).json()) as { keyedProviders: string[] }).keyedProviders).toContain("prof_relay1");

    // Cannot delete active profile (prof_relay2)
    const delActive = await post("settings/model/profile/delete", { profileId: "prof_relay2" });
    expect(delActive.status).toBe(409);
    expect(await delActive.json()).toEqual({ error: "active_profile" });

    // Can delete inactive profile (prof_relay1)
    const delInactive = await post("settings/model/profile/delete", { profileId: "prof_relay1" });
    expect(delInactive.status).toBe(200);
    const sAfterDelete = (await (await settings()).json()) as {
      profiles: Array<{ profileId: string }>;
      keyedProviders: string[];
      savedModels: Array<{ provider: string }>;
    };
    expect(sAfterDelete.profiles.some((p) => p.profileId === "prof_relay1")).toBe(false);
    expect(sAfterDelete.keyedProviders).not.toContain("prof_relay1");
    expect(sAfterDelete.savedModels.some((m) => m.provider === "prof_relay1")).toBe(false);
  });

  it("supports per-thread model override, workspace snapshot projection, and clearing back to global (P2-1)", async () => {
    const cookie = await webLogin();
    const { post } = await browser();

    // Configure two profiles: global active is deepseek, thread override will use openai-compatible profile
    await post("settings/model", {
      provider: "prof_thread",
      dialect: "openai-compatible",
      profileName: "Thread Relay",
      modelId: "thread-model",
      apiKey: "sk-thread-relay",
      baseUrl: "https://thread.example/v1",
      thinkingLevel: "auto",
    });
    await post("settings/model", {
      provider: "deepseek",
      modelId: "deepseek-flash",
      apiKey: "sk-global-ds",
      thinkingLevel: "off",
    });

    // Seed a thread directly in the ledger
    const threadId = await runInDurableObject(ownerStub(), (instance: Steward) => {
      const ledger = (instance as unknown as { ledger: import("../src/ledger.ts").Ledger }).ledger;
      return ledger.threads.create({ title: "Override Thread", goal: "test per-thread model" }).threadId;
    });

    // 404 on unknown thread
    const missing = await post("threads/non-existent-thread/model", {
      provider: "prof_thread",
      modelId: "thread-model",
      thinkingLevel: "auto",
    });
    expect(missing.status).toBe(404);

    // 400 on unavailable model
    const badModel = await post(`threads/${threadId}/model`, {
      provider: "nobody",
      modelId: "missing-model",
      thinkingLevel: "off",
    });
    expect(badModel.status).toBe(400);

    // Set override on thread
    const setRes = await post(`threads/${threadId}/model`, {
      provider: "prof_thread",
      modelId: "thread-model",
      thinkingLevel: "high",
    });
    expect(setRes.status).toBe(200);
    expect(await setRes.json()).toEqual({
      ok: true,
      modelOverride: { provider: "prof_thread", modelId: "thread-model", thinkingLevel: "high" },
    });

    // Workspace snapshot exposes thread.modelOverride
    const ws1 = (await (await SELF.fetch(`${BASE}/app/api/workspace`, { headers: { cookie } })).json()) as {
      threads: Array<{ id: string; modelOverride: { provider: string; modelId: string; thinkingLevel: string } | null }>;
    };
    expect(ws1.threads.find((t) => t.id === threadId)?.modelOverride).toEqual({
      provider: "prof_thread",
      modelId: "thread-model",
      thinkingLevel: "high",
    });

    // ensureRootModel(threadId) configures root session with override, while ensureRootModel() uses global
    await runInDurableObject(ownerStub(), async (instance: Steward) => {
      const s = instance as unknown as {
        ensureRootModel(threadId?: string | null): Promise<void>;
        appliedRootModel?: string;
      };
      await s.ensureRootModel(threadId);
      expect(s.appliedRootModel).toContain('"prof_thread"');
      expect(s.appliedRootModel).toContain('"thread-model"');
      expect(s.appliedRootModel).toContain('"high"');

      await s.ensureRootModel();
      expect(s.appliedRootModel).toContain('"deepseek"');
      expect(s.appliedRootModel).toContain('"deepseek-flash"');
    });

    // Clear override back to global
    const clearRes = await post(`threads/${threadId}/model`, { clear: true });
    expect(clearRes.status).toBe(200);
    expect(await clearRes.json()).toEqual({ ok: true, modelOverride: null });

    const ws2 = (await (await SELF.fetch(`${BASE}/app/api/workspace`, { headers: { cookie } })).json()) as {
      threads: Array<{ id: string; modelOverride: unknown }>;
    };
    expect(ws2.threads.find((t) => t.id === threadId)?.modelOverride).toBeNull();
  });

  it("validates and accepts agent and machineHint on POST /app/api/messages (P2-2)", async () => {
    const { post } = await browser();
    const badAgent = await post("messages", {
      id: "msg-bad-agent",
      text: "hello",
      agent: "invalid agent!",
    });
    expect(badAgent.status).toBe(400);
    expect(await badAgent.json()).toEqual({ error: "bad_request" });

    const badMachine = await post("messages", {
      id: "msg-bad-machine",
      text: "hello",
      machineHint: "   ",
    });
    expect(badMachine.status).toBe(400);
    expect(await badMachine.json()).toEqual({ error: "bad_request" });

    const ok = await post("messages", {
      id: "msg-dispatch-ok",
      text: "run tests on mini",
      agent: "claude-code",
      machineHint: "mac-mini",
    });
    expect(ok.status).toBe(202);
  });
});

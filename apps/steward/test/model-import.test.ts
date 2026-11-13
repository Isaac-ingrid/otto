import { describe, expect, it } from "vitest";
import { importProviderModels } from "../src/llm/model-import.ts";
import { providerCatalog } from "../src/llm/models.ts";

const input = { provider: "openai-compatible", modelId: "import", baseUrl: "https://gateway.example/v1", explicit: true };

describe("model import", () => {
  it("fetches /models with the key without returning it", async () => {
    const result = await importProviderModels(input, "secret-test-key", async (url, init) => {
      expect(String(url)).toBe("https://gateway.example/v1/models");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret-test-key");
      expect(init?.redirect).toBe("manual");
      return new Response(JSON.stringify({ data: [{ id: "gateway-b" }, { id: "gateway-a" }, { id: "gateway-a" }] }));
    });
    expect(result.models).toEqual([{ id: "gateway-b", name: "gateway-b" }, { id: "gateway-a", name: "gateway-a" }]);
    expect(JSON.stringify(result)).not.toContain("secret-test-key");
  });
  it("rejects redirects and unsupported responses", async () => {
    await expect(importProviderModels(input, "secret", async () => new Response(null, { status: 302, headers: { location: "http://localhost" } }))).rejects.toThrow("model_import_unavailable");
    await expect(importProviderModels(input, "secret", async () => new Response("oops"))).rejects.toThrow("model_import_unavailable");
  });
  it("sorts OpenAI's numbered GPT generations newest first", () => {
    const ids = providerCatalog().find((entry) => entry.id === "openai")!.models.map((model) => model.id);
    expect(ids.indexOf("gpt-6.1-sol")).toBeLessThan(ids.indexOf("gpt-6-sol"));
    expect(ids.indexOf("gpt-6-sol")).toBeLessThan(ids.indexOf("gpt-5.6-sol"));
  });
});

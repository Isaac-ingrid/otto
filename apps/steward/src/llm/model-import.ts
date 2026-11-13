import type { ModelSwitchInput } from "./models.ts";

/** Fetch only model identifiers, never proxy the upstream response or credentials to the browser. */
export async function importProviderModels(input: ModelSwitchInput, apiKey: string | undefined, fetcher: typeof fetch = fetch): Promise<{ models: { id: string; name: string }[] }> {
  if (!apiKey) throw new Error("model_import_missing_key");
  let url: URL;
  try {
    url = new URL(input.baseUrl ?? "");
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error();
  } catch { throw new Error("model_import_invalid_url"); }
  url.pathname = `${url.pathname.replace(/\/$/, "")}/models`;
  const signal = AbortSignal.timeout(12000);
  let response: Response;
  try {
    response = await fetcher(url, { headers: { ...input.headers, authorization: `Bearer ${apiKey}` }, signal, redirect: "manual" });
    if (!response.ok) throw new Error("model_import_unavailable");
    if (Number(response.headers.get("content-length")) > 1024 * 1024) throw new Error("model_import_too_large");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("model_import_unavailable");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 1024 * 1024) throw new Error("model_import_too_large");
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const body = JSON.parse(new TextDecoder().decode(bytes));
    if (!Array.isArray(body?.data)) throw new Error("model_import_unavailable");
    const ids: string[] = [...new Set((body.data as unknown[]).map((entry) => (entry && typeof entry === "object" ? (entry as { id?: unknown }).id : undefined)).filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 200))];
    return { models: ids.slice(0, 500).map((id) => ({ id, name: id })) };
  } catch { throw new Error("model_import_unavailable"); }
}

// Optional read-only web search. The model supplies only a query, never a URL or an endpoint.
// Results are untrusted data: the extension keeps them out of autonomous wakes and blocks
// action tools in the same owner turn after a search. No full-page fetching or arbitrary HTTP.
const ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const MAX_RESPONSE_BYTES = 128 * 1024;

export interface WebSearchResult {
  searchedAt: string;
  results: Array<{ title: string; url: string; snippet: string }>;
}

export async function searchBrave(query: string, apiKey: string, fetcher: typeof fetch = fetch): Promise<WebSearchResult> {
  const term = query.trim();
  if (!term || term.length > 160) throw new Error("搜索词不能为空或超过 160 字。");
  const url = new URL(ENDPOINT);
  url.searchParams.set("q", term);
  url.searchParams.set("count", "5");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetcher(url, {
      method: "GET",
      headers: { "X-Subscription-Token": apiKey, Accept: "application/json" },
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`搜索服务返回 HTTP ${response.status}。`);
    if (!response.body) throw new Error("搜索服务返回空响应。");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    let text = "";
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("搜索结果过大，已拒绝读取。");
      }
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
    let data: unknown;
    try { data = JSON.parse(text); } catch { throw new Error("搜索服务返回无效的 JSON。"); }
    const web = data && typeof data === "object" && "web" in data ? data.web : null;
    if (!web || typeof web !== "object" || !("results" in web) || !Array.isArray(web.results)) {
      throw new Error("搜索服务返回无效的结果格式。");
    }
    const entries = web.results;
    const results: WebSearchResult["results"] = [];
    for (const entry of entries.slice(0, 5)) {
      if (!entry || typeof entry !== "object" || typeof entry.url !== "string") continue;
      let page: URL;
      try { page = new URL(entry.url); } catch { continue; }
      if (page.protocol !== "https:" || page.username || page.password) continue;
      results.push({
        title: typeof entry.title === "string" ? entry.title.slice(0, 160) : "",
        url: page.href.slice(0, 2048),
        snippet: typeof entry.description === "string" ? entry.description.slice(0, 350) : "",
      });
    }
    return { searchedAt: new Date().toISOString(), results };
  } finally {
    clearTimeout(timer);
  }
}

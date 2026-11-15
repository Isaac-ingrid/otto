/**
 * The `env` object a Worker receives.
 *
 * On Cloudflare this comes from `wrangler.jsonc` (vars + DO bindings + assets + rate limits)
 * and `wrangler secret put` (secrets). Here it is assembled from the same sources a local
 * `wrangler dev` would read — `process.env` first, then `.dev.vars` — plus a filesystem-backed
 * `ASSETS` binding over `apps/steward/ui` and an in-memory login rate limiter.
 *
 * The name list below is the `process.env` half only (a var set in the unit or shell); anything
 * present in `.dev.vars` is read too, whatever its name. A new var the steward reads must be
 * added here as well, or it will be silently invisible when it is exported rather than written
 * to the file. `src/env.d.ts` is the list of record.
 */
import { readFile, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type Vars = Record<string, string>;

/** Minimal `.dev.vars` parser: `KEY=value`, optional quotes, `#` comments. */
export function parseDevVars(text: string): Vars {
  const vars: Vars = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    vars[key] = value;
  }
  return vars;
}

export async function loadVars(options: { cwd: string; devVarsPath?: string }): Promise<Vars> {
  const vars: Vars = {};
  const names = [
    "SERVER_KEY",
    "SERVER_KEY_PREVIOUS",
    "LOGIN_PASSWORD",
    "MODEL_KEY",
    "BRAVE_SEARCH_API_KEY",
    "TAVILY_API_KEY",
    "VAPID_PUBLIC_KEY",
    "VAPID_PRIVATE_KEY",
    "VAPID_SUBJECT",
    "OTTO_PUSH_RELAY_URL",
    "OTTO_PUSH_RELAY_TOKEN",
    "OTTO_GITHUB_READ_TOKEN",
    "STEWARD_MODEL",
    "DAILY_BUDGET_USD",
    "WATCHDOG_LLM",
    "LOGIN_LINK_TTL_MS",
    "LOGIN_LINK_REUSABLE",
    "OTTO_PUBLIC_ORIGIN",
  ];
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined) vars[name] = value;
  }
  const path = options.devVarsPath ?? join(options.cwd, ".dev.vars");
  try {
    const text = await readFile(path, "utf8");
    Object.assign(vars, parseDevVars(text));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return vars;
}

// A Node deployment must not learn its public origin from an anonymous Host header.
export function parsePublicOrigin(value: string): string {
  const url = new URL(value);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && local)) ||
      url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
      value !== url.origin && value !== `${url.origin}/`) {
    throw new Error("OTTO_PUBLIC_ORIGIN must be a bare HTTPS origin (HTTP only for loopback)");
  }
  return url.origin;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * `env.ASSETS.fetch` — the static directory `wrangler.jsonc` binds (`apps/steward/ui`).
 *
 * Mirrors Cloudflare's default asset handling closely enough for the routes the steward asks
 * for: a path is served as-is when it names a file, `…/` falls back to `index.html`, and an
 * extension-less path falls back to `<path>.html` (`/workspace` → `workspace.html`, the
 * `html_handling: "auto-trailing-slash"` behaviour the workspace shell depends on).
 */
export function createAssets(rootDir: string): { fetch(input: Request | string | URL): Promise<Response> } {
  const root = resolve(rootDir);
  return {
    async fetch(input) {
      const request = input instanceof Request ? input : new Request(input);
      const url = new URL(request.url);
      let pathname = decodeURIComponent(url.pathname);
      if (pathname.endsWith("/")) pathname += "index.html";
      const candidates = [resolve(join(root, pathname))];
      if (!extname(pathname)) candidates.push(`${candidates[0]}.html`);
      for (const candidate of candidates) {
        const rel = relative(root, candidate);
        if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return new Response("not found", { status: 404 });
      }
      for (const full of candidates) {
      try {
        const info = await stat(full);
        if (!info.isFile()) continue;
        const body = await readFile(full);
        return new Response(request.method === "HEAD" ? null : body, {
          status: 200,
          headers: {
            "content-type": MIME[extname(full).toLowerCase()] ?? "application/octet-stream",
            "content-length": String(body.byteLength),
            etag: `"${info.size.toString(16)}-${info.mtimeMs.toString(16)}"`,
          },
        });
      } catch {
        continue;
      }
      }
      return new Response("not found", { status: 404 });
    },
  };
}

export interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/** `ratelimits` in `wrangler.jsonc`: 10 requests per 60s per key. */
export function createRateLimiter(options: { limit?: number; periodMs?: number } = {}): RateLimitBinding {
  const limit = options.limit ?? 10;
  const periodMs = options.periodMs ?? 60_000;
  const windows = new Map<string, { count: number; resetAt: number }>();
  return {
    async limit({ key }) {
      const now = Date.now();
      const window = windows.get(key);
      if (!window || window.resetAt <= now) {
        windows.set(key, { count: 1, resetAt: now + periodMs });
        return { success: true };
      }
      window.count += 1;
      return { success: window.count <= limit };
    },
  };
}

/**
 * Entry point for running the steward on a plain Node process (VPS, home server, laptop).
 *
 * Everything above this file is the Worker as deployed to Cloudflare: `src/index.ts` routes,
 * `src/steward.ts` is the Durable Object, the Agents SDK and pi-durable run unchanged. This
 * file supplies the platform they expect — a SQLite-backed `ctx.storage`, an alarm timer, a
 * `WebSocketPair`, and an `env` with the same bindings `wrangler.jsonc` declares.
 *
 *   OTTO_DB_PATH   SQLite file (default ./data/steward.sqlite)
 *   PORT          listen port (default 8787)
 *   HOST          bind address (default 0.0.0.0)
 *   .dev.vars     SERVER_KEY / LOGIN_PASSWORD / STEWARD_MODEL / DAILY_BUDGET_USD ...
 */
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { installGlobals } from "./globals.ts";
import { createAssets, createRateLimiter, loadVars, parsePublicOrigin } from "./env.ts";
import { createNamespace } from "./namespace.ts";
import { HostRuntime } from "./runtime.ts";
import { startServer } from "./server.ts";
import { NodeDurableObjectId, NodeDurableObjectState } from "./state.ts";
import { NodeDurableObjectStorage } from "./storage.ts";

installGlobals();

const appDir = resolve(import.meta.dirname, "..");
const cwd = process.env.OTTO_CONFIG_DIR ?? resolve(appDir, "../..");

const dbPath = resolve(process.env.OTTO_DB_PATH ?? resolve(appDir, "data/steward.sqlite"));
const port = Number(process.env.PORT ?? 8787);
const hostname = process.env.HOST ?? "0.0.0.0";

await mkdir(dirname(dbPath), { recursive: true });

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA synchronous = NORMAL");
db.exec("PRAGMA busy_timeout = 5000");
db.exec("PRAGMA foreign_keys = ON");

const storage = new NodeDurableObjectStorage(db);
const state = new NodeDurableObjectState(new NodeDurableObjectId("owner"), storage);

const vars = await loadVars({ cwd });
if (!vars.OTTO_PUBLIC_ORIGIN && process.env.NODE_ENV === "production") {
  throw new Error("Set OTTO_PUBLIC_ORIGIN to the canonical HTTPS address before starting the public Node host");
}
if (vars.OTTO_PUBLIC_ORIGIN) vars.OTTO_PUBLIC_ORIGIN = parsePublicOrigin(vars.OTTO_PUBLIC_ORIGIN);

// Dynamically imported so `installGlobals()` runs before the Agents SDK module graph loads.
const { default: worker } = await import("../src/index.ts");
const { Steward } = await import("../src/steward.ts");

const env: Record<string, unknown> = {
  ...vars,
  ASSETS: createAssets(resolve(appDir, "ui")),
  LOGIN_RATE_LIMITER: createRateLimiter(),
};

let steward: InstanceType<typeof Steward> | undefined;
env.Steward = createNamespace("Steward", () => {
  if (!steward) throw new Error("steward not constructed");
  return steward;
});

steward = new Steward(state as never, env as never);
const runtime = new HostRuntime(state, steward as never);
runtime.start();

const server = await startServer({
  runtime: runtime as never,
  handler: (request) => worker.fetch(request, env as never),
  port,
  hostname,
});

console.log(`[otto] steward listening on http://${hostname}:${port} (db ${dbPath})`);

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  console.log(`[otto] ${signal} — shutting down`);
  await runtime.stop();
  server.close();
  db.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

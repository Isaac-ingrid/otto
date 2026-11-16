import { register } from "node:module";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

import type { Steward } from "../src/steward.ts";
import type { Ledger } from "../src/ledger.ts";
import type { PrWatchDeps, PrWatchService } from "../src/pr-watch.ts";
import type { PrEvidenceMode } from "../src/pr-evidence.ts";
import { installLoopbackFetchGuard } from "./network-guard.ts";
import type { PrWatchApprovals } from "../src/pr-watch-approval.ts";

let loaderRegistered = false;

function ensureCloudflareLoader(): void {
  if (loaderRegistered) return;
  loaderRegistered = true;
  const appDir = resolve(import.meta.dirname, "..");
  const workersUrl = pathToFileURL(resolve(appDir, "node-host/cloudflare-workers.ts")).href;
  const emailUrl = pathToFileURL(resolve(appDir, "node-host/cloudflare-email.ts")).href;
  const code = `
    export async function resolve(specifier, context, nextResolve) {
      if (specifier === "cloudflare:workers") return { url: ${JSON.stringify(workersUrl)}, shortCircuit: true };
      if (specifier === "cloudflare:email") return { url: ${JSON.stringify(emailUrl)}, shortCircuit: true };
      return nextResolve(specifier, context);
    }
  `;
  register(`data:text/javascript,${encodeURIComponent(code)}`);
}

export interface BrowserTestServer {
  readonly baseUrl: string;
  readonly port: number;
  readonly loginSecret: string;
  readonly steward: Steward;
  readonly runtime: { getWebSockets(): Array<{ close(code?: number, reason?: string): void }> };
  readonly db: DatabaseSync;
  readonly ledger: Ledger;
  readonly prWatches: PrWatchService;
  readonly prWatchApprovals: PrWatchApprovals;
  readonly evidenceReads: Array<{ url: string; mode: PrEvidenceMode }>;
  scriptModel(...steps: unknown[]): Promise<void>;
  streamRepliesAt(tokensPerSecond: number | undefined): Promise<void>;
  advanceApprovalClock(offsetMs: number): void;
  submitWorkspaceActionForTest(input: { id: string; cardId: string; action: string }): Promise<void>;
  close(): Promise<void>;
}

export async function startBrowserTestServer(): Promise<BrowserTestServer> {
  const network = installLoopbackFetchGuard();
  try {
    return await createBrowserTestServer(network);
  } catch (error) {
    network.restore();
    throw error;
  }
}

async function createBrowserTestServer(network: ReturnType<typeof installLoopbackFetchGuard>): Promise<BrowserTestServer> {
  ensureCloudflareLoader();

  const { installGlobals } = await import("../node-host/globals.ts");
  const { createAssets, createRateLimiter } = await import("../node-host/env.ts");
  const { createNamespace } = await import("../node-host/namespace.ts");
  const { HostRuntime } = await import("../node-host/runtime.ts");
  const { startServer } = await import("../node-host/server.ts");
  const { NodeDurableObjectId, NodeDurableObjectState } = await import("../node-host/state.ts");
  const { NodeDurableObjectStorage } = await import("../node-host/storage.ts");

  installGlobals();

  const appDir = resolve(import.meta.dirname, "..");
  const dir = join(tmpdir(), `otto-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
  await mkdir(dir, { recursive: true });
  const dbPath = join(dir, "steward.sqlite");

  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");

  const storage = new NodeDurableObjectStorage(db);
  const state = new NodeDurableObjectState(new NodeDurableObjectId("owner"), storage);

  const { default: worker } = await import("../src/index.ts");
  const { Steward: StewardClass } = await import("../src/steward.ts");

  const loginSecret = Array.from({ length: 4 }, (_, i) => `segment${i + 10}`).join("-");
  const env: Record<string, unknown> = {
    STEWARD_MODEL: JSON.stringify({ provider: "faux", modelId: "faux-1" }),
    ASSETS: createAssets(resolve(appDir, "ui")),
    LOGIN_RATE_LIMITER: createRateLimiter(),
  };

  let stewardInstance: Steward | undefined;
  env.Steward = createNamespace("Steward", () => {
    if (!stewardInstance) throw new Error("steward not constructed");
    return stewardInstance as never;
  });

  // biome-ignore lint/suspicious/noExplicitAny: SDK constructor type is not exported
  stewardInstance = new (StewardClass as any)(state, env) as Steward;
  const runtime = new HostRuntime(state, stewardInstance as never, { tickMs: 25 });

  const server = await startServer({
    runtime: runtime as never,
    handler: (request) => worker.fetch(request, env as never),
    port: 0,
    hostname: "127.0.0.1",
  });

  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;
  env.OTTO_PUBLIC_ORIGIN = baseUrl;

  await stewardInstance.configureBrowserPasswordForTests(loginSecret);
  await stewardInstance.setModelConfig("faux", "sk-test-model-seed", "faux-1");

  const internal = stewardInstance as unknown as {
    ledger: Ledger;
    prWatches: PrWatchService;
    prWatchApprovals: PrWatchApprovals;
    fauxScript(steps: unknown[]): Promise<void>;
    fauxStreamAt(tokensPerSecond: number | undefined): Promise<void>;
  };

  // Install before the alarm loop starts: crossing a cron boundary must still be
  // deterministic and offline. Keep the real service, transactions and notifications.
  const evidenceReads: BrowserTestServer["evidenceReads"] = [];
  const watchDeps = (internal.prWatches as unknown as { deps: PrWatchDeps }).deps;
  watchDeps.read = async (target, mode) => {
    evidenceReads.push({ url: target.url, mode });
    return { ok: true, evidence: { head: "a".repeat(40), state: "waiting", checks: 1, pending: 1, failed: 0 } };
  };
  runtime.start();

  return {
    baseUrl,
    port,
    loginSecret,
    evidenceReads,
    steward: stewardInstance,
    runtime: {
      getWebSockets() {
        return state.getWebSockets();
      },
    },
    db,
    get ledger() {
      return internal.ledger;
    },
    get prWatches() {
      return internal.prWatches;
    },
    get prWatchApprovals() {
      return internal.prWatchApprovals;
    },
    async scriptModel(...steps: unknown[]) {
      await internal.fauxScript(steps);
    },
    async streamRepliesAt(tokensPerSecond: number | undefined) {
      await internal.fauxStreamAt(tokensPerSecond);
    },
    advanceApprovalClock(offsetMs: number) {
      const deps = (internal.prWatchApprovals as unknown as { deps: { now?: () => number } }).deps;
      deps.now = () => Date.now() + offsetMs;
    },
    async submitWorkspaceActionForTest(input) {
      await (stewardInstance as unknown as { submitWorkspaceAction(i: typeof input): Promise<void> }).submitWorkspaceAction(input);
    },
    async close() {
      try {
        await runtime.stop();
        if (typeof server.closeAllConnections === "function") server.closeAllConnections();
        await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
        await new Promise((r) => setTimeout(r, 25));
        db.close();
        await rm(dir, { recursive: true, force: true });
      } finally {
        network.restore();
        network.assertIsolated();
      }
    },
  };
}

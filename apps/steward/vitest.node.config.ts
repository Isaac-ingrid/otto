import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The Node-host suite: the same test files as vitest.config.ts, but resolved against the Node
// host's platform shims instead of workerd (node-host/testing/cloudflare-test.ts supplies
// `env` / `SELF` / `runInDurableObject`). workerd remains the semantic baseline — this config
// exists to prove the Node host behaves the same, not to replace `pnpm test`.
const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  // The `cloudflare:` scheme looks like a node builtin to vite's resolver, which externalizes
  // it to the native ESM loader. Answer the three ids from a pre plugin so they never get there.
  plugins: [
    {
      name: "otto-cloudflare-scheme",
      enforce: "pre",
      resolveId(id) {
        const map: Record<string, string> = {
          "cloudflare:test": here("./node-host/testing/cloudflare-test.ts"),
          "cloudflare:workers": here("./node-host/cloudflare-workers.ts"),
          "cloudflare:email": here("./node-host/cloudflare-email.ts"),
        };
        return map[id];
      },
    },
  ],
  resolve: {
    alias: [
      { find: /^cloudflare:test$/, replacement: here("./node-host/testing/cloudflare-test.ts") },
      { find: /^cloudflare:workers$/, replacement: here("./node-host/cloudflare-workers.ts") },
      { find: /^cloudflare:email$/, replacement: here("./node-host/cloudflare-email.ts") },
    ],
  },
  test: {
    environment: "node",
    // Same reason as vitest.config.ts: the Durable Object's SQLite is shared mutable state
    // within a process, so files run one at a time; `scripts/test-groups.mjs` gets wall time
    // back from parallel processes.
    fileParallelism: false,
    // `agents` and pi-durable import `cloudflare:workers` themselves, so they must be
    // transformed (not externalized to node's loader) for the shims above to apply — the same
    // thing esbuild's alias does for `build:node`.
    server: { deps: { inline: [/node_modules\/(agents|@earendil-works|@simplewebauthn|uqr)\//] } },
    // The suite waits on real alarms (25s outbound polling, 15s acks) with generous timeouts.
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
});

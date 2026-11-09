/**
 * Bundle the Node host.
 *
 * `src/` is the Worker as deployed to Cloudflare — it imports `cloudflare:workers` through the
 * Agents SDK, which Node cannot resolve. esbuild rewrites just those module specifiers to the
 * shims in `node-host/`, so the same source tree runs in both places with no conditional
 * imports and no fork.
 *
 *   node scripts/build-node.mjs            # one-off bundle
 *   node scripts/build-node.mjs --watch    # rebuild on change
 */
import { build, context } from "esbuild";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** @type {import("esbuild").BuildOptions} */
const options = {
  absWorkingDir: appDir,
  entryPoints: ["node-host/main.ts"],
  outfile: "dist/node/steward-node.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  logLevel: "info",
  // `ws` stays external so the bundle keeps working from `apps/steward/node_modules`.
  external: ["ws", "node:*"],
  alias: {
    "cloudflare:workers": join(appDir, "node-host/cloudflare-workers.ts"),
    "cloudflare:email": join(appDir, "node-host/cloudflare-email.ts"),
  },
  banner: {
    js: [
      "import { createRequire as __sigCreateRequire } from \"node:module\";",
      "const require = __sigCreateRequire(import.meta.url);",
    ].join("\n"),
  },
};

if (process.argv.includes("--watch")) {
  const ctx = await context(options);
  await ctx.watch();
  console.log("[otto] watching node-host bundle");
} else {
  await build(options);
}

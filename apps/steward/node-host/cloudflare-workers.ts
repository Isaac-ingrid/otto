/**
 * Stand-in for the `cloudflare:workers` module.
 *
 * The Agents SDK imports four things from it at module scope (`DurableObject`, `RpcTarget`,
 * `exports`, `WorkflowEntrypoint`) and reads `tracing` opportunistically. esbuild rewrites the
 * `cloudflare:workers` specifier to this file when building the Node host; the Cloudflare
 * build is untouched and keeps the real module.
 *
 * `DurableObject` is the only one with behaviour: it stores the `ctx`/`env` pair the SDK reads
 * as `this.ctx` / `this.env`.
 */

export class DurableObject<Env = unknown> {
  readonly ctx: unknown;
  readonly env: Env;

  constructor(ctx: unknown, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}

/** RPC boundary marker; nothing crosses a process here, so this is a plain class. */
export class RpcTarget {}

export class WorkerEntrypoint<Env = unknown> {
  readonly ctx: unknown;
  readonly env: Env;

  constructor(ctx: unknown, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}

export class WorkflowEntrypoint<Env = unknown> {
  readonly ctx: unknown;
  readonly env: Env;

  constructor(ctx: unknown, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}

/** `import { exports } from "cloudflare:workers"` — the worker's own entrypoints by name. */
export const exports: Record<string, unknown> = {};

/** Tracing hooks the SDK probes for; absent means "no span runtime", which it already handles. */
export const tracing = undefined;

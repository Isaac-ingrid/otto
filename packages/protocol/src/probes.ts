// Stage 3 Zero-Token Local Probes protocol schemas (`run_probe` -> `probe_result`).
// Probe scripts live strictly in `<stateDir>/probes/<script>` on the Connector machine and
// require CLI-bound SHA-256 approval (`otto probe`). Only probe names (never script paths or
// bytes) cross the wire.
import { z } from "zod";

export const RUN_PROBE_TIMEOUT_MS = 30_000;

export const ProbeNameSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);

export type ProbeName = z.infer<typeof ProbeNameSchema>;

export const RunProbeArgsSchema = z.strictObject({
  probeName: ProbeNameSchema,
  repoId: z.string().min(1).max(4096).optional(),
});

export type RunProbeArgs = z.infer<typeof RunProbeArgsSchema>;

export const RunProbeMessageSchema = z.strictObject({
  t: z.literal("run_probe"),
  id: z.string().min(1).max(128),
  probeName: ProbeNameSchema,
  repoId: z.string().min(1).max(4096).optional(),
});

export type RunProbeMessage = z.infer<typeof RunProbeMessageSchema>;

export const ProbeOutputSchema = z.strictObject({
  triggered: z.boolean(),
  summary: z.string().max(1000).optional(),
  data: z.unknown().optional(),
});

export type ProbeOutput = z.infer<typeof ProbeOutputSchema>;

export const ProbeErrorCodeSchema = z.enum([
  "not_found",
  "unapproved",
  "not_registered_repo",
  "unsupported",
  "machine_offline",
  "busy",
  "probe_timeout",
  "probe_failed",
]);

export type ProbeErrorCode = z.infer<typeof ProbeErrorCodeSchema>;

export const ProbeResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    probeName: ProbeNameSchema,
    output: ProbeOutputSchema,
    durationMs: z.number().int().nonnegative(),
  }),
  z.strictObject({
    ok: z.literal(false),
    code: ProbeErrorCodeSchema,
    message: z.string().max(400).optional(),
  }),
]);

export type ProbeResult = z.infer<typeof ProbeResultSchema>;

export const ProbeResultMessageSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    t: z.literal("probe_result"),
    re: z.string().min(1).max(128),
    ok: z.literal(true),
    probeName: ProbeNameSchema,
    output: ProbeOutputSchema,
    durationMs: z.number().int().nonnegative(),
  }),
  z.strictObject({
    t: z.literal("probe_result"),
    re: z.string().min(1).max(128),
    ok: z.literal(false),
    code: ProbeErrorCodeSchema,
    message: z.string().max(400).optional(),
  }),
]);

export type ProbeResultMessage = z.infer<typeof ProbeResultMessageSchema>;

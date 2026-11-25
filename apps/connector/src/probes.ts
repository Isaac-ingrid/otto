// Stage 3 Zero-Token Local Probes (`~/.otto/probes/<script>`).
//
// Security invariants (honoring ADR-0022 & `hooks.ts`):
// - Probe scripts must reside strictly inside `<stateDir>/probes` (verified lexically and via
//   `realpathSync` to reject `..` traversal and symlinks pointing into repositories/outside).
// - Registration and SHA-256 approval live exclusively in `LocalStore` (`connector.sqlite`),
//   mutable only via the machine-local CLI (`otto probe`), NEVER from Steward wire commands.
// - At execution time, `runApprovedProbe` re-hashes live script bytes on disk (`timingSafeEqual`)
//   before running `execFile(scriptPath, [])` (`shell: false`, stdin closed, `OTTO_*` stripped).
// - Stdout is parsed into `ProbeOutput` (`{ triggered: boolean, summary?, data? }`); when
//   `triggered === false`, Steward finishes the routine fire with zero LLM tokens.
import { execFile } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ProbeNameSchema, ProbeOutputSchema, type ProbeOutput, type ProbeResult } from "@isaac2ingrid/protocol";
import { childEnv } from "./pi-adapter.ts";
import { proxyEnvFor, type ProxyConfig } from "./proxy.ts";
import { redactText } from "./redact.ts";

export const DEFAULT_PROBE_TIMEOUT_MS = 25_000;
const MAX_PROBE_BUFFER_BYTES = 1024 * 1024;

export interface StoredProbeConfig {
  probeName: string;
  script: string;
  approvedSha256: string | null;
  approvedAt: number | null;
}

export class ProbeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProbeConfigError";
  }
}

export function probesRootDir(stateDir: string): string {
  return join(stateDir, "probes");
}

function isContainedRelative(rel: string): boolean {
  if (!rel || rel === "." || rel === "..") return false;
  if (isAbsolute(rel)) return false;
  if (rel.startsWith(`..${sep}`) || rel.startsWith("../") || rel.startsWith("..\\")) return false;
  return true;
}

export function normalizeProbeScriptInput(
  stateDir: string,
  rawScript: string,
): { canonicalScript: string; realPath: string } {
  if (typeof rawScript !== "string" || rawScript.includes("\0")) {
    throw new ProbeConfigError("probe script path must be non-empty without NUL bytes");
  }
  const trimmed = rawScript.trim();
  if (!trimmed) throw new ProbeConfigError("probe script path must not be empty");
  const rootDir = resolve(probesRootDir(stateDir));
  const candidate = isAbsolute(trimmed) ? resolve(trimmed) : resolve(rootDir, trimmed);
  const lexicalRel = relative(rootDir, candidate);
  if (!isContainedRelative(lexicalRel)) {
    throw new ProbeConfigError(`probe script '${trimmed}' must reside inside ${rootDir}`);
  }
  if (!existsSync(rootDir) || !existsSync(candidate)) {
    throw new ProbeConfigError(`probe script '${trimmed}' does not exist in ${rootDir}`);
  }
  let realRoot: string;
  let realCandidate: string;
  try {
    realRoot = realpathSync(rootDir);
    realCandidate = realpathSync(candidate);
  } catch {
    throw new ProbeConfigError(`probe script '${trimmed}' could not be resolved in ${rootDir}`);
  }
  const realRel = relative(realRoot, realCandidate);
  if (!isContainedRelative(realRel)) {
    throw new ProbeConfigError(`probe script '${trimmed}' resolves outside ${rootDir} via symlink (forbidden)`);
  }
  if (!statSync(realCandidate).isFile()) {
    throw new ProbeConfigError(`probe script '${trimmed}' must be a regular file inside ${rootDir}`);
  }
  return {
    canonicalScript: lexicalRel.split(sep).join("/"),
    realPath: realCandidate,
  };
}

export function computeProbeApprovalDigest(
  stateDir: string,
  probeName: string,
  script: string,
): { ok: true; sha256: string; canonicalScript: string; realPath: string } | { ok: false; reason: string } {
  if (!ProbeNameSchema.safeParse(probeName).success) {
    return { ok: false, reason: `invalid probe name '${probeName}'` };
  }
  try {
    const resolved = normalizeProbeScriptInput(stateDir, script);
    const bytes = readFileSync(resolved.realPath);
    const header = JSON.stringify({
      probeName,
      script: resolved.canonicalScript,
      byteLength: bytes.byteLength,
    });
    const sha256 = createHash("sha256")
      .update(header, "utf8")
      .update("\0", "utf8")
      .update(bytes)
      .digest("hex");
    return { ok: true, sha256, canonicalScript: resolved.canonicalScript, realPath: resolved.realPath };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

function digestsMatch(expectedHex: string, actualHex: string): boolean {
  if (expectedHex.length !== actualHex.length || !/^[0-9a-f]+$/i.test(expectedHex) || !/^[0-9a-f]+$/i.test(actualHex)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(expectedHex.toLowerCase(), "utf8"), Buffer.from(actualHex.toLowerCase(), "utf8"));
}

export function verifyProbeApproval(
  stateDir: string,
  config: StoredProbeConfig | null | undefined,
): { approved: true; realPath: string; sha256: string } | { approved: false; code: "not_found" | "unapproved"; reason: string } {
  if (!config) {
    return { approved: false, code: "not_found", reason: "probe is not registered on this machine" };
  }
  const digest = computeProbeApprovalDigest(stateDir, config.probeName, config.script);
  if (!digest.ok) {
    return { approved: false, code: "unapproved", reason: digest.reason };
  }
  if (!config.approvedSha256) {
    return { approved: false, code: "unapproved", reason: "probe has not been approved yet" };
  }
  if (!digestsMatch(config.approvedSha256, digest.sha256)) {
    return {
      approved: false,
      code: "unapproved",
      reason: "probe script bytes changed since approval (SHA-256 mismatch)",
    };
  }
  return { approved: true, realPath: digest.realPath, sha256: digest.sha256 };
}

export function parseProbeStdout(stdout: string): ProbeOutput {
  const trimmed = stdout.trim();
  if (!trimmed) return { triggered: false };
  // Try parsing full stdout or last non-empty JSON line (`website-watch` / shell probe friendly).
  const candidates = [trimmed];
  const lines = trimmed.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length > 1) candidates.push(lines[lines.length - 1]!);

  for (const candidate of candidates) {
    if (!candidate.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(candidate);
      const checked = ProbeOutputSchema.safeParse(parsed);
      if (checked.success) return checked.data;
      if (typeof parsed === "object" && parsed !== null && "triggered" in parsed) {
        const p = parsed as Record<string, unknown>;
        return {
          triggered: Boolean(p.triggered),
          ...(typeof p.summary === "string" ? { summary: p.summary.slice(0, 1000) } : {}),
          ...("data" in p ? { data: p.data } : {}),
        };
      }
    } catch {
      // fall through
    }
  }
  // Plain-text convention: non-empty output without JSON triggers with trimmed text as summary.
  return { triggered: true, summary: trimmed.slice(0, 1000) };
}

export async function runApprovedProbe(options: {
  stateDir: string;
  config: StoredProbeConfig | null | undefined;
  cwd?: string;
  proxy?: ProxyConfig | null;
  secrets?: Iterable<string>;
  timeoutMs?: number;
}): Promise<ProbeResult> {
  const secrets = [...(options.secrets ?? [])];
  const verified = verifyProbeApproval(options.stateDir, options.config);
  if (!verified.approved) {
    return {
      ok: false,
      code: verified.code,
      message: redactText(verified.reason, secrets).slice(0, 320),
    };
  }

  const probeName = options.config!.probeName;
  const startMs = Date.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const probeStateDir = join(options.stateDir, "probe-state", probeName);
  mkdirSync(probeStateDir, { recursive: true });
  const cwd = options.cwd ?? probeStateDir;
  const nodeBinDir = dirname(process.execPath);
  const currentPath = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
  const mergedPath = currentPath.split(delimiter).includes(nodeBinDir)
    ? currentPath
    : `${nodeBinDir}${delimiter}${currentPath}`;
  const env = childEnv(process.env, {
    PATH: mergedPath,
    ...(options.proxy ? proxyEnvFor(options.proxy) : {}),
    PROBE_STATE_DIR: probeStateDir,
  });
  const isNodeScript = /\.(?:mjs|cjs|js)$/i.test(verified.realPath);
  const execTarget = isNodeScript ? process.execPath : verified.realPath;
  const execArgs = isNodeScript ? [verified.realPath] : [];

  return new Promise<ProbeResult>((resolveResult) => {
    let settled = false;
    let timedOut = false;

    const child = execFile(
      execTarget,
      execArgs,
      {
        cwd,
        env,
        maxBuffer: MAX_PROBE_BUFFER_BYTES,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const durationMs = Math.max(0, Date.now() - startMs);
        if (timedOut) {
          resolveResult({
            ok: false,
            code: "probe_timeout",
            message: `probe '${probeName}' timed out after ${timeoutMs}ms`,
          });
          return;
        }
        if (err) {
          const detail = redactText((stderr || stdout || err.message || "").trim(), secrets)
            .replace(/\s+/g, " ")
            .slice(0, 300);
          resolveResult({
            ok: false,
            code: "probe_failed",
            message: detail || `probe '${probeName}' exited non-zero`,
          });
          return;
        }
        const output = parseProbeStdout(String(stdout ?? ""));
        resolveResult({
          ok: true,
          probeName,
          output: {
            triggered: output.triggered,
            ...(output.summary !== undefined ? { summary: redactText(output.summary, secrets).slice(0, 1000) } : {}),
            ...(output.data !== undefined ? { data: output.data } : {}),
          },
          durationMs,
        });
      },
    );

    child.stdin?.end();
    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }, timeoutMs);
    timer.unref?.();
  });
}

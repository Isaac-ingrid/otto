// Locally approved worktree lifecycle hooks (ADR-0022 Decisions 3 & 4; Plan §5 / Stage 2).
//
// Trust boundary:
// - Hook configuration lives exclusively in LocalStore (`connector.sqlite` `repo` table),
//   settable only via the machine-local `otto repo-config` CLI.
// - Entry scripts must reside strictly inside `<stateDir>/hooks` (resolved with realpathSync
//   to defeat `..` traversal and symlinks pointing into a repository or elsewhere on disk).
// - `--approve-hooks` binds SHA-256(canonicalHookSpec + "\0" + setupBytes + "\0" + archiveBytes).
//   Every runtime invocation recomputes the digest against live disk bytes before spawning.
// - Execution uses `execFile` with argument array `[]` (never `shell: true`), immediate stdin
//   EOF, `childEnv` credential scrubbing (`OTTO_*` stripped), bounded timeout, and redacted
//   tails written to `<stateDir>/logs/hook-<workerId>.log`.
import { execFile } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { killOrphans, listDescendants } from "./descendants.ts";
import { terminateProcess } from "./kill.ts";
import { childEnv } from "./pi-adapter.ts";
import { proxyEnvFor, type ProxyConfig } from "./proxy.ts";
import { redactText } from "./redact.ts";

export const DEFAULT_HOOK_TIMEOUT_MS = 180_000;
export const MAX_HOOK_LOG_CHARS = 16_384;
const MAX_HOOK_BUFFER_BYTES = 8 * 1024 * 1024;
const MAX_HOOK_ERROR_CHARS = 320;

export type HookPhase = "setup" | "archive";

export interface RepoHooksConfig {
  readonly setupHook: string | null;
  readonly archiveHook: string | null;
  readonly hookApprovedSha256: string | null;
  readonly hookApprovedAt: number | null;
}

export const EMPTY_REPO_HOOKS: RepoHooksConfig = {
  setupHook: null,
  archiveHook: null,
  hookApprovedSha256: null,
  hookApprovedAt: null,
};

export interface RepoHookCapabilitySummary {
  capabilityKind: "git" | "plain";
  hasSetupHook: boolean;
  hasArchiveHook: boolean;
  approved: boolean;
}

export class HookConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HookConfigError";
  }
}

export class HookExecutionError extends Error {
  constructor(
    readonly code: "setup_hook_failed" | "archive_hook_failed",
    message: string,
  ) {
    super(message);
    this.name = "HookExecutionError";
  }
}

export function hooksRootDir(stateDir: string): string {
  return join(stateDir, "hooks");
}

export function hookLogPath(stateDir: string, workerId: string): string {
  return join(stateDir, "logs", `hook-${workerId}.log`);
}

function isContainedRelative(rel: string): boolean {
  if (!rel || rel === "." || rel === "..") return false;
  if (isAbsolute(rel)) return false;
  if (rel.startsWith(`..${sep}`) || rel.startsWith("../") || rel.startsWith("..\\")) return false;
  return true;
}

/** Resolves a hook script reference (`setup.sh` or `<stateDir>/hooks/setup.sh`) and proves
 *  both lexically and via `realpathSync` that the target is a regular file strictly inside
 *  `<stateDir>/hooks`. Symlinks pointing into a repository or outside `<stateDir>/hooks` are
 *  rejected. Returns the canonical `/` relative name for storage plus the verified realpath. */
export function normalizeHookScriptInput(
  stateDir: string,
  rawScript: string,
): { canonicalName: string; realPath: string } {
  if (typeof rawScript !== "string" || rawScript.includes("\0")) {
    throw new HookConfigError("hook script path must be a non-empty path without NUL bytes");
  }
  const trimmed = rawScript.trim();
  if (!trimmed) {
    throw new HookConfigError("hook script path must not be empty");
  }
  const rootDir = resolve(hooksRootDir(stateDir));
  const candidate = isAbsolute(trimmed) ? resolve(trimmed) : resolve(rootDir, trimmed);
  const lexicalRel = relative(rootDir, candidate);
  if (!isContainedRelative(lexicalRel)) {
    throw new HookConfigError(
      `hook script '${trimmed}' must reside inside ${rootDir} (repository-committed or external paths are forbidden)`,
    );
  }
  if (!existsSync(rootDir) || !existsSync(candidate)) {
    throw new HookConfigError(`hook script '${trimmed}' does not exist in ${rootDir}`);
  }
  let realRoot: string;
  let realCandidate: string;
  try {
    realRoot = realpathSync(rootDir);
    realCandidate = realpathSync(candidate);
  } catch {
    throw new HookConfigError(`hook script '${trimmed}' could not be resolved in ${rootDir}`);
  }
  const realRel = relative(realRoot, realCandidate);
  if (!isContainedRelative(realRel)) {
    throw new HookConfigError(
      `hook script '${trimmed}' resolves outside ${rootDir} via symlink (forbidden)`,
    );
  }
  const st = statSync(realCandidate);
  if (!st.isFile()) {
    throw new HookConfigError(`hook script '${trimmed}' must be a regular file inside ${rootDir}`);
  }
  return {
    canonicalName: lexicalRel.split(sep).join("/"),
    realPath: realCandidate,
  };
}

export type HookDigestResult =
  | {
      ok: true;
      sha256: string;
      canonicalSetup: string | null;
      canonicalArchive: string | null;
      setupPath: string | null;
      archivePath: string | null;
    }
  | {
      ok: false;
      reason: string;
    };

/** Computes `SHA-256(canonicalHookSpec + "\0" + setupScriptBytes + "\0" + archiveScriptBytes)`
 *  from live script files on disk after containment verification. */
export function computeHooksApprovalDigest(
  stateDir: string,
  spec: { setupHook: string | null; archiveHook: string | null },
): HookDigestResult {
  if (!spec.setupHook && !spec.archiveHook) {
    return { ok: false, reason: "no hooks configured" };
  }
  try {
    const setupResolved = spec.setupHook ? normalizeHookScriptInput(stateDir, spec.setupHook) : null;
    const archiveResolved = spec.archiveHook ? normalizeHookScriptInput(stateDir, spec.archiveHook) : null;
    const setupBytes = setupResolved ? readFileSync(setupResolved.realPath) : Buffer.alloc(0);
    const archiveBytes = archiveResolved ? readFileSync(archiveResolved.realPath) : Buffer.alloc(0);
    const canonicalHookSpec = JSON.stringify({
      setupHook: setupResolved?.canonicalName ?? null,
      archiveHook: archiveResolved?.canonicalName ?? null,
      setupBytes: setupBytes.byteLength,
      archiveBytes: archiveBytes.byteLength,
    });
    const sha256 = createHash("sha256")
      .update(canonicalHookSpec, "utf8")
      .update("\0", "utf8")
      .update(setupBytes)
      .update("\0", "utf8")
      .update(archiveBytes)
      .digest("hex");
    return {
      ok: true,
      sha256,
      canonicalSetup: setupResolved?.canonicalName ?? null,
      canonicalArchive: archiveResolved?.canonicalName ?? null,
      setupPath: setupResolved?.realPath ?? null,
      archivePath: archiveResolved?.realPath ?? null,
    };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

export interface HookVerification {
  configured: boolean;
  approved: boolean;
  reason?: string;
  sha256?: string;
  setupPath?: string | null;
  archivePath?: string | null;
}

function digestsMatch(expectedHex: string, actualHex: string): boolean {
  if (expectedHex.length !== actualHex.length || !/^[0-9a-f]+$/i.test(expectedHex) || !/^[0-9a-f]+$/i.test(actualHex)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(expectedHex.toLowerCase(), "utf8"), Buffer.from(actualHex.toLowerCase(), "utf8"));
}

/** Verifies that a repo's configured hooks exist under `<stateDir>/hooks` and match their
 *  stored SHA-256 approval digest byte-for-byte. */
export function verifyRepoHooks(stateDir: string, hooks: RepoHooksConfig): HookVerification {
  const configured = Boolean(hooks.setupHook || hooks.archiveHook);
  if (!configured) return { configured: false, approved: false };
  const digest = computeHooksApprovalDigest(stateDir, hooks);
  if (!digest.ok) {
    return { configured: true, approved: false, reason: digest.reason };
  }
  if (!hooks.hookApprovedSha256) {
    return {
      configured: true,
      approved: false,
      reason: "hooks have not been approved yet",
      sha256: digest.sha256,
    };
  }
  if (!digestsMatch(hooks.hookApprovedSha256, digest.sha256)) {
    return {
      configured: true,
      approved: false,
      reason: "hook configuration or script bytes changed since approval (SHA-256 mismatch)",
      sha256: digest.sha256,
    };
  }
  return {
    configured: true,
    approved: true,
    sha256: digest.sha256,
    setupPath: digest.setupPath,
    archivePath: digest.archivePath,
  };
}

/** Builds the wire-safe boolean summary reported in `hello.repos` and `register_repo`.
 *  Never exposes script contents or machine-local file paths. */
export function repoHookCapabilitySummary(
  repo: { capability: { kind: "git" | "plain" }; hooks: RepoHooksConfig },
  stateDir: string,
): RepoHookCapabilitySummary {
  const capabilityKind = repo.capability.kind;
  const hasSetupHook = Boolean(repo.hooks.setupHook);
  const hasArchiveHook = Boolean(repo.hooks.archiveHook);
  const approved =
    capabilityKind === "git" && (hasSetupHook || hasArchiveHook)
      ? verifyRepoHooks(stateDir, repo.hooks).approved
      : false;
  return { capabilityKind, hasSetupHook, hasArchiveHook, approved };
}

function boundedTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `…[truncated ${text.length - maxChars} chars]\n${text.slice(-maxChars)}`;
}

function appendHookLog(
  stateDir: string,
  workerId: string,
  phase: HookPhase,
  status: string,
  durationMs: number,
  body: string,
  secrets: Iterable<string>,
): void {
  try {
    const logDir = join(stateDir, "logs");
    mkdirSync(logDir, { recursive: true });
    const redactedBody = redactText(boundedTail(body, MAX_HOOK_LOG_CHARS), secrets);
    const header = `[${new Date().toISOString()}] phase=${phase} status=${status} durationMs=${durationMs}\n`;
    const suffix = redactedBody ? `${redactedBody.endsWith("\n") ? redactedBody : `${redactedBody}\n`}` : "";
    appendFileSync(hookLogPath(stateDir, workerId), `${header}${suffix}`, { mode: 0o600 });
  } catch {
    // Log-write issues must never mask the hook verdict itself.
  }
}

export interface RunWorktreeHookOptions {
  phase: HookPhase;
  workerId: string;
  repoName: string;
  repoPath: string;
  worktreePath: string;
  hooks: RepoHooksConfig;
  stateDir: string;
  proxy?: ProxyConfig | null;
  secrets?: Iterable<string>;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}

/** Validates live SHA-256 approval and runs a `setup` or `archive` hook inside `worktreePath`
 *  via `execFile(scriptPath, [])` (never `shell: true`), `stdin` closed immediately, scrubbed
 *  `childEnv`, hard timeout with descendant cleanup, and redacted log tail. */
export async function runWorktreeHook(options: RunWorktreeHookOptions): Promise<void> {
  const errorCode = options.phase === "setup" ? "setup_hook_failed" : "archive_hook_failed";
  const secrets = [...(options.secrets ?? [])];
  const configuredScript = options.phase === "setup" ? options.hooks.setupHook : options.hooks.archiveHook;
  if (!configuredScript) return;

  const startMs = Date.now();
  const verified = verifyRepoHooks(options.stateDir, options.hooks);
  if (!verified.approved) {
    const detail =
      `${options.phase} hook refused for '${options.repoName}': ${verified.reason ?? "unapproved"}. ` +
      `Run 'otto repo-config ${options.repoPath} --approve-hooks' on this machine.`;
    appendHookLog(options.stateDir, options.workerId, options.phase, "refused", Date.now() - startMs, detail, secrets);
    throw new HookExecutionError(errorCode, redactText(detail, secrets).slice(0, MAX_HOOK_ERROR_CHARS));
  }

  const scriptPath = options.phase === "setup" ? verified.setupPath : verified.archivePath;
  if (!scriptPath) return;

  const timeoutMs = options.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
  const env = childEnv(process.env, options.proxy ? proxyEnvFor(options.proxy) : undefined);

  await new Promise<void>((resolvePromise, rejectPromise) => {
    let settled = false;
    let timedOut = false;
    let aborted = false;

    const killChildTree = async (pid: number | undefined): Promise<void> => {
      if (!pid) return;
      const descendants = await listDescendants(pid).catch(() => []);
      try {
        terminateProcess(pid, "SIGKILL");
      } catch {
        // already exited
      }
      if (descendants.length > 0) {
        await killOrphans(descendants).catch(() => []);
      }
    };

    const child = execFile(
      scriptPath,
      [],
      {
        cwd: options.worktreePath,
        env,
        maxBuffer: MAX_HOOK_BUFFER_BYTES,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.abortSignal?.removeEventListener("abort", onAbort);
        const durationMs = Date.now() - startMs;
        const combined = [stdout ? `stdout:\n${stdout}` : "", stderr ? `stderr:\n${stderr}` : ""]
          .filter(Boolean)
          .join("\n");

        if (!err && !timedOut && !aborted) {
          appendHookLog(options.stateDir, options.workerId, options.phase, "ok", durationMs, combined, secrets);
          resolvePromise();
          return;
        }

        const status = timedOut ? "timeout" : aborted ? "aborted" : "failed";
        appendHookLog(options.stateDir, options.workerId, options.phase, status, durationMs, combined, secrets);
        const errTail = redactText((stderr || stdout || err?.message || "").trim(), secrets)
          .replace(/\s+/g, " ")
          .slice(0, 180);
        const reason = timedOut
          ? `${options.phase} hook timed out after ${timeoutMs}ms`
          : aborted
            ? `${options.phase} hook aborted`
            : `${options.phase} hook failed${errTail ? `: ${errTail}` : ""}`;
        rejectPromise(new HookExecutionError(errorCode, reason.slice(0, MAX_HOOK_ERROR_CHARS)));
      },
    );

    // Non-interactive contract: close stdin immediately so any read hits EOF instead of hanging.
    child.stdin?.end();

    const forceFinish = (why: "timeout" | "abort"): void => {
      if (settled) return;
      if (why === "timeout") timedOut = true;
      else aborted = true;
      const pid = child.pid;
      void killChildTree(pid).finally(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
      });
    };

    const timer = setTimeout(() => forceFinish("timeout"), timeoutMs);
    timer.unref?.();

    const onAbort = (): void => forceFinish("abort");
    if (options.abortSignal) {
      if (options.abortSignal.aborted) onAbort();
      else options.abortSignal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

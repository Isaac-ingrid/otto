// Controlled repository skill catalog & single-file Markdown sync engine (Direction 2B, Stage 1).
// Enforces registered-repo / active-worktree confinement, 3 whitelisted Markdown slots,
// segment-by-segment lstat symlink blocking, secret-leak preflight, and SHA-256 CAS writes.
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { promisify } from "node:util";
import {
  isValidSkillSlug,
  REPO_SKILL_LIST_MAX_BYTES,
  REPO_SKILL_LIST_MAX_ITEMS,
  REPO_SKILL_MAX_BYTES,
  type RepoSkillError,
  type RepoSkillGitStatus,
  type RepoSkillOpArgs,
  type RepoSkillResult,
  type RepoSkillSummary,
  type RepoSkillTarget,
} from "@isaac2ingrid/protocol";

const execGit = promisify(execFile);

const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}\b/,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{12,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{20,}\b/,
  /\bAQ\.[A-Za-z0-9._-]{20,}\b/,
];

class SkillOpException extends Error {
  code: RepoSkillError;
  existingSha256?: string;
  constructor(code: RepoSkillError, message: string, existingSha256?: string) {
    super(message);
    this.code = code;
    this.existingSha256 = existingSha256;
  }
}

interface SlotSpec {
  target: RepoSkillTarget;
  baseSegments: readonly string[];
  ownsSubdir: boolean;
  fileSegments(slug: string): string[];
  relativePath(slug: string): string;
}

const SLOTS: readonly SlotSpec[] = [
  {
    target: "agents-skill",
    baseSegments: [".agents", "skills"],
    ownsSubdir: true,
    fileSegments: (slug) => [".agents", "skills", slug, "SKILL.md"],
    relativePath: (slug) => `.agents/skills/${slug}/SKILL.md`,
  },
  {
    target: "claude-skill",
    baseSegments: [".claude", "skills"],
    ownsSubdir: true,
    fileSegments: (slug) => [".claude", "skills", slug, "SKILL.md"],
    relativePath: (slug) => `.claude/skills/${slug}/SKILL.md`,
  },
  {
    target: "claude-command",
    baseSegments: [".claude", "commands"],
    ownsSubdir: false,
    fileSegments: (slug) => [".claude", "commands", `${slug}.md`],
    relativePath: (slug) => `.claude/commands/${slug}.md`,
  },
];

const slotFor = (target: RepoSkillTarget): SlotSpec => {
  const found = SLOTS.find((s) => s.target === target);
  if (!found) throw new SkillOpException("unsupported", `unsupported target ${target}`);
  return found;
};

export function sha256Hex(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function containsSecretToken(text: string, extraSecrets: Iterable<string> = []): boolean {
  for (const secret of extraSecrets) {
    if (secret && secret.length >= 12 && text.includes(secret)) return true;
  }
  return SECRET_PATTERNS.some((re) => re.test(text));
}

export function parseSkillFrontmatter(markdown: string, fallbackSlug: string): { name: string; description: string } {
  const normalized = markdown.replace(/\r\n/g, "\n");
  let name = "";
  let description = "";
  let body = normalized;

  if (normalized.startsWith("---\n")) {
    const endIdx = normalized.indexOf("\n---", 4);
    if (endIdx !== -1) {
      const fm = normalized.slice(4, endIdx);
      body = normalized.slice(endIdx + 4).replace(/^\n+/, "");
      for (const line of fm.split("\n")) {
        const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim());
        if (!match) continue;
        const key = match[1]!.toLowerCase();
        const rawVal = match[2]!.trim().replace(/^(['"])([\s\S]*)\1$/, "$2").trim();
        if (key === "name" && rawVal && !name) name = rawVal;
        if (key === "description" && rawVal && !description) description = rawVal;
      }
    }
  }

  if (!name || !description) {
    for (const rawLine of body.split("\n")) {
      const line = rawLine.trim();
      if (!line) continue;
      if (line.startsWith("#")) {
        if (!name) name = line.replace(/^#+\s*/, "").trim();
        continue;
      }
      if (!description && !line.startsWith("```") && !line.startsWith("---")) {
        description = line;
        if (name) break;
      }
    }
  }

  return {
    name: (name || fallbackSlug).replace(/\s+/g, " ").slice(0, 120),
    description: description.replace(/\s+/g, " ").slice(0, 280),
  };
}

async function resolveCanonicalRoot(rootDir: string): Promise<string> {
  try {
    const st = await lstat(rootDir);
    if (st.isSymbolicLink()) throw new SkillOpException("symlink_forbidden", "repository root cannot be a symlink");
    if (!st.isDirectory()) throw new SkillOpException("not_found", "repository directory is missing");
    return await realpath(rootDir);
  } catch (err) {
    if (err instanceof SkillOpException) throw err;
    throw new SkillOpException("not_found", "repository directory is missing");
  }
}

function assertInsideRoot(realRoot: string, candidateReal: string): void {
  const prefix = realRoot.endsWith(sep) ? realRoot : `${realRoot}${sep}`;
  if (candidateReal !== realRoot && !candidateReal.startsWith(prefix)) {
    throw new SkillOpException("symlink_forbidden", "resolved skill path escaped repository root");
  }
}

async function walkCheckedPath(
  realRoot: string,
  segments: readonly string[],
  expectFinal: "file" | "dir",
): Promise<{ fullPath: string; exists: boolean }> {
  let curr = realRoot;
  let deepestExisting = realRoot;
  let exists = true;

  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i]!;
    curr = join(curr, seg);
    if (!exists) continue;
    try {
      const st = await lstat(curr);
      if (st.isSymbolicLink()) {
        throw new SkillOpException("symlink_forbidden", `symbolic link forbidden at '${seg}'`);
      }
      const isLast = i === segments.length - 1;
      if (!isLast && !st.isDirectory()) {
        throw new SkillOpException("io_failed", `non-directory segment '${seg}'`);
      }
      if (isLast) {
        if (expectFinal === "file" && !st.isFile()) {
          throw new SkillOpException("io_failed", `target '${seg}' is not a regular file`);
        }
        if (expectFinal === "dir" && !st.isDirectory()) {
          throw new SkillOpException("io_failed", `target '${seg}' is not a directory`);
        }
      }
      deepestExisting = curr;
    } catch (err) {
      if (err instanceof SkillOpException) throw err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        exists = false;
      } else {
        throw new SkillOpException("io_failed", "failed to inspect skill path");
      }
    }
  }

  const realExisting = await realpath(deepestExisting);
  assertInsideRoot(realRoot, realExisting);
  return { fullPath: curr, exists };
}

async function ensureSafeDirs(realRoot: string, dirSegments: readonly string[]): Promise<string> {
  let curr = realRoot;
  for (const seg of dirSegments) {
    curr = join(curr, seg);
    try {
      const st = await lstat(curr);
      if (st.isSymbolicLink()) throw new SkillOpException("symlink_forbidden", `symbolic link forbidden at '${seg}'`);
      if (!st.isDirectory()) throw new SkillOpException("io_failed", `'${seg}' is not a directory`);
    } catch (err) {
      if (err instanceof SkillOpException) throw err;
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new SkillOpException("io_failed", "failed to prepare skill directory");
      }
      await mkdir(curr, { mode: 0o755 });
    }
    assertInsideRoot(realRoot, await realpath(curr));
  }
  return curr;
}

async function collectGitStatuses(realRoot: string, isGitRepo: boolean): Promise<Map<string, RepoSkillGitStatus>> {
  const map = new Map<string, RepoSkillGitStatus>();
  if (!isGitRepo) return map;
  try {
    const prefixOut = await execGit("git", ["rev-parse", "--show-prefix"], { cwd: realRoot, timeout: 3000 });
    const subPrefix = prefixOut.stdout.replace(/\r?\n$/, "");
    const { stdout } = await execGit(
      "git",
      ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ".agents/skills", ".claude/skills", ".claude/commands"],
      { cwd: realRoot, timeout: 3000, maxBuffer: 512 * 1024 },
    );
    const records = stdout.split("\0");
    for (let i = 0; i < records.length; i += 1) {
      const rec = records[i]!;
      if (rec.length < 4) continue;
      const xy = rec.slice(0, 2);
      let relPath = rec.slice(3);
      if (xy.startsWith("R") || xy.startsWith("C")) i += 1;
      if (subPrefix && relPath.startsWith(subPrefix)) relPath = relPath.slice(subPrefix.length);
      map.set(relPath, xy === "??" ? "untracked" : "modified");
    }
  } catch {
    // Non-fatal: fall back to 'clean' when git status cannot run.
  }
  return map;
}

async function summarizeSkillFile(input: {
  filePath: string;
  target: RepoSkillTarget;
  slug: string;
  relativePath: string;
  isGitRepo: boolean;
  gitStatuses: Map<string, RepoSkillGitStatus>;
}): Promise<{ summary: RepoSkillSummary; markdown: string }> {
  const st = await lstat(input.filePath);
  if (st.isSymbolicLink()) throw new SkillOpException("symlink_forbidden", "skill file cannot be a symlink");
  if (!st.isFile()) throw new SkillOpException("not_found", "skill file not found");
  if (st.size > REPO_SKILL_MAX_BYTES) throw new SkillOpException("too_large", "skill file exceeds 32 KiB limit");
  const buf = await readFile(input.filePath);
  if (buf.byteLength > REPO_SKILL_MAX_BYTES) throw new SkillOpException("too_large", "skill file exceeds 32 KiB limit");
  const markdown = buf.toString("utf8");
  const meta = parseSkillFrontmatter(markdown, input.slug);
  const gitStatus: RepoSkillGitStatus = !input.isGitRepo
    ? "plain"
    : (input.gitStatuses.get(input.relativePath) ?? "clean");
  return {
    markdown,
    summary: {
      target: input.target,
      slug: input.slug,
      relativePath: input.relativePath,
      name: meta.name,
      description: meta.description,
      bytes: buf.byteLength,
      updatedAt: Math.floor(st.mtimeMs),
      sha256: sha256Hex(buf),
      gitStatus,
    },
  };
}

export interface ExecuteRepoSkillOpInput {
  rootDir: string;
  isGitRepo: boolean;
  projectApproved?: boolean;
  op: RepoSkillOpArgs;
  extraSecrets?: Iterable<string>;
}

export async function executeRepoSkillOp(input: ExecuteRepoSkillOpInput): Promise<RepoSkillResult> {
  try {
    const realRoot = await resolveCanonicalRoot(input.rootDir);
    const { op, isGitRepo } = input;

    if (op.action === "list") {
      const gitStatuses = await collectGitStatuses(realRoot, isGitRepo);
      const skills: RepoSkillSummary[] = [];
      let truncated = false;
      let approxBytes = 64;

      for (const slot of SLOTS) {
        const baseCheck = await walkCheckedPath(realRoot, slot.baseSegments, "dir");
        if (!baseCheck.exists) continue;
        const entries = await readdir(baseCheck.fullPath, { withFileTypes: true });
        entries.sort((a, b) => a.name.localeCompare(b.name));

        for (const entry of entries) {
          if (entry.isSymbolicLink()) continue;
          let slug: string | null = null;
          if (slot.ownsSubdir && entry.isDirectory() && isValidSkillSlug(entry.name)) {
            slug = entry.name;
          } else if (!slot.ownsSubdir && entry.isFile() && entry.name.endsWith(".md")) {
            const candidate = entry.name.slice(0, -3);
            if (isValidSkillSlug(candidate)) slug = candidate;
          }
          if (!slug) continue;

          const fileSegments = slot.fileSegments(slug);
          let checked: { fullPath: string; exists: boolean };
          try {
            checked = await walkCheckedPath(realRoot, fileSegments, "file");
          } catch {
            continue;
          }
          if (!checked.exists) continue;

          let item: { summary: RepoSkillSummary; markdown: string };
          try {
            item = await summarizeSkillFile({
              filePath: checked.fullPath,
              target: slot.target,
              slug,
              relativePath: slot.relativePath(slug),
              isGitRepo,
              gitStatuses,
            });
          } catch {
            continue;
          }

          const itemBytes = Buffer.byteLength(JSON.stringify(item.summary), "utf8") + 2;
          if (skills.length >= REPO_SKILL_LIST_MAX_ITEMS || approxBytes + itemBytes > REPO_SKILL_LIST_MAX_BYTES) {
            truncated = true;
            break;
          }
          skills.push(item.summary);
          approxBytes += itemBytes;
        }
        if (truncated) break;
      }

      return {
        ok: true,
        data: {
          action: "list",
          skills,
          ...(truncated ? { truncated: true } : {}),
          ...(input.projectApproved !== undefined ? { projectApproved: input.projectApproved } : {}),
        },
      };
    }

    if (!isValidSkillSlug(op.slug)) {
      return { ok: false, code: "invalid_slug" };
    }
    const slot = slotFor(op.target);
    const fileSegments = slot.fileSegments(op.slug);
    const relativePath = slot.relativePath(op.slug);
    const checked = await walkCheckedPath(realRoot, fileSegments, "file");

    if (op.action === "read") {
      if (!checked.exists) return { ok: false, code: "not_found" };
      const gitStatuses = await collectGitStatuses(realRoot, isGitRepo);
      const { summary, markdown } = await summarizeSkillFile({
        filePath: checked.fullPath,
        target: slot.target,
        slug: op.slug,
        relativePath,
        isGitRepo,
        gitStatuses,
      });
      return { ok: true, data: { action: "read", summary, markdown } };
    }

    if (op.action === "write") {
      const normalized = `${op.markdown.replace(/\r\n/g, "\n").trimEnd()}\n`;
      if (normalized.trim().length === 0) return { ok: false, code: "io_failed" };
      const nextBuf = Buffer.from(normalized, "utf8");
      if (nextBuf.byteLength > REPO_SKILL_MAX_BYTES) return { ok: false, code: "too_large" };
      if (containsSecretToken(normalized, input.extraSecrets)) {
        return { ok: false, code: "secret_detected" };
      }

      if (checked.exists) {
        const existingBuf = await readFile(checked.fullPath);
        const existingSha = sha256Hex(existingBuf);
        if (op.expectedSha256 !== undefined) {
          if (existingSha !== op.expectedSha256) {
            return { ok: false, code: "sha256_conflict", existingSha256: existingSha };
          }
        } else if (op.overwrite !== true) {
          return { ok: false, code: "already_exists", existingSha256: existingSha };
        }
      } else if (op.expectedSha256 !== undefined) {
        return { ok: false, code: "sha256_conflict" };
      }

      const dirSegments = fileSegments.slice(0, -1);
      const parentDir = await ensureSafeDirs(realRoot, dirSegments);
      const tmpPath = join(parentDir, `.otto-skill-${randomUUID()}.tmp`);
      try {
        await writeFile(tmpPath, nextBuf, { mode: 0o644 });
        const postCheck = await lstat(checked.fullPath).catch(() => null);
        if (postCheck?.isSymbolicLink()) {
          throw new SkillOpException("symlink_forbidden", "target replaced by symlink before rename");
        }
        await rename(tmpPath, checked.fullPath);
      } catch (err) {
        await unlink(tmpPath).catch(() => undefined);
        if (err instanceof SkillOpException) throw err;
        throw new SkillOpException("io_failed", "failed to write skill file");
      }

      const gitStatuses = await collectGitStatuses(realRoot, isGitRepo);
      const { summary } = await summarizeSkillFile({
        filePath: checked.fullPath,
        target: slot.target,
        slug: op.slug,
        relativePath,
        isGitRepo,
        gitStatuses,
      });
      return {
        ok: true,
        data: {
          action: "write",
          summary,
          ...(input.projectApproved !== undefined ? { projectApproved: input.projectApproved } : {}),
        },
      };
    }

    // op.action === "delete"
    if (!checked.exists) return { ok: false, code: "not_found" };
    const existingBuf = await readFile(checked.fullPath);
    const existingSha = sha256Hex(existingBuf);
    if (existingSha !== op.expectedSha256) {
      return { ok: false, code: "sha256_conflict", existingSha256: existingSha };
    }
    await unlink(checked.fullPath);
    if (slot.ownsSubdir) {
      const subDir = dirname(checked.fullPath);
      const remaining = await readdir(subDir).catch(() => ["keep"]);
      if (remaining.length === 0) {
        await rmdir(subDir).catch(() => undefined);
      }
    }
    return { ok: true, data: { action: "delete", deleted: true, relativePath } };
  } catch (err) {
    if (err instanceof SkillOpException) {
      return {
        ok: false,
        code: err.code,
        ...(err.existingSha256 ? { existingSha256: err.existingSha256 } : {}),
      };
    }
    return { ok: false, code: "io_failed" };
  }
}

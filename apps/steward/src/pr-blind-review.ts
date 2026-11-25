// Stage 4 Zero-Checkout Blind PR Review (`pr-blind-review.ts`).
//
// Design invariants:
// 1. Cross-engine / clean-session isolation: prefers a distinct coding agent family from the PR's
//    author worker (e.g. author `claude-code` -> reviewer `codex`/`pi`/`opencode`; author `codex`
//    -> reviewer `claude-code`/`pi`/`opencode`). When only a single agent is installed, falls back
//    to a brand-new clean readonly session (`crossEngine: false`) with zero author history.
// 2. Author reasoning stripped: the review prompt contains ONLY PR metadata, changed file list, and
//    unified zero-checkout git diff (`git_pr_diff`), never the author worker's conversation or
//    self-justification (`escapeMarkers` prevents untrusted diff hunks from forging system wakes).
// 3. Zero working-tree mutation: fetches PR diff via `readGitPrDiff` (`-c core.hooksPath=/dev/null`,
//    no checkout/merge/reset) and explicitly surfaces `octopus_merge_refused` when `parentCount > 2`.
import type { GitPrDiffPayload, GitPrDiffResultMessage } from "@isaac2ingrid/protocol";
import type { SqlExecutor } from "./schema.ts";
import { escapeMarkers } from "./wake-text.ts";

export type BlindReviewStatus =
  | "ready"
  | "dispatched"
  | "refused_octopus_merge"
  | "diff_failed";

export interface PrBlindReviewRow {
  watchId: string;
  head: string;
  reviewerAgent: string;
  authorAgent: string | null;
  diffStatJson: string;
  reviewJson: string | null;
  status: BlindReviewStatus;
  createdAt: number;
  updatedAt: number;
}

export interface BlindReviewerSelection {
  agent: string;
  crossEngine: boolean;
}

const PREFERRED_REVIEWER_ORDER: readonly string[] = [
  "codex",
  "claude-code",
  "pi",
  "opencode",
  "antigravity",
  "agentica",
  "dsh",
  "zcode",
  "command",
];

function agentFamily(agent: string): string {
  if (agent === "claude-code") return "anthropic";
  if (agent === "codex") return "openai";
  if (agent === "antigravity") return "google";
  return agent;
}

/** Picks a blind-review engine: prefers a different agent family from `authorAgent` when available
 *  on the target machine; otherwise falls back to a clean isolated session on the available engine. */
export function selectBlindReviewerAgent(
  authorAgent: string | null | undefined,
  availableAgents: readonly string[],
): BlindReviewerSelection | null {
  const cleanAvailable = availableAgents.filter((k) => Boolean(k));
  if (cleanAvailable.length === 0) return null;

  const ranked = [
    ...PREFERRED_REVIEWER_ORDER.filter((k) => cleanAvailable.includes(k)),
    ...cleanAvailable.filter((k) => !PREFERRED_REVIEWER_ORDER.includes(k)),
  ];

  if (authorAgent) {
    const authorFam = agentFamily(authorAgent);
    const distinct = ranked.find((candidate) => agentFamily(candidate) !== authorFam);
    if (distinct) {
      return { agent: distinct, crossEngine: true };
    }
  }

  return { agent: ranked[0]!, crossEngine: false };
}

/** Builds a strictly author-isolated blind review prompt from zero-checkout diff facts ONLY.
 *  Never embeds author worker summaries, chain-of-thought, or thread conversation turns. */
export function buildAuthorIsolatedBlindReviewPrompt(input: {
  prUrl: string;
  prNumber?: number;
  diff: GitPrDiffPayload;
}): string {
  const filesList = input.diff.changedFiles
    .slice(0, 60)
    .map((f) => `- ${escapeMarkers(f)}`)
    .join("\n");
  const overflowCount = Math.max(0, input.diff.changedFiles.length - 60);
  const safePatch = escapeMarkers(input.diff.patch);

  return [
    "你正在执行一次独立的零上下文 PR 盲审（Zero-Context Blind Code Review，只读模式）。",
    "为消除原作者的思维定势，系统已刻意剥离原作者的所有对话记录与解释说明；请仅依据下方的真实代码变更独立判断。",
    "",
    `PR 地址：${escapeMarkers(input.prUrl)}${input.prNumber ? ` (#${input.prNumber})` : ""}`,
    `基线提交 (base)：${input.diff.baseSha}`,
    `目标提交 (head)：${input.diff.headSha}`,
    `变更文件数：${input.diff.filesChanged}${input.diff.truncated ? "（补丁超长已截断，必要时可在只读工作区按路径查阅原文件）" : ""}`,
    "",
    "变更文件列表：",
    filesList || "- （无文件变更）",
    ...(overflowCount > 0 ? [`- …另有 ${overflowCount} 个文件未展开`] : []),
    "",
    "审查要求：",
    "1. 只关注真正会导致线上故障的缺陷：边界条件遗漏、并发与状态竞态、权限或安全绕过、契约不一致、关键测试缺失。",
    "2. 禁止在工作区做任何写入、提交、分支切换或远端操作。",
    "3. 完成后用结构化汇报给出明确结论（若无实质性缺陷则直接说明通过，不要凑数提纯风格建议）。",
    "",
    "Unified Diff：",
    "```diff",
    safePatch,
    "```",
  ].join("\n");
}

export type GitDiffReader = (
  deviceId: string,
  args: { repoId: string; prNumber?: number; headSha?: string; baseRef?: string; maxBytes?: number },
) => Promise<
  | GitPrDiffResultMessage
  | { ok: false; code: "machine_offline" | "diff_timeout" | "unsupported" | "git_failed" }
>;

export interface PrepareBlindReviewInput {
  sql: SqlExecutor;
  watchId: string;
  prUrl: string;
  prNumber?: number;
  headSha?: string;
  baseRef?: string;
  deviceId: string;
  repoId: string;
  authorAgent?: string | null;
  availableAgents: readonly string[];
  readGitPrDiff: GitDiffReader;
  now?: () => number;
}

export type PrepareBlindReviewOutcome =
  | {
      ok: true;
      reviewer: BlindReviewerSelection;
      diff: GitPrDiffPayload;
      prompt: string;
      record: PrBlindReviewRow;
    }
  | {
      ok: false;
      code:
        | "no_reviewer_agent"
        | "octopus_merge_refused"
        | "machine_offline"
        | "diff_timeout"
        | "unsupported"
        | "git_failed";
      message: string;
    };

export async function prepareZeroCheckoutBlindReview(
  input: PrepareBlindReviewInput,
): Promise<PrepareBlindReviewOutcome> {
  const ts = input.now?.() ?? Date.now();
  const reviewer = selectBlindReviewerAgent(input.authorAgent, input.availableAgents);
  if (!reviewer) {
    return {
      ok: false,
      code: "no_reviewer_agent",
      message: "目标机器没有可用于盲审的已安装 Agent。",
    };
  }

  const diffRes = await input.readGitPrDiff(input.deviceId, {
    repoId: input.repoId,
    ...(input.prNumber !== undefined ? { prNumber: input.prNumber } : {}),
    ...(input.headSha !== undefined ? { headSha: input.headSha } : {}),
    ...(input.baseRef !== undefined ? { baseRef: input.baseRef } : {}),
  });

  if (!diffRes.ok) {
    const headKey = input.headSha ?? "unknown";
    if (diffRes.code === "octopus_merge_refused") {
      input.sql`
        INSERT INTO sh_pr_blind_review (
          watchId, head, reviewerAgent, authorAgent, diffStatJson, reviewJson, status, createdAt, updatedAt
        )
        VALUES (
          ${input.watchId}, ${headKey}, ${reviewer.agent}, ${input.authorAgent ?? null},
          ${JSON.stringify({ refusedReason: "octopus_merge_refused" })},
          ${null}, 'refused_octopus_merge', ${ts}, ${ts}
        )
        ON CONFLICT (watchId, head) DO UPDATE SET
          status = 'refused_octopus_merge',
          updatedAt = excluded.updatedAt
      `;
      input.sql`
        UPDATE sh_pr_watch SET blindReviewStatus = 'refused_octopus_merge' WHERE id = ${input.watchId}
      `;
      return {
        ok: false,
        code: "octopus_merge_refused",
        message: "该 PR 含有多父节点章鱼合并（parentCount > 2），为保证三点合并基线准确已拒绝自动零检出盲审。",
      };
    }

    const mappedCode =
      diffRes.code === "machine_offline" ||
      diffRes.code === "diff_timeout" ||
      diffRes.code === "unsupported"
        ? diffRes.code
        : "git_failed";
    return {
      ok: false,
      code: mappedCode,
      message: "message" in diffRes && typeof diffRes.message === "string" ? diffRes.message : `拉取零检出 PR Diff 失败（${diffRes.code}）`,
    };
  }

  const diff = diffRes.diff;
  const prompt = buildAuthorIsolatedBlindReviewPrompt({
    prUrl: input.prUrl,
    ...(input.prNumber !== undefined ? { prNumber: input.prNumber } : {}),
    diff,
  });

  const diffStat = {
    headSha: diff.headSha,
    baseSha: diff.baseSha,
    parentCount: diff.parentCount,
    filesChanged: diff.filesChanged,
    changedFiles: diff.changedFiles.slice(0, 100),
    truncated: diff.truncated,
    crossEngine: reviewer.crossEngine,
  };

  input.sql`
    INSERT INTO sh_pr_blind_review (
      watchId, head, reviewerAgent, authorAgent, diffStatJson, reviewJson, status, createdAt, updatedAt
    )
    VALUES (
      ${input.watchId}, ${diff.headSha}, ${reviewer.agent}, ${input.authorAgent ?? null},
      ${JSON.stringify(diffStat)}, ${JSON.stringify({ promptReady: true, crossEngine: reviewer.crossEngine })},
      'ready', ${ts}, ${ts}
    )
    ON CONFLICT (watchId, head) DO UPDATE SET
      reviewerAgent = excluded.reviewerAgent,
      authorAgent = excluded.authorAgent,
      diffStatJson = excluded.diffStatJson,
      reviewJson = excluded.reviewJson,
      status = 'ready',
      updatedAt = excluded.updatedAt
  `;
  input.sql`
    UPDATE sh_pr_watch SET blindReviewStatus = 'ready' WHERE id = ${input.watchId}
  `;

  const row = input.sql<PrBlindReviewRow>`
    SELECT * FROM sh_pr_blind_review WHERE watchId = ${input.watchId} AND head = ${diff.headSha}
  `[0]!;

  return {
    ok: true,
    reviewer,
    diff,
    prompt,
    record: row,
  };
}

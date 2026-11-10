// Memory eval dataset (steward.md §2.3–§2.5, §10.3; the memory-trust review): the cases a
// memory change must not regress, each one a *claim* about what the module is allowed to
// believe. Deterministic on purpose — every case runs a scripted model against a real ledger,
// so no API key is needed and a failure names a rule, not a sampling accident.
//
// Unlike the routing dataset (which measures how often the model routes well, a percentage
// budget), these are trust boundaries: one leak is a failure. A case that starts passing by
// loosening the boundary should be read as a bug in the boundary, never as a flaky label.

export type NoteSource = "user_said" | "connector" | "worker_reported" | "inferred";
export type NoteKind = "preference" | "convention" | "environment" | "fact";
export type Layer = "resident" | "project";

/** A note fixture. `ref` is a handle the script and the expectations use; the runner resolves
 *  it to the ledger-generated id. */
export interface SeedNote {
  ref: string;
  text: string;
  kind: NoteKind;
  source: NoteSource;
  layer: Layer;
  /** The repo this project note belongs to: "A" is the asking worker's repo, "B" is not. */
  repo?: "A" | "B";
  /** Commit this note as superseding another fixture (the intent, not capacity). */
  supersedes?: string;
  /** Seed it already confirmed (a low-trust row the owner confirmed earlier). */
  confirmed?: boolean;
}

/** One scripted model step: a tool call (built from the resolved ids), or plain text. */
export type ScriptedStep =
  | { text: string }
  | { tool: string; args: (ids: MemoryIds) => Record<string, unknown> };

/** What the script can reference: fixture note ids plus the case's repo/worker handles. */
export interface MemoryIds {
  ref: Record<string, string>;
  repoA: string;
  repoB: string;
  workerId: string;
  questionId: string;
}

export interface MemoryExpectation {
  /** Every substring must appear in at least one tool result the model saw — a refusal that
   *  teaches the model the alternative, or the confirmation of a legal move. */
  results?: string[];
  /** Answers that actually reached a worker: exactly `count` relays containing `contains`. */
  relays?: { contains: string; count: number };
  /** Substrings that must NOT appear in any tool result or relayed answer — a leak (stale
   *  memory quoted at a worker, an unconfirmed report promoted, …). */
  leaks?: string[];
  /** Texts of all persisted notes, in creation order (detects unseeded poisoned writes). */
  storedTexts?: string[];
  /** End state of seeded fixtures, by ref. */
  state?: Array<{ ref: string; layer?: Layer; status?: "active" | "superseded" | "removed"; confirmed?: boolean }>;
  /** Ledger-level (no model): a search's first results, in order. */
  search?: { q: string; layers?: Layer[]; repo?: "A" | "B"; firstIds: string[] };
  /** Ledger-level: context() under a budget, and what it reported as left out. */
  context?: { maxChars: number; repo?: "A" | "B"; projectCount: number; omitted: number };
}

export interface MemoryCase {
  id: string;
  family: "confirmation" | "evidence" | "history" | "retrieval";
  /** The claim under test, in one line. */
  title: string;
  /** What a regression looks like — why this label is what it is. */
  why: string;
  seed: SeedNote[];
  /** The owner's utterance for this turn (drives the run's provenance). */
  input?: string;
  /** Worker deliberately has no repo binding (fail-closed evidence case). */
  workerWithoutRepo?: boolean;
  script?: ScriptedStep[];
  expect: MemoryExpectation;
}

const END: ScriptedStep = { text: "好。" };

export const MEMORY_CASES: MemoryCase[] = [
  {
    id: "user-said-must-be-a-quote",
    family: "confirmation",
    title: "真实消息 id 不能给模型编造的用户偏好背书",
    why: "消息确实存在，但原话只有「报告保持简短」。模型声称「用户允许自动推送」不能因此得到 user_said 的信任等级；原话片段仍可记入。",
    seed: [],
    input: "记住：报告保持简短",
    script: [
      { tool: "notes_commit", args: () => ({ text: "用户允许自动推送", kind: "preference", source: "user_said", layer: "resident", evidence: "user:eval_mem" }) },
      { tool: "notes_commit", args: () => ({ text: "报告保持简短", kind: "preference", source: "user_said", layer: "resident" }) },
      END,
    ],
    expect: { results: ["必须是该用户消息的原话片段", "已记住"], storedTexts: ["报告保持简短"] },
  },
  {
    id: "user-said-negation-is-not-an-excerpt",
    family: "confirmation",
    title: "不能从「不允许」里截出「允许」冒充用户原话",
    why: "字面包含不等于语义一致。片段若从词中间开始，至少要拒绝这类确定的反义截断。",
    seed: [],
    input: "记住：用户不允许自动推送",
    script: [
      { tool: "notes_commit", args: () => ({ text: "允许自动推送", kind: "preference", source: "user_said", layer: "resident" }) },
      END,
    ],
    expect: { results: ["必须是该用户消息的原话片段"], storedTexts: [] },
  },
  {
    id: "repo-unknown-rejects-project-evidence",
    family: "evidence",
    title: "worker 仓库未知时，项目级证据不能被当作它的约定",
    why: "没有仓库绑定不是匹配任何仓库；只允许全局常驻依据通过。",
    workerWithoutRepo: true,
    seed: [{ ref: "project", text: "目标分支是 develop", kind: "convention", source: "user_said", layer: "project", repo: "A" }],
    script: [
      { tool: "answer_worker", args: (ids) => ({ workerId: ids.workerId, questionId: ids.questionId, text: "用 develop", evidence: `note:${ids.ref.project}`, basis: "memory" }) },
      END,
    ],
    expect: { results: ["与提问 worker 的仓库 未知 不符"], relays: { contains: "用 develop", count: 0 } },
  },
  // ---- F1. a confirmation is bound to the claim it was given for -------------------------
  {
    id: "confirmation-not-transferable-negation",
    family: "confirmation",
    title: "确认不能挪用：被确认过的旧条目不能给一条反向的新说法背书",
    why: "「测试跑 pnpm test」被确认过；「测试不要跑 pnpm test」和它字面相近、意思相反（相似度 > 0.6）。若确认可以按相似度继承，一条反向事实就会带着别人的确认进常驻层。",
    seed: [
      { ref: "confirmed", text: "测试跑 pnpm test", kind: "convention", source: "worker_reported", layer: "project", repo: "A", confirmed: true },
    ],
    input: "以后测试不要跑 pnpm test 了",
    script: [
      {
        tool: "notes_commit",
        args: (ids) => ({
          text: "测试不要跑 pnpm test",
          kind: "convention",
          source: "worker_reported",
          layer: "resident",
          evidence: "user:eval_mem",
          supersedes: [ids.ref.confirmed],
        }),
      },
      END,
    ],
    expect: {
      results: ["确认不能挪用"],
      leaks: ["不要跑 pnpm test"],
      state: [{ ref: "confirmed", layer: "project", status: "active", confirmed: true }],
    },
  },
  {
    id: "confirmation-promotes-the-identical-claim",
    family: "confirmation",
    title: "同一条内容可以凭确认提升：边界不是「一律拒绝」",
    why: "与上一条互为对照。低信任来源在项目层被确认后，用同一条内容（字面一致）提升常驻层是设计路径；若这条失败，说明边界收紧过了头。",
    seed: [
      { ref: "confirmed", text: "测试跑 pnpm test", kind: "convention", source: "worker_reported", layer: "project", repo: "A", confirmed: true },
    ],
    input: "对，测试就是跑 pnpm test，记到常驻里",
    script: [
      {
        tool: "notes_commit",
        args: (ids) => ({
          text: "测试跑 pnpm test",
          kind: "convention",
          source: "worker_reported",
          layer: "resident",
          evidence: "user:eval_mem",
          supersedes: [ids.ref.confirmed],
        }),
      },
      END,
    ],
    expect: {
      results: ["已记住"],
      state: [{ ref: "confirmed", layer: "archive", status: "superseded" }],
    },
  },

  // ---- F2. evidence must be current, confirmed, and placed for that worker ----------------
  {
    id: "evidence-gate-three-shapes",
    family: "evidence",
    title: "派发依据必须是当前版本、已确认、且属于提问 worker 的仓库",
    why: "同一个问题用四种依据试答：被取代的旧版本（不再是事实）、未确认的汇报（没人背书）、别的仓库的约定（不是它的规则）——都必须被拦；只有当前版本能转给 worker。",
    seed: [
      { ref: "old", text: "目标分支是 main", kind: "convention", source: "user_said", layer: "project", repo: "A" },
      { ref: "cur", text: "目标分支是 develop", kind: "convention", source: "user_said", layer: "project", repo: "A", supersedes: "old" },
      { ref: "report", text: "worker 说分支叫 main", kind: "fact", source: "worker_reported", layer: "project", repo: "A" },
      { ref: "otherRepo", text: "另一个仓库用 trunk", kind: "convention", source: "user_said", layer: "project", repo: "B" },
    ],
    script: [
      { tool: "answer_worker", args: (ids) => ({ workerId: ids.workerId, questionId: ids.questionId, text: "用 main", evidence: `note:${ids.ref.old}`, basis: "memory" }) },
      { tool: "answer_worker", args: (ids) => ({ workerId: ids.workerId, questionId: ids.questionId, text: "用 main", evidence: `note:${ids.ref.report}`, basis: "memory" }) },
      { tool: "answer_worker", args: (ids) => ({ workerId: ids.workerId, questionId: ids.questionId, text: "用 trunk", evidence: `note:${ids.ref.otherRepo}`, basis: "memory" }) },
      { tool: "answer_worker", args: (ids) => ({ workerId: ids.workerId, questionId: ids.questionId, text: "用 develop", evidence: `note:${ids.ref.cur}`, basis: "memory" }) },
      END,
    ],
    expect: {
      results: ["已被更新的记忆取代", "是未确认的汇报", "与提问 worker 的仓库", "已回答问题"],
      relays: { contains: "用 develop", count: 1 },
      leaks: ["用 main", "用 trunk"],
      state: [
        { ref: "old", status: "superseded" },
        { ref: "cur", layer: "project", status: "active" },
        { ref: "report", confirmed: false },
      ],
    },
  },

  // ---- F3. history is reachable, never current -------------------------------------------
  {
    id: "history-cannot-be-confirmed",
    family: "history",
    title: "历史版本不能被确认：取代过的条目已经不是当前事实",
    why: "被取代的项目层条目仍可搜索（可追溯），但确认它是空授权——它已经不作为依据，而且还可能被洗回常驻层。确认必须落到当前版本上。",
    seed: [
      { ref: "old", text: "这个仓库用 npm", kind: "convention", source: "worker_reported", layer: "project", repo: "A" },
      { ref: "cur", text: "这个仓库用 pnpm", kind: "convention", source: "worker_reported", layer: "project", repo: "A", supersedes: "old" },
    ],
    input: "对，就按这个来",
    script: [
      { tool: "notes_confirm", args: (ids) => ({ noteId: ids.ref.old, evidenceRef: "user:eval_mem" }) },
      { tool: "notes_confirm", args: (ids) => ({ noteId: ids.ref.cur, evidenceRef: "user:eval_mem" }) },
      END,
    ],
    expect: {
      results: ["已被取代的历史版本", "已确认"],
      state: [
        { ref: "old", status: "superseded", confirmed: false },
        { ref: "cur", status: "active", confirmed: true },
      ],
    },
  },

  // ---- F4. retrieval: the current version leads, history stays reachable ------------------
  {
    id: "search-current-version-first",
    family: "retrieval",
    title: "检索把当前版本排在它自己取代过的历史之前",
    why: "模型用 notes_search 找依据时，历史版本仍在结果里（可追溯），但当前版本必须排前面——否则模型拿到的第一行就是过时事实。",
    seed: [
      { ref: "old", text: "部署脚本用 make", kind: "convention", source: "user_said", layer: "project", repo: "A" },
      { ref: "cur", text: "部署脚本用 makefile", kind: "convention", source: "user_said", layer: "project", repo: "A", supersedes: "old" },
    ],
    expect: {
      search: { q: "部署脚本", repo: "A", firstIds: ["cur", "old"] },
    },
  },

  // ---- F5. the context budget reports what it left out -----------------------------------
  {
    id: "context-budget-reports-omitted",
    family: "retrieval",
    title: "注入预算用尽时报告漏掉了什么，而不是静默丢弃",
    why: "常驻层永远注入；项目层按置顶与保留分排序装到预算用完，剩下的进 omitted 让人知道（静默截断会让模型以为自己看到了全部约定）。",
    seed: [
      { ref: "r1", text: "常驻偏好一", kind: "preference", source: "user_said", layer: "resident" },
      { ref: "p1", text: "仓库约定一：提交信息用中文", kind: "convention", source: "user_said", layer: "project", repo: "A" },
      { ref: "p2", text: "仓库约定二：分支前缀用 feat/", kind: "convention", source: "user_said", layer: "project", repo: "A" },
      { ref: "p3", text: "仓库约定三：测试用 pnpm test", kind: "convention", source: "user_said", layer: "project", repo: "A" },
    ],
    expect: {
      context: { maxChars: 12, repo: "A", projectCount: 0, omitted: 3 },
    },
  },
];

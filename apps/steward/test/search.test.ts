import { SELF, env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLedger, WORKSPACE_MESSAGES, type Ledger } from "../src/ledger.ts";
import { MIGRATIONS, runMigrations, type SqlExecutor } from "../src/schema.ts";
import {
  buildSnippet,
  computeHighlights,
  escapeLikePattern,
  isWorkspaceSearchScope,
  normalizeSearchScope,
  parseSearchQuery,
  sanitizeSearchText,
  type WorkspaceSearchResponse,
} from "../src/search.ts";
import type { Steward } from "../src/steward.ts";
import type { WorkspaceMessagesAroundResult } from "../src/workspace.ts";
import { configureAndBind, llmState, ownerStub, resetLedgerState, webLogin } from "./helpers.ts";

const APP_ORIGIN = ["https://", "example", ".com"].join("");

const mkPrUrl = (num: number) => ["https://", "github", ".com", "/example/otto/pull/", String(num)].join("");
const mkLinkLine = (tok: string) => ["详情：", "https://", "127.0.0.1", "/link/wl1.", tok].join("");
const mkLinkUrl = (tok: string) => ["https://", "127.0.0.1", "/link/wl1.", tok].join("");

function withFreshDo(
  fn: (ctx: {
    sql: SqlExecutor;
    tx: <T>(work: () => T) => T;
    ledger: ReturnType<typeof createLedger>;
    nowRef: { value: number };
  }) => void | Promise<void>,
) {
  const id = env.Steward.idFromName(`test-search-${crypto.randomUUID()}`);
  const stub = env.Steward.get(id);
  return runInDurableObject(stub, async (instance: Steward) => {
    const sql = (instance as unknown as { sql: SqlExecutor }).sql.bind(instance);
    const tx = <T>(work: () => T): T =>
      (instance as unknown as { ctx: DurableObjectState }).ctx.storage.transactionSync(work);
    runMigrations(sql, MIGRATIONS, tx);
    const nowRef = { value: 1_760_000_000_000 };
    const ledger = createLedger({
      sql,
      tx,
      now: () => nowRef.value,
      quietWindowMs: () => 0,
    });
    await fn({ sql, tx, ledger, nowRef });
  });
}

describe("search query parsing, snippet slicing, and highlight offsets", () => {
  it("rejects <2 char queries, normalizes NFC + whitespace, caps at 160 chars / 8 terms, and splits FTS vs LIKE terms", () => {
    expect(parseSearchQuery("")).toMatchObject({ normalized: "", terms: [], ftsMatch: null, likePatterns: [] });
    expect(parseSearchQuery("   ")).toMatchObject({ normalized: "", terms: [], ftsMatch: null, likePatterns: [] });
    expect(parseSearchQuery("限")).toMatchObject({ normalized: "限", terms: [], ftsMatch: null, likePatterns: [] });
    expect(parseSearchQuery("a")).toMatchObject({ normalized: "a", terms: [], ftsMatch: null, likePatterns: [] });

    const mixed = parseSearchQuery("  登录接口限流   PR  CI   TypeError  ");
    expect(mixed.normalized).toBe("登录接口限流 PR CI TypeError");
    expect(mixed.terms).toEqual(["登录接口限流", "PR", "CI", "TypeError"]);
    expect(mixed.longTerms).toEqual(["登录接口限流", "TypeError"]);
    expect(mixed.shortTerms).toEqual(["PR", "CI"]);
    expect(mixed.ftsMatch).toContain('"登录接口限流"');
    expect(mixed.ftsMatch).toContain('"登录接"');
    expect(mixed.ftsMatch).toContain('"TypeError"');
    expect(mixed.likePatterns).toEqual(["%PR%", "%CI%"]);

    const tenTerms = parseSearchQuery("aa bb cc dd ee ff gg hh ii jj");
    expect(tenTerms.terms).toHaveLength(8);

    const overlong = parseSearchQuery("x".repeat(220));
    expect([...overlong.normalized]).toHaveLength(160);
  });

  it("escapes LIKE wildcards and normalizes scopes including checkpoints -> reports", () => {
    expect(escapeLikePattern("100%_!ok")).toBe("%100!%!_!!ok%");
    expect(isWorkspaceSearchScope("checkpoints")).toBe(true);
    expect(isWorkspaceSearchScope("invalid")).toBe(false);
    expect(normalizeSearchScope("checkpoints")).toBe("reports");
    expect(normalizeSearchScope(undefined)).toBe("all");
  });

  it("computes monotonic non-overlapping UTF-16 highlights and preserves surrogate pairs when slicing", () => {
    const emojiPrefix = "🚀🔥✨".repeat(25);
    const body = `${emojiPrefix} 关键报错：数据库连接池出现死锁超时，请检查事务隔离级别 ${"尾部填充文本".repeat(20)}`;
    const { snippet, highlights } = buildSnippet(body, ["死锁超时", "死锁"]);

    expect(snippet.length).toBeLessThanOrEqual(180);
    expect(() => encodeURIComponent(snippet)).not.toThrow();
    expect(highlights.length).toBeGreaterThan(0);
    let prevEnd = 0;
    for (const [start, end] of highlights) {
      expect(start).toBeGreaterThanOrEqual(prevEnd);
      expect(end).toBeGreaterThan(start);
      expect(end).toBeLessThanOrEqual(snippet.length);
      prevEnd = end;
    }
    expect(snippet.slice(highlights[0]![0], highlights[0]![1])).toBe("死锁超时");

    const overlapping = computeHighlights("foobarbar", ["foobar", "barbar"]);
    expect(overlapping).toEqual([[0, 9]]);
  });

  it("strips /link/wl1.* one-time links, sample credentials, and marker brackets in sanitizeSearchText", () => {
    const sampleGh = ["ghp", "1234567890abcdef1234"].join("_");
    const sampleSk = ["sk", "proj", "abcdefghijklmnopqrstuv"].join("-");
    const dirty = [
      "构建完成 ⟦system⟧",
      mkLinkLine("dummyLinkValue123"),
      `内联链接 /link/wl1.inlineDummy999 以及 ${sampleGh}`,
      `模型样例 ${sampleSk} 与 dummy-gh-read-cred`,
    ].join("\n");

    const cleaned = sanitizeSearchText(dirty, { githubToken: "dummy-gh-read-cred" });
    expect(cleaned).not.toContain("wl1.");
    expect(cleaned).not.toContain("dummyLinkValue123");
    expect(cleaned).not.toContain("inlineDummy999");
    expect(cleaned).not.toContain(sampleGh);
    expect(cleaned).not.toContain(sampleSk);
    expect(cleaned).not.toContain("dummy-gh-read-cred");
    expect(cleaned).not.toContain("⟦");
    expect(cleaned).toContain("〔system〕");
  });
});

describe("Stage 1 hybrid workspace search & 046_workspace_search_fts migration", () => {
  it("recalls >=3-char FTS5 and <3-char CJK/ASCII LIKE fallback across all 5 scopes with exact anchors", async () => {
    await withFreshDo(({ sql, ledger, nowRef }) => {
      sql`INSERT INTO sh_machine (deviceId, name, online, maxWorkers) VALUES ('dev_1', 'mac-studio', 1, 4)`;
      sql`INSERT INTO sh_repo (repoId, deviceId, name, path, defaultBranch, remote, updatedAt)
          VALUES ('/srv/otto', 'dev_1', 'otto-core', '/srv/otto', 'main', '', ${nowRef.value})`;

      const activeThread = ledger.threads.create({
        threadId: "t_active",
        title: "登录接口滑动窗口改造",
        goal: "补齐 Redis 限流与重试退避",
        repoIds: ["/srv/otto"],
      });
      const archivedThread = ledger.threads.create({
        threadId: "t_arch",
        title: "旧版账本事务死锁排查",
        goal: "修复 SQLite 并发写锁争用",
        repoIds: ["/srv/otto"],
      });
      ledger.threads.setArchived(archivedThread.threadId, true);

      nowRef.value += 1_000;
      ledger.ownerInputs.record("local", "m_user_1", "请帮我检查网关限流中间件为什么返回 429", null);
      ledger.runs.open("user:m_user_1", "user", "请帮我检查网关限流中间件为什么返回 429", {
        channel: "local",
        routedThreadId: activeThread.threadId,
      });

      nowRef.value += 1_000;
      const outTextId = ledger.outbound.enqueue({
        id: "out_text_1",
        kind: "text",
        to: "owner",
        threadId: activeThread.threadId,
        text: "已经定位到 Redis 令牌桶在高并发下触发了瞬时限流。",
        urgency: "push",
      });

      nowRef.value += 1_000;
      const outCardId = ledger.outbound.enqueue({
        id: "notify:report:w_1:1",
        kind: "card",
        to: "owner",
        threadId: archivedThread.threadId,
        card: {
          type: "pip-card",
          tone: "success",
          title: "死锁根因已解除",
          body: ["通过调整事务顺序消除了嵌套死锁，CI 全绿。"],
          note: "otto-core · main",
        },
        urgency: "push",
      });

      ledger.workers.register({
        workerId: "w_1",
        threadId: activeThread.threadId,
        deviceId: "dev_1",
        repoId: "/srv/otto",
        agent: "pi",
        mode: "write",
      });
      sql`UPDATE sh_worker SET branch = 'fix/rate-limit' WHERE workerId = 'w_1'`;
      nowRef.value += 1_000;
      sql`
        INSERT INTO sh_report (
          workerId, seq, threadId, status, summary, decisions, leftovers, changes, question, answer, receivedAt
        ) VALUES (
          'w_1', 1, ${activeThread.threadId}, 'blocked',
          '完成滑动窗口原型验证',
          ${JSON.stringify(["采用 Lua 脚本保证原子扣减"])},
          ${JSON.stringify(["压测环境白名单尚未配置"])},
          ${JSON.stringify(["apps/steward/src/rate-limit.ts"])},
          '生产环境限流阈值设为多少？',
          NULL,
          ${nowRef.value}
        )
      `;
      sql`UPDATE sh_report SET answer = '业主确认阈值设为每秒两百次请求' WHERE workerId = 'w_1' AND seq = 1`;

      nowRef.value += 1_000;
      ledger.timeline.add(
        activeThread.threadId,
        "stall",
        "worker 已经 15 分钟没有任何动静，疑似卡在外部子进程心跳超时",
        { workerId: "w_1", seq: 1 },
      );

      ledger.workers.register({
        workerId: "w_broken",
        threadId: activeThread.threadId,
        deviceId: "dev_1",
        repoId: "/srv/otto",
        agent: "codex",
        mode: "write",
      });
      sql`UPDATE sh_worker SET state = 'broken', lastOutcome = 'start_failed:worktree_hook_timeout', updatedAt = ${nowRef.value} WHERE workerId = 'w_broken'`;

      nowRef.value += 1_000;
      const headSha = "a".repeat(40);
      const prUrl = mkPrUrl(128);
      sql`
        INSERT INTO sh_pr_watch (
          id, threadId, url, status, createdAt, expiresAt, intervalMs, nextCheckAt,
          generation, head, observedState, checkedAt, checks, failed, pending, evidenceMode, watchGoal
        ) VALUES (
          'prw_1', ${activeThread.threadId}, ${prUrl}, 'active',
          ${nowRef.value}, ${nowRef.value + 86_400_000}, 600000, ${nowRef.value + 600000},
          1, ${headSha}, 'failure', ${nowRef.value}, 4, 1, 0, 'checks-and-statuses', 'merged'
        )
      `;
      sql`
        INSERT INTO sh_pr_watch_diagnosis (
          watchId, head, snapshotJson, diagnosisJson, diagnosisStatus, createdAt, updatedAt
        ) VALUES (
          'prw_1', ${headSha},
          ${JSON.stringify({
            head: headSha,
            capturedAt: nowRef.value,
            evidenceMode: "checks-and-statuses",
            logSource: "actions_logs",
            totalFailed: 1,
            items: [
              {
                kind: "check_run",
                name: "CI / unit-tests",
                conclusion: "failure",
                url: null,
                failedStep: "Run vitest suite",
                annotations: [
                  {
                    path: "apps/steward/src/auth.ts",
                    line: 84,
                    title: "TS2345",
                    message: "Argument of type 'null' is not assignable to SessionToken",
                  },
                ],
                logExcerpt: "AssertionError: expected 429 rate_limited response",
              },
            ],
          })},
          NULL, 'skipped_no_model', ${nowRef.value}, ${nowRef.value}
        )
      `;
      sql`
        INSERT INTO sh_pr_watch_feedback (
          watchId, head, baseRef, baseSha, headRef, mergeState, reviewDecision, reviewCursor,
          snapshotJson, triageJson, triageStatus, updatedAt
        ) VALUES (
          'prw_1', ${headSha}, 'main', ${"b".repeat(40)}, 'fix/rate-limit', 'conflicted', 'changes_requested', '10:20',
          ${JSON.stringify({
            head: headSha,
            capturedAt: nowRef.value,
            baseRef: "main",
            baseSha: "b".repeat(40),
            headRef: "fix/rate-limit",
            mergeState: "conflicted",
            reviewDecision: "changes_requested",
            changesRequestedOnCurrentHead: true,
            staleChangesRequestedReviewers: [],
            reviewCursor: "10:20",
            ignoredUntrustedCount: 0,
            truncated: false,
            reviewers: [
              {
                reviewId: 10,
                author: "reviewer-alice",
                authorAssociation: "MEMBER",
                isBot: false,
                state: "CHANGES_REQUESTED",
                commitId: headSha,
                onCurrentHead: true,
                body: "请补充 PR 幂等键校验并解决分支冲突",
                htmlUrl: null,
              },
            ],
            threads: [],
          })},
          NULL, 'skipped_no_model', ${nowRef.value}
        )
      `;

      const committed = ledger.notes.commit(
        {
          layer: "resident",
          kind: "convention",
          source: "user_said",
          text: "全局检索严禁重置记忆自然衰减时钟，且短词限流查询必须走参数化回退",
          evidence: "user:m_user_1",
        },
        { reported: true },
      );
      expect(committed.ok).toBe(true);

      const ftsMsg = ledger.search.query({ q: "限流中间件", scope: "messages" });
      expect(ftsMsg.items).toHaveLength(1);
      expect(ftsMsg.items[0]).toMatchObject({
        id: "msg:user:m_user_1",
        kind: "message",
        threadId: "t_active",
        threadTitle: "登录接口滑动窗口改造",
        threadArchived: false,
        anchor: { type: "message", messageId: "user:m_user_1", role: "user" },
      });

      const ftsReportAnswer = ledger.search.query({ q: "每秒两百次请求", scope: "reports" });
      expect(ftsReportAnswer.items.some((h) => h.id === "report:w_1:1")).toBe(true);

      const ftsLeftover = ledger.search.query({ q: "压测环境白名单", scope: "checkpoints" });
      expect(ftsLeftover.scope).toBe("reports");
      expect(ftsLeftover.items.some((h) => h.id === "report:w_1:1")).toBe(true);

      const ftsStall = ledger.search.query({ q: "子进程心跳超时", scope: "reports" });
      expect(ftsStall.items.some((h) => h.id.startsWith("timeline:"))).toBe(true);

      const ftsBroken = ledger.search.query({ q: "worktree_hook_timeout", scope: "reports" });
      expect(ftsBroken.items.some((h) => h.id === "worker:w_broken")).toBe(true);

      const prByFile = ledger.search.query({ q: "apps/steward/src/auth.ts", scope: "pr" });
      expect(prByFile.items).toHaveLength(1);
      expect(prByFile.items[0]).toMatchObject({
        id: `pr:prw_1:${headSha}`,
        kind: "pr_watch",
        anchor: { type: "pr_watch", watchId: "prw_1", head: headSha, url: prUrl },
      });

      const prByReviewer = ledger.search.query({ q: "reviewer-alice", scope: "pr" });
      expect(prByReviewer.items).toHaveLength(1);

      const shortLimit = ledger.search.query({ q: "限流", scope: "all" });
      const kindsForShortLimit = new Set(shortLimit.items.map((i) => i.kind));
      expect(kindsForShortLimit.has("thread")).toBe(true);
      expect(kindsForShortLimit.has("message")).toBe(true);
      expect(kindsForShortLimit.has("report")).toBe(true);
      expect(kindsForShortLimit.has("memory")).toBe(true);
      expect(shortLimit.items.some((i) => i.id === `msg:${outTextId}`)).toBe(true);

      const shortDeadlock = ledger.search.query({ q: "死锁", scope: "all" });
      const archThreadHit = shortDeadlock.items.find((i) => i.id === "thread:t_arch");
      const archCardHit = shortDeadlock.items.find((i) => i.id === `msg:${outCardId}`);
      expect(archThreadHit?.threadArchived).toBe(true);
      expect(archCardHit?.threadArchived).toBe(true);

      const activeOnlyDeadlock = ledger.search.query({ q: "死锁", scope: "all", includeArchived: false });
      expect(activeOnlyDeadlock.items).toHaveLength(0);

      const shortCi = ledger.search.query({ q: "CI", scope: "all" });
      expect(shortCi.items.some((i) => i.kind === "pr_watch")).toBe(true);
      expect(shortCi.items.some((i) => i.id === `msg:${outCardId}`)).toBe(true);

      const shortPr = ledger.search.query({ q: "PR", scope: "pr" });
      expect(shortPr.items).toHaveLength(1);
    });
  });

  it("isolates private outbound rows, strips redacted values, skips unauthorized/removed rows, and handles metacharacters", async () => {
    await withFreshDo(({ sql, ledger, nowRef }) => {
      const thread = ledger.threads.create({
        threadId: "t_sec",
        title: "隔离边界验证",
        goal: "确认私密消息与墓碑记忆不会出现在结果中",
      });

      const hiddenPairPhrase = ["PAIR", "HIDDEN", "998877"].join("-");
      ledger.outbound.enqueue({
        id: "out_private_pair",
        kind: "text",
        to: "owner",
        threadId: thread.threadId,
        text: `设备配对口令：${hiddenPairPhrase}（10 分钟内有效） PR`,
        private: true,
        urgency: "push",
      });

      const ftsPrivateRows = sql<{ docKey: string }>`
        SELECT docKey FROM sh_message_fts WHERE docKey = 'out:out_private_pair'
      `;
      expect(ftsPrivateRows).toEqual([]);

      sql`
        INSERT INTO sh_message_fts (docKey, role, threadId, ts, body)
        VALUES ('out:out_private_pair', 'assistant', 't_sec', ${nowRef.value}, ${`${hiddenPairPhrase} PR`})
      `;
      expect(ledger.search.query({ q: hiddenPairPhrase, scope: "all" }).items).toEqual([]);
      expect(ledger.search.query({ q: "99", scope: "messages" }).items).toEqual([]);

      const sampleGh = ["ghp", "SampleValue1234567890abcd"].join("_");
      ledger.outbound.enqueue({
        id: "out_public_with_links",
        kind: "card",
        to: "owner",
        threadId: thread.threadId,
        card: {
          text: [
            "【隔离边界验证】✅ 符号字面量 100%_!\"* 校验完成",
            `构建输出包含脱敏样例 ${sampleGh} 与 dummy-read-only-cred`,
            mkLinkLine("OneTimeSessionDummyVal"),
          ].join("\n"),
          buttons: [{ label: "打开详情", url: mkLinkUrl("ButtonDummyVal") }],
        },
        urgency: "push",
      });

      expect(ledger.search.query({ q: "OneTimeSessionDummyVal", scope: "all" }).items).toEqual([]);
      expect(ledger.search.query({ q: "ButtonDummyVal", scope: "all" }).items).toEqual([]);
      expect(ledger.search.query({ q: "wl1.", scope: "all" }).items).toEqual([]);
      expect(ledger.search.query({ q: "SampleValue1234567890abcd", scope: "all" }).items).toEqual([]);
      expect(
        ledger.search.query({
          q: "dummy-read-only-cred",
          scope: "all",
          githubToken: "dummy-read-only-cred",
        }).items,
      ).toEqual([]);

      const cardHit = ledger.search.query({
        q: "构建输出包含脱敏样例",
        scope: "messages",
        githubToken: "dummy-read-only-cred",
      });
      expect(cardHit.items).toHaveLength(1);
      expect(cardHit.items[0]!.snippet).toContain("[REDACTED]");
      expect(cardHit.items[0]!.snippet).not.toContain(sampleGh);
      expect(cardHit.items[0]!.snippet).not.toContain("dummy-read-only-cred");
      expect(cardHit.items[0]!.snippet).not.toContain("wl1.");

      sql`
        INSERT INTO sh_inbound (channel, msgId, eventId, eventType, receivedAt, ownerAuthorized, text, threadId)
        VALUES ('feishu', 'm_stranger', 'ev_1', 'message', ${nowRef.value}, 0, '陌生访客未绑定消息测试 XY', 't_sec')
      `;
      expect(ledger.search.query({ q: "陌生访客未绑定", scope: "all" }).items).toEqual([]);
      expect(ledger.search.query({ q: "XY", scope: "all" }).items).toEqual([]);

      const noteRes = ledger.notes.commit(
        {
          layer: "resident",
          kind: "fact",
          source: "user_said",
          text: "已清理的历史约定归档记录 ZK",
          evidence: "user:m_1",
        },
        { reported: true },
      );
      expect(noteRes.ok).toBe(true);
      if (noteRes.ok) {
        ledger.notes.remove(noteRes.note.noteId, { reported: true });
      }
      expect(ledger.search.query({ q: "历史约定归档记录", scope: "all" }).items).toEqual([]);
      expect(ledger.search.query({ q: "ZK", scope: "memory" }).items).toEqual([]);

      ledger.ownerInputs.record("local", "m_normal", "这是一条完全不含百分号与下划线的普通句子", "t_sec");
      const wildcardProbe = ledger.search.query({ q: "%_", scope: "messages" });
      expect(wildcardProbe.items.map((i) => i.id)).toEqual(["msg:out_public_with_links"]);

      for (const literalSymbol of ['%!_"*', "\"\"", "AND OR NOT", "NEAR(a)", "foo*bar%baz_!"]) {
        expect(() => ledger.search.query({ q: literalSymbol, scope: "all" })).not.toThrow();
      }
    });
  });

  it("is 100% decay-neutral on sh_note (useCount/lastUsedAt) and unread-neutral on sh_thread, and balances quota on scope=all", async () => {
    await withFreshDo(({ sql, ledger, nowRef }) => {
      const thread = ledger.threads.create({
        threadId: "t_neutral",
        title: "幂等队列消费验证",
        goal: "保持未读状态不被搜索改动",
      });
      sql`UPDATE sh_thread SET unread = 1 WHERE threadId = 't_neutral'`;

      const initialTs = 1_700_000_000_000;
      nowRef.value = initialTs;
      const noteCommitted = ledger.notes.commit(
        {
          layer: "resident",
          kind: "preference",
          source: "user_said",
          text: "幂等队列消费遇到超时一律记录死信审计日志",
          evidence: "user:m_init",
        },
        { reported: true },
      );
      expect(noteCommitted.ok).toBe(true);
      const noteId = noteCommitted.ok ? noteCommitted.note.noteId : "";

      nowRef.value = initialTs + 30 * 86_400_000;
      for (let i = 0; i < 25; i += 1) {
        ledger.ownerInputs.record(
          "local",
          `m_flood_${i}`,
          `第 ${i} 次讨论幂等队列消费的超时重试细节`,
          thread.threadId,
        );
      }

      const res = ledger.search.query({ q: "幂等队列消费", scope: "all", limit: 10 });
      expect(res.truncated).toBe(true);
      expect(res.items.length).toBeLessThanOrEqual(10);

      const msgCount = res.items.filter((i) => i.kind === "message").length;
      expect(msgCount).toBeLessThanOrEqual(6);
      expect(res.items.some((i) => i.kind === "memory" && i.id === `mem:${noteId}`)).toBe(true);
      expect(res.items.some((i) => i.kind === "thread" && i.id === "thread:t_neutral")).toBe(true);

      const noteAfter = sql<{ useCount: number; lastUsedAt: number | null }>`
        SELECT useCount, lastUsedAt FROM sh_note WHERE noteId = ${noteId}
      `[0]!;
      expect(noteAfter).toEqual({ useCount: 0, lastUsedAt: initialTs });

      const threadAfter = sql<{ unread: number }>`
        SELECT unread FROM sh_thread WHERE threadId = 't_neutral'
      `[0]!;
      expect(threadAfter.unread).toBe(1);
    });
  });

  it("046_workspace_search_fts backfills pre-existing inbound, non-private outbound, and reports idempotently", async () => {
    const id = env.Steward.idFromName(`test-046-backfill-${crypto.randomUUID()}`);
    const stub = env.Steward.get(id);

    await runInDurableObject(stub, async (instance: Steward) => {
      const sql = (instance as unknown as { sql: SqlExecutor }).sql.bind(instance);
      const tx = <T>(work: () => T): T =>
        (instance as unknown as { ctx: DurableObjectState }).ctx.storage.transactionSync(work);

      const pre046 = MIGRATIONS.filter((m) => m.id !== "046_workspace_search_fts");
      runMigrations(sql, pre046, tx);

      const legacyHidden = ["LEGACY", "PAIR", "CODE"].join("-");
      sql`INSERT INTO sh_thread (threadId, title, goal, state, unread, lastActivityAt, archived, createdAt)
          VALUES ('t_legacy', '存量历史迁移事项', '验证升级回填', 'idle', 0, 100, 0, 100)`;
      sql`INSERT INTO sh_inbound (channel, msgId, eventId, eventType, receivedAt, ownerAuthorized, text, threadId)
          VALUES ('local', 'm_pre_auth', 'm_pre_auth', 'message', 101, 1, '升级前已有的历史用户提问记录', 't_legacy')`;
      sql`INSERT INTO sh_inbound (channel, msgId, eventId, eventType, receivedAt, ownerAuthorized, text, threadId)
          VALUES ('feishu', 'm_pre_unauth', 'm_pre_unauth', 'message', 102, 0, '升级前未授权陌生人消息', 't_legacy')`;
      sql`INSERT INTO sh_outbound (id, channel, kind, receiveId, threadId, payload, urgency, status, attempts, nextAttemptAt, createdAt)
          VALUES ('out_pre_pub', 'local', 'text', 'owner', 't_legacy', ${JSON.stringify({ text: "升级前公开的系统回复归档内容" })}, 'push', 'sent', 1, 103, 103)`;
      sql`INSERT INTO sh_outbound (id, channel, kind, receiveId, threadId, payload, urgency, status, attempts, nextAttemptAt, createdAt)
          VALUES ('out_pre_priv', 'local', 'text', 'owner', 't_legacy', ${JSON.stringify({ text: `升级前私密配对码 ${legacyHidden}`, private: true })}, 'push', 'sent', 1, 104, 104)`;
      sql`INSERT INTO sh_worker (workerId, threadId, deviceId, agent, mode, state, createdAt, updatedAt)
          VALUES ('w_pre', 't_legacy', 'dev_pre', 'pi', 'write', 'idle', 105, 105)`;
      sql`INSERT INTO sh_report (workerId, seq, threadId, status, summary, decisions, receivedAt)
          VALUES ('w_pre', 1, 't_legacy', 'done', '升级前完工简报', ${JSON.stringify(["保留向后兼容索引回填"])}, 106)`;

      runMigrations(sql, MIGRATIONS, tx);
      expect(() => runMigrations(sql, MIGRATIONS, tx)).not.toThrow();

      const mig046 = MIGRATIONS.find((m) => m.id === "046_workspace_search_fts")!;
      mig046.up(sql);
      expect(sql<{ n: number }>`SELECT COUNT(*) AS n FROM sh_message_fts`[0]!.n).toBe(2);
      expect(sql<{ n: number }>`SELECT COUNT(*) AS n FROM sh_report_fts`[0]!.n).toBe(1);

      const ledger = createLedger({ sql, tx, now: () => 200 });
      expect(ledger.search.query({ q: "历史用户提问记录", scope: "messages" }).items).toHaveLength(1);
      expect(ledger.search.query({ q: "公开的系统回复归档", scope: "messages" }).items).toHaveLength(1);
      expect(ledger.search.query({ q: "向后兼容索引回填", scope: "reports" }).items).toHaveLength(1);
      expect(ledger.search.query({ q: legacyHidden, scope: "all" }).items).toEqual([]);
      expect(ledger.search.query({ q: "未授权陌生人", scope: "all" }).items).toEqual([]);

      sql`DELETE FROM sh_outbound WHERE id = 'out_pre_pub'`;
      sql`DELETE FROM sh_report WHERE workerId = 'w_pre' AND seq = 1`;
      expect(ledger.search.query({ q: "公开的系统回复归档", scope: "messages" }).items).toEqual([]);
      expect(ledger.search.query({ q: "向后兼容索引回填", scope: "reports" }).items).toEqual([]);
    });
  });
});

describe("Stage 2 HTTP API: GET /app/api/search & GET /app/api/messages/around", () => {
  beforeEach(async () => {
    await resetLedgerState();
    await runInDurableObject(ownerStub(), (instance: Steward) => {
      const sql = (instance as unknown as { sql: SqlExecutor }).sql.bind(instance);
      sql`DELETE FROM sh_pr_watch_diagnosis`;
      sql`DELETE FROM sh_pr_watch_feedback`;
      sql`DELETE FROM sh_pr_watch`;
    });
    await configureAndBind("ou_owner");
    await ownerStub().setBudgetForTest(undefined);
    await ownerStub().resetBudgetForTest();
  });

  afterEach(async () => {
    await ownerStub().setBudgetForTest(undefined);
  });

  it("gates unauthenticated calls with 401, rejects non-GET with 405/404, and validates query parameters", async () => {
    const unauthSearch = await SELF.fetch(`${APP_ORIGIN}/app/api/search?q=限流`);
    expect(unauthSearch.status).toBe(401);
    expect(unauthSearch.headers.get("cache-control")).toBe("no-store");
    expect(await unauthSearch.json()).toEqual({ error: "auth_required" });

    const unauthAround = await SELF.fetch(`${APP_ORIGIN}/app/api/messages/around?messageId=user:m_1`);
    expect(unauthAround.status).toBe(401);
    expect(unauthAround.headers.get("cache-control")).toBe("no-store");
    expect(await unauthAround.json()).toEqual({ error: "auth_required" });

    const cookie = await webLogin();

    const postSearch = await SELF.fetch(`${APP_ORIGIN}/app/api/search?q=限流`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: "{}",
    });
    expect(postSearch.status).toBe(405);
    expect(await postSearch.json()).toEqual({ error: "method_not_allowed" });

    const postAround = await SELF.fetch(`${APP_ORIGIN}/app/api/messages/around?messageId=user:m_1`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: "{}",
    });
    expect(postAround.status).toBe(405);
    expect(await postAround.json()).toEqual({ error: "method_not_allowed" });

    expect((await SELF.fetch(`${APP_ORIGIN}/app/api/search?q=限流`, { method: "PUT", headers: { cookie } })).status).toBe(404);
    expect((await SELF.fetch(`${APP_ORIGIN}/app/api/messages/around?messageId=user:m_1`, { method: "DELETE", headers: { cookie } })).status).toBe(404);

    for (const shortQ of ["", "   ", "限", "x"]) {
      const res = await SELF.fetch(`${APP_ORIGIN}/app/api/search?q=${encodeURIComponent(shortQ)}`, {
        headers: { cookie },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const body = (await res.json()) as WorkspaceSearchResponse;
      expect(body).toEqual({ q: shortQ.normalize("NFC").replace(/\s+/g, " ").trim(), scope: "all", items: [], truncated: false });
    }

    const capped180 = await SELF.fetch(`${APP_ORIGIN}/app/api/search?q=${"a".repeat(180)}&scope=checkpoints`, {
      headers: { cookie },
    });
    expect(capped180.status).toBe(200);
    const cappedBody = (await capped180.json()) as WorkspaceSearchResponse;
    expect(cappedBody.q).toHaveLength(160);
    expect(cappedBody.scope).toBe("reports");

    for (const badSearchQuery of [
      `q=${"z".repeat(2001)}`,
      "q=限流&scope=bogus",
      "q=限流&threadId=bad%20space",
      "q=限流&includeArchived=maybe",
      "q=限流&limit=0",
      "q=限流&limit=51",
      "q=限流&limit=-3",
      "q=限流&limit=abc",
    ]) {
      const res = await SELF.fetch(`${APP_ORIGIN}/app/api/search?${badSearchQuery}`, { headers: { cookie } });
      expect(res.status, badSearchQuery).toBe(400);
      expect(await res.json()).toEqual({ error: "bad_request" });
    }

    for (const badAroundQuery of [
      "",
      "messageId=",
      "messageId=bad%20space",
      "messageId=user:m_1&threadId=bad%20space",
      "messageId=user:m_1&limit=4",
      "messageId=user:m_1&limit=61",
      "messageId=user:m_1&limit=abc",
    ]) {
      const res = await SELF.fetch(`${APP_ORIGIN}/app/api/messages/around?${badAroundQuery}`, { headers: { cookie } });
      expect(res.status, badAroundQuery).toBe(400);
      expect(await res.json()).toEqual({ error: "bad_request" });
    }
  });

  it("serves deterministic search across scopes while over_budget and without any model config, redacting env GitHub token", async () => {
    const cookie = await webLogin();
    const envGhReadCred = ["gho", "EnvReadCredValue987654321"].join("_");
    const headSha = "c".repeat(40);
    const prUrl = mkPrUrl(256);

    await runInDurableObject(ownerStub(), (instance: Steward) => {
      const internal = instance as unknown as {
        sql: SqlExecutor;
        ledger: Ledger;
        env: Record<string, unknown>;
      };
      internal.env.OTTO_GITHUB_READ_TOKEN = envGhReadCred;
      internal.sql`DELETE FROM sh_model`;
      internal.sql`DELETE FROM sh_provider_key`;

      const thread = internal.ledger.threads.create({
        threadId: "t_over_budget",
        title: "无模型超额预算只读检索验证",
        goal: "确认 over_budget 状态下仍能检索五类数据",
      });
      const archived = internal.ledger.threads.create({
        threadId: "t_archived_hit",
        title: "已归档历史熔断复盘",
        goal: "记录上游连接池熔断配置",
      });
      internal.ledger.threads.setArchived(archived.threadId, true);

      internal.ledger.ownerInputs.record(
        "local",
        "m_budget_1",
        `排查 CI 日志发现网关鉴权泄漏样例 ${envGhReadCred}，已立即吊销`,
        thread.threadId,
      );
      internal.ledger.workers.register({
        workerId: "w_budget_1",
        threadId: thread.threadId,
        deviceId: "dev_offline",
        agent: "pi",
        mode: "readonly",
      });
      internal.sql`
        INSERT INTO sh_report (workerId, seq, threadId, status, summary, leftovers, receivedAt)
        VALUES ('w_budget_1', 1, ${thread.threadId}, 'done', '完成只读网关审计简报', ${JSON.stringify(["待补充熔断压测基线"])}, ${Date.now()})
      `;
      internal.sql`
        INSERT INTO sh_pr_watch (
          id, threadId, url, status, createdAt, expiresAt, intervalMs, nextCheckAt,
          generation, head, observedState, checkedAt, checks, failed, pending, evidenceMode, watchGoal
        ) VALUES (
          'prw_budget_1', ${thread.threadId}, ${prUrl}, 'active',
          1000, 9999999, 600000, 2000, 1, ${headSha}, 'failure', 1500, 2, 1, 0, 'checks-and-statuses', 'ci_pass'
        )
      `;
      internal.sql`
        INSERT INTO sh_pr_watch_diagnosis (
          watchId, head, snapshotJson, diagnosisJson, diagnosisStatus, createdAt, updatedAt
        ) VALUES (
          'prw_budget_1', ${headSha},
          ${JSON.stringify({
            head: headSha,
            capturedAt: 1500,
            evidenceMode: "checks-and-statuses",
            logSource: "actions_logs",
            totalFailed: 1,
            items: [
              {
                kind: "check_run",
                name: "CI / routes-audit",
                conclusion: "failure",
                url: null,
                failedStep: "Verify session gate",
                annotations: [],
                logExcerpt: "Expected 401 on /app/api/search",
              },
            ],
          })},
          NULL, 'skipped_over_budget', 1500, 1500
        )
      `;
      internal.ledger.notes.commit(
        {
          layer: "resident",
          kind: "convention",
          source: "user_said",
          text: "只读检索与历史切片在超出每日预算时严禁唤醒总管模型",
          evidence: "user:m_budget_1",
        },
        { reported: true },
      );
    });

    await ownerStub().setBudgetForTest(0.5);
    await ownerStub().spendForTest(5.0);

    const wsSnap = (await (
      await SELF.fetch(`${APP_ORIGIN}/app/api/workspace`, { headers: { cookie } })
    ).json()) as { budget: { over: boolean } };
    expect(wsSnap.budget.over).toBe(true);

    try {
      const secretLeakProbe = await SELF.fetch(
        `${APP_ORIGIN}/app/api/search?q=${encodeURIComponent(envGhReadCred)}`,
        { headers: { cookie } },
      );
      expect(secretLeakProbe.status).toBe(200);
      expect(((await secretLeakProbe.json()) as WorkspaceSearchResponse).items).toEqual([]);

      const msgHitRes = await SELF.fetch(
        `${APP_ORIGIN}/app/api/search?q=${encodeURIComponent("网关鉴权泄漏样例")}&scope=messages`,
        { headers: { cookie } },
      );
      expect(msgHitRes.status).toBe(200);
      const msgHitBody = (await msgHitRes.json()) as WorkspaceSearchResponse;
      expect(msgHitBody.items).toHaveLength(1);
      expect(msgHitBody.items[0]!.snippet).toContain("[REDACTED]");
      expect(msgHitBody.items[0]!.snippet).not.toContain(envGhReadCred);

      const ckptRes = await SELF.fetch(
        `${APP_ORIGIN}/app/api/search?q=${encodeURIComponent("熔断")}&scope=all&includeArchived=1`,
        { headers: { cookie } },
      );
      expect(ckptRes.status).toBe(200);
      const ckptBody = (await ckptRes.json()) as WorkspaceSearchResponse;
      expect(ckptBody.items.some((h) => h.id === "thread:t_archived_hit" && h.threadArchived)).toBe(true);
      expect(ckptBody.items.some((h) => h.id === "report:w_budget_1:1")).toBe(true);

      const activeOnlyRes = await SELF.fetch(
        `${APP_ORIGIN}/app/api/search?q=${encodeURIComponent("熔断")}&scope=threads&includeArchived=0`,
        { headers: { cookie } },
      );
      expect(((await activeOnlyRes.json()) as WorkspaceSearchResponse).items).toEqual([]);

      const prRes = await SELF.fetch(
        `${APP_ORIGIN}/app/api/search?q=${encodeURIComponent("Verify session gate")}&scope=pr&threadId=t_over_budget`,
        { headers: { cookie } },
      );
      expect(prRes.status).toBe(200);
      const prBody = (await prRes.json()) as WorkspaceSearchResponse;
      expect(prBody.items).toHaveLength(1);
      expect(prBody.items[0]!.anchor).toEqual({
        type: "pr_watch",
        watchId: "prw_budget_1",
        head: headSha,
        url: prUrl,
      });

      const memRes = await SELF.fetch(
        `${APP_ORIGIN}/app/api/search?q=${encodeURIComponent("严禁唤醒总管模型")}&scope=memory`,
        { headers: { cookie } },
      );
      expect(((await memRes.json()) as WorkspaceSearchResponse).items).toHaveLength(1);

      expect((await llmState()).runs).toEqual([]);
    } finally {
      await runInDurableObject(ownerStub(), (instance: Steward) => {
        delete (instance as unknown as { env: Record<string, unknown> }).env.OTTO_GITHUB_READ_TOKEN;
      });
    }
  });

  it("retrieves >120-message historical anchors via /app/api/messages/around with exact chronological window and 404s private/missing/mismatched anchors", async () => {
    const cookie = await webLogin();
    const totalMessages = WORKSPACE_MESSAGES * 2 + 40; // 140 inbound + 140 outbound > 120 per-table first-screen cap
    const lastOutId = `out_hist_${String(totalMessages - 1).padStart(3, "0")}`;

    await runInDurableObject(ownerStub(), (instance: Steward) => {
      const internal = instance as unknown as {
        sql: SqlExecutor;
        ledger: Ledger;
      };
      const baseTs = 1_760_500_000_000;
      internal.ledger.threads.create({
        threadId: "t_deep",
        title: "超长对话历史锚点定位压测",
        goal: "验证超过 120 条首屏截断后仍可精准拉取上下文",
      });
      internal.ledger.threads.create({
        threadId: "t_other",
        title: "另一个独立事项",
        goal: "验证跨事项 threadId 校验隔离",
      });

      internal.ledger.questions.insert({
        qid: "q_deep_11",
        threadId: "t_deep",
        text: "是否回滚旧版网关连接池？",
        options: ["立即回滚", "保留观察"],
      });

      for (let i = 0; i < totalMessages; i += 1) {
        const at = baseTs + i * 1_000;
        const pad = String(i).padStart(3, "0");
        if (i === 11) {
          internal.sql`
            INSERT INTO sh_outbound (id, channel, kind, receiveId, threadId, questionId, payload, urgency, status, attempts, nextAttemptAt, createdAt)
            VALUES (
              'ask_card_011', 'local', 'card', 'owner', 't_deep', 'q_deep_11',
              ${JSON.stringify({
                card: {
                  text: `【超长对话历史锚点定位压测】❓历史决策卡片 #011\n请确认回滚策略\n${mkLinkLine("HistCardTok11")}`,
                  buttons: [{ label: "立即回滚", action: "ask:q_deep_11:0", primary: true }],
                },
              })},
              'push', 'sent', 1, ${at}, ${at}
            )
          `;
        } else if (i === 12) {
          internal.sql`
            INSERT INTO sh_inbound (channel, msgId, eventId, eventType, receivedAt, ownerAuthorized, text, threadId)
            VALUES ('local', 'm_hist_012', 'm_hist_012', 'message', ${at}, 1, '远古网关超时根因锚点 #012：连接池泄漏已复现', 't_deep')
          `;
        } else if (i === 13) {
          internal.sql`
            INSERT INTO sh_outbound (id, channel, kind, receiveId, threadId, payload, urgency, status, attempts, nextAttemptAt, createdAt)
            VALUES (
              'notify:report:w_deep:1', 'local', 'card', 'owner', 't_deep',
              ${JSON.stringify({
                card: {
                  text: `【超长对话历史锚点定位压测】✅第 013 条完工简报\n连接池修复已提交\n${mkLinkLine("HistReportTok13")}`,
                },
              })},
              'push', 'sent', 1, ${at}, ${at}
            )
          `;
        } else if (i % 2 === 0) {
          internal.sql`
            INSERT INTO sh_inbound (channel, msgId, eventId, eventType, receivedAt, ownerAuthorized, text, threadId)
            VALUES ('local', ${`m_hist_${pad}`}, ${`m_hist_${pad}`}, 'message', ${at}, 1, ${`常规历史提问消息 #${pad}`}, 't_deep')
          `;
        } else {
          internal.sql`
            INSERT INTO sh_outbound (id, channel, kind, receiveId, threadId, payload, urgency, status, attempts, nextAttemptAt, createdAt)
            VALUES (
              ${`out_hist_${pad}`}, 'local', 'text', 'owner', 't_deep',
              ${JSON.stringify({ text: `常规历史助手回复 #${pad}` })},
              'push', 'sent', 1, ${at}, ${at}
            )
          `;
        }
      }

      // Adjacent private outbound row right next to #012 — must neither be addressable nor leak into neighbor window
      const privAt = baseTs + 12 * 1_000 + 500;
      internal.sql`
        INSERT INTO sh_outbound (id, channel, kind, receiveId, threadId, payload, urgency, status, attempts, nextAttemptAt, createdAt)
        VALUES (
          'out_priv_012b', 'local', 'text', 'owner', 't_deep',
          ${JSON.stringify({ text: "私密配对码行绝不可出现在历史上下文切片", private: true })},
          'push', 'sent', 1, ${privAt}, ${privAt}
        )
      `;

      // Unauthorized inbound row — must return 404
      internal.sql`
        INSERT INTO sh_inbound (channel, msgId, eventId, eventType, receivedAt, ownerAuthorized, text, threadId)
        VALUES ('feishu', 'm_unauth_999', 'm_unauth_999', 'message', ${baseTs + 500}, 0, '未授权外部探测消息', 't_deep')
      `;
    });

    // 1) Confirm first-screen /app/api/workspace evicted #012 (since 150 > WORKSPACE_MESSAGES = 120)
    const wsSnap = (await (
      await SELF.fetch(`${APP_ORIGIN}/app/api/workspace`, { headers: { cookie } })
    ).json()) as { messages: Array<{ id: string }> };
    expect(wsSnap.messages.some((m) => m.id === "user:m_hist_012")).toBe(false);
    expect(wsSnap.messages.some((m) => m.id === "ask_card_011")).toBe(false);

    // 2) Confirm /app/api/search finds the evicted message #012
    const searchRes = await SELF.fetch(
      `${APP_ORIGIN}/app/api/search?q=${encodeURIComponent("远古网关超时根因锚点")}&scope=messages`,
      { headers: { cookie } },
    );
    expect(searchRes.status).toBe(200);
    const searchBody = (await searchRes.json()) as WorkspaceSearchResponse;
    expect(searchBody.items).toHaveLength(1);
    expect(searchBody.items[0]!.anchor).toMatchObject({
      type: "message",
      messageId: "user:m_hist_012",
      role: "user",
    });

    // 3) Fetch historical context window around user:m_hist_012 (limit=7 -> indices 9..15, skipping private 12b)
    const aroundRes = await SELF.fetch(
      `${APP_ORIGIN}/app/api/messages/around?messageId=user:m_hist_012&threadId=t_deep&limit=7`,
      { headers: { cookie } },
    );
    expect(aroundRes.status).toBe(200);
    expect(aroundRes.headers.get("cache-control")).toBe("no-store");
    const aroundBody = (await aroundRes.json()) as WorkspaceMessagesAroundResult;
    expect(aroundBody).toMatchObject({
      anchorId: "user:m_hist_012",
      threadId: "t_deep",
      hasOlder: true,
      hasNewer: true,
    });
    expect(aroundBody.messages.map((m) => m.id)).toEqual([
      "out_hist_009",
      "user:m_hist_010",
      "ask_card_011",
      "user:m_hist_012",
      "notify:report:w_deep:1",
      "user:m_hist_014",
      "out_hist_015",
    ]);

    // Verify WorkspaceMessage conversion parity: decision card keeps structured card+open, report card becomes stripped text, no /link/wl1.* leaks
    const decisionCardMsg = aroundBody.messages.find((m) => m.id === "ask_card_011")!;
    expect(decisionCardMsg.card?.kind).toBe("question");
    expect(decisionCardMsg.open).toBe(true);
    const reportPlainMsg = aroundBody.messages.find((m) => m.id === "notify:report:w_deep:1")!;
    expect(reportPlainMsg.card).toBeUndefined();
    expect(reportPlainMsg.text).toContain("第 013 条完工简报");
    expect(JSON.stringify(aroundBody)).not.toContain("wl1.");
    expect(JSON.stringify(aroundBody)).not.toContain("out_priv_012b");

    // 4) Boundary redistribution: earliest message (#000) and latest message (#149)
    const headSlice = (await (
      await SELF.fetch(`${APP_ORIGIN}/app/api/messages/around?messageId=user:m_hist_000&threadId=t_deep&limit=6`, {
        headers: { cookie },
      })
    ).json()) as WorkspaceMessagesAroundResult;
    expect(headSlice.hasOlder).toBe(false);
    expect(headSlice.hasNewer).toBe(true);
    expect(headSlice.messages).toHaveLength(6);
    expect(headSlice.messages[0]!.id).toBe("user:m_hist_000");

    const tailSlice = (await (
      await SELF.fetch(`${APP_ORIGIN}/app/api/messages/around?messageId=${lastOutId}&threadId=t_deep&limit=6`, {
        headers: { cookie },
      })
    ).json()) as WorkspaceMessagesAroundResult;
    expect(tailSlice.hasOlder).toBe(true);
    expect(tailSlice.hasNewer).toBe(false);
    expect(tailSlice.messages).toHaveLength(6);
    expect(tailSlice.messages.at(-1)!.id).toBe(lastOutId);

    // 5) 404 isolation for private outbound, unauthorized inbound, unknown ID, and mismatched threadId
    for (const forbiddenQuery of [
      "messageId=out_priv_012b",
      "messageId=out_priv_012b&threadId=t_deep",
      "messageId=user:m_unauth_999",
      "messageId=out_nonexistent_id",
      "messageId=user:m_nonexistent_id",
      "messageId=user:m_hist_012&threadId=t_other",
    ]) {
      const res = await SELF.fetch(`${APP_ORIGIN}/app/api/messages/around?${forbiddenQuery}`, {
        headers: { cookie },
      });
      expect(res.status, forbiddenQuery).toBe(404);
      expect(await res.json()).toEqual({ error: "message_not_found" });
    }

    expect((await llmState()).runs).toEqual([]);
  });
});

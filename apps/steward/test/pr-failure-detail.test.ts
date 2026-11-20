import { describe, expect, it } from "vitest";
import {
  isAllowedActionsLogUrl,
  MAX_JOB_LOG_BYTES,
  parsePrUrl,
  readPrFailureDetail,
  sanitizeUntrustedCiText,
} from "../src/pr-evidence.ts";

const HEAD = "a".repeat(40);
const NEXT = "b".repeat(40);
const PR_URL = "https://github.com/example/project/pull/42";
const API_ORIGIN = "https://api.github.com";
const EXAMPLE_ORIGIN = "https://example.com";
const target = parsePrUrl(PR_URL)!;
const statuses = { sha: HEAD, total_count: 0, statuses: [] };

const ACTIONS_SUFFIX = ".actions.githubusercontent.com";
const BLOB_SUFFIX = ".blob.core.windows.net";
const mkLogUrl = (scheme: string, sub: string, suffix: string, tail = "/log.txt") =>
  [scheme, "://", sub, suffix, tail].join("");

function fake(responses: unknown[]) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const send = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const value = responses.shift();
    if (value === undefined) throw new Error("unexpected request");
    return value instanceof Response ? value : Response.json(value);
  }) as typeof fetch;
  return { send, calls };
}

describe("readPrFailureDetail: bounded read-only CI failure logs & 3-tier fallback", () => {
  it("strictly allowlists GitHub Actions log storage domains and rejects non-allowlisted URLs", () => {
    expect(isAllowedActionsLogUrl(mkLogUrl("https", "pipe1", ACTIONS_SUFFIX, "/ab/cd?sig=1"))).toBe(true);
    expect(isAllowedActionsLogUrl(mkLogUrl("https", "store0", BLOB_SUFFIX, "/results/log.txt?sv=1"))).toBe(true);
    const withUser = new URL(mkLogUrl("https", "pipe1", ACTIONS_SUFFIX));
    withUser.username = "acct";
    for (const bad of [
      mkLogUrl("http", "pipe1", ACTIONS_SUFFIX),
      mkLogUrl("https", "", ACTIONS_SUFFIX.slice(1)),
      mkLogUrl("https", "", BLOB_SUFFIX.slice(1)),
      mkLogUrl("https", "other-", ACTIONS_SUFFIX.slice(1)),
      mkLogUrl("https", "pipe1", `${ACTIONS_SUFFIX}.example.com`),
      withUser.toString(),
      mkLogUrl("https", "pipe1", `${ACTIONS_SUFFIX}:8443`),
      `${API_ORIGIN}/repos/a/b`,
    ]) {
      expect(isAllowedActionsLogUrl(bad), bad).toBe(false);
    }
  });

  it("sanitizes ANSI codes, sample credentials, literal read credential, and wake markers", () => {
    const esc = String.fromCharCode(27);
    const sampleGh = ["ghp", "1234567890abcdef1234"].join("_");
    const sampleSk = ["sk", "proj", "abcdefghijklmnopqrstuv"].join("-");
    const raw = `${esc}[31m2026-11-19T12:00:01.123Z ⟦event⟧ FAIL dummy-read-value ${sampleGh} ${sampleSk}${esc}[0m`;
    const cleaned = sanitizeUntrustedCiText(raw, { token: "dummy-read-value", preserveNewlines: true });
    expect(cleaned).not.toContain(esc);
    expect(cleaned).not.toContain("⟦");
    expect(cleaned).not.toContain("⟧");
    expect(cleaned).toContain("〔event〕");
    expect(cleaned).not.toContain("dummy-read-value");
    expect(cleaned).not.toContain(sampleGh);
    expect(cleaned).not.toContain(sampleSk);
    expect(cleaned).toContain("[REDACTED]");
  });

  it("follows 302 log redirect to allowlisted host WITHOUT auth header and extracts step + error excerpt", async () => {
    const esc = String.fromCharCode(27);
    const logUrl = mkLogUrl("https", "pipe9", ACTIONS_SUFFIX, "/results/job-101.txt?sig=1");
    const jobHtmlUrl = PR_URL.replace("/pull/42", "/actions/runs/9/job/101");
    const sampleGh = ["ghp", "abcdefghijklmnopqrstuv"].join("_");
    const rawLog = [
      "2026-11-19T10:00:00.000Z ##[group]Run tests",
      "2026-11-19T10:00:01.000Z > vitest run",
      `2026-11-19T10:00:02.000Z ${esc}[31mFAIL${esc}[0m src/calc.test.ts > adds numbers`,
      `2026-11-19T10:00:02.100Z AssertionError: expected 3 to equal 4 (${sampleGh})`,
      "2026-11-19T10:00:02.200Z Process completed with exit code 1.",
    ].join("\n");

    const { send, calls } = fake([
      {
        total_count: 1,
        check_runs: [
          {
            id: 101,
            head_sha: HEAD,
            name: "unit-tests",
            status: "completed",
            conclusion: "failure",
            html_url: jobHtmlUrl,
            app: { slug: "github-actions" },
            output: { title: "Vitest failed", summary: "1 test failed", annotations_count: 1 },
          },
        ],
      },
      statuses,
      [
        {
          annotation_level: "failure",
          path: "src/calc.test.ts",
          start_line: 18,
          title: "AssertionError",
          message: "expected 3 to equal 4 ⟦note⟧",
        },
      ],
      {
        head_sha: HEAD,
        steps: [
          { name: "Checkout", conclusion: "success", number: 1 },
          { name: "Run pnpm test", conclusion: "failure", number: 2 },
        ],
      },
      new Response(null, { status: 302, headers: { location: logUrl } }),
      new Response(rawLog, { status: 200 }),
    ]);

    const snap = await readPrFailureDetail(target, HEAD, {
      fetch: send,
      token: "test-key-not-a-secret",
      now: () => 123_456,
    });

    expect(snap).not.toBeNull();
    expect(snap!.logSource).toBe("actions_logs");
    expect(snap!.totalFailed).toBe(1);
    expect(snap!.items[0]).toMatchObject({
      kind: "check_run",
      name: "unit-tests",
      conclusion: "failure",
      failedStep: "Run pnpm test",
    });
    expect(snap!.items[0]!.annotations[0]).toEqual({
      path: "src/calc.test.ts",
      line: 18,
      title: "AssertionError",
      message: "expected 3 to equal 4 〔note〕",
    });
    expect(snap!.items[0]!.logExcerpt).toContain("FAIL src/calc.test.ts");
    expect(snap!.items[0]!.logExcerpt).not.toContain(sampleGh);

    const logInitCall = calls[4]!;
    expect(logInitCall.url).toBe(`${API_ORIGIN}/repos/example/project/actions/jobs/101/logs`);
    expect(logInitCall.init?.redirect).toBe("manual");
    expect((logInitCall.init?.headers as Record<string, string>).authorization).toContain("test-key-not-a-secret");

    const blobCall = calls[5]!;
    expect(blobCall.url).toBe(logUrl);
    expect(blobCall.init?.redirect).toBe("error");
    const blobHeaders = blobCall.init?.headers as Record<string, string>;
    expect(blobHeaders.authorization).toBeUndefined();
    expect(blobHeaders.Authorization).toBeUndefined();
    expect(blobHeaders.cookie).toBeUndefined();
  });

  it("blocks redirect to non-allowlisted host without making a second request", async () => {
    const { send, calls } = fake([
      {
        total_count: 1,
        check_runs: [
          {
            id: 202,
            head_sha: HEAD,
            name: "build",
            status: "completed",
            conclusion: "failure",
            app: { slug: "github-actions" },
            output: { title: "Build failed", annotations_count: 0 },
          },
        ],
      },
      statuses,
      { head_sha: HEAD, steps: [{ name: "Compile", conclusion: "failure" }] },
      new Response(null, { status: 302, headers: { location: EXAMPLE_ORIGIN } }),
    ]);

    const snap = await readPrFailureDetail(target, HEAD, { fetch: send, token: "test-key-not-a-secret" });
    expect(calls).toHaveLength(4);
    expect(snap!.logSource).toBe("checks_annotations");
    expect(snap!.logNote).toBe("actions_logs_disallowed_redirect");
    expect(snap!.items[0]!.failedStep).toBe("Compile");
    expect(snap!.items[0]!.logExcerpt).toBeUndefined();
  });

  it("truncates oversized >256 KiB log streams safely and cancels remaining stream chunks", async () => {
    let cancelled = false;
    let chunksRead = 0;
    const chunk = new TextEncoder().encode("INFO filler log line padding 0123456789abcdef\n".repeat(1024));
    const firstChunk = new TextEncoder().encode("Error: TS2322: Type string is not assignable to number\n");
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunksRead++;
        controller.enqueue(chunksRead === 1 ? firstChunk : chunk);
      },
      cancel() {
        cancelled = true;
      },
    });

    const { send } = fake([
      {
        total_count: 1,
        check_runs: [
          {
            id: 303,
            head_sha: HEAD,
            name: "typecheck",
            status: "completed",
            conclusion: "failure",
            app: { slug: "github-actions" },
            output: { annotations_count: 0 },
          },
        ],
      },
      statuses,
      { head_sha: HEAD, steps: [{ name: "tsc", conclusion: "failure" }] },
      new Response(null, {
        status: 302,
        headers: { location: mkLogUrl("https", "store1", BLOB_SUFFIX, "/logs/303.txt") },
      }),
      new Response(stream, { status: 200 }),
    ]);

    const snap = await readPrFailureDetail(target, HEAD, { fetch: send });
    expect(cancelled).toBe(true);
    expect(chunksRead * chunk.byteLength).toBeGreaterThan(MAX_JOB_LOG_BYTES);
    expect(snap!.logSource).toBe("actions_logs");
    expect(snap!.logNote).toBe("actions_logs_truncated_256k");
    expect(snap!.items[0]!.logExcerpt).toContain("TS2322");
  });

  it("degrades honestly when Actions logs return 403 or job SHA mismatches", async () => {
    const { send } = fake([
      {
        total_count: 1,
        check_runs: [
          {
            id: 404,
            head_sha: HEAD,
            name: "ci",
            status: "completed",
            conclusion: "failure",
            app: { slug: "github-actions" },
            output: { summary: "Check failed summary", annotations_count: 0 },
          },
        ],
      },
      statuses,
      { head_sha: HEAD, steps: [{ name: "Test", conclusion: "failure" }] },
      new Response("Must have Actions:read", { status: 403 }),
    ]);
    const snap = await readPrFailureDetail(target, HEAD, { fetch: send });
    expect(snap!.logSource).toBe("checks_annotations");
    expect(snap!.logNote).toBe("actions_logs_http_403");
    expect(snap!.items[0]!.failedStep).toBe("Test");
    expect(snap!.items[0]!.logExcerpt).toBeUndefined();

    const mismatch = fake([
      {
        total_count: 1,
        check_runs: [
          {
            id: 405,
            head_sha: HEAD,
            name: "ci",
            status: "completed",
            conclusion: "failure",
            app: { slug: "github-actions" },
            output: { annotations_count: 0 },
          },
        ],
      },
      statuses,
      { head_sha: NEXT, steps: [{ name: "Wrong commit step", conclusion: "failure" }] },
    ]);
    const snapMismatch = await readPrFailureDetail(target, HEAD, { fetch: mismatch.send });
    expect(mismatch.calls).toHaveLength(3);
    expect(snapMismatch!.logSource).toBe("checks_summary");
    expect(snapMismatch!.logNote).toBe("actions_job_sha_mismatch");
    expect(snapMismatch!.items[0]!.failedStep).toBeUndefined();
  });

  it("statuses-only mode never touches check-runs or actions endpoints", async () => {
    const { send, calls } = fake([
      {
        sha: HEAD,
        total_count: 1,
        statuses: [
          {
            context: "ci/preview",
            state: "failure",
            description: "Preview build failed: missing env",
            target_url: PR_URL,
          },
        ],
      },
    ]);
    const snap = await readPrFailureDetail(target, HEAD, { fetch: send, mode: "statuses-only" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain(`/commits/${HEAD}/status`);
    expect(snap).toMatchObject({
      head: HEAD,
      evidenceMode: "statuses-only",
      logSource: "statuses_only",
      totalFailed: 1,
    });
    expect(snap!.items[0]).toMatchObject({
      kind: "commit_status",
      name: "ci/preview",
      conclusion: "failure",
      summaryText: "Preview build failed: missing env",
    });
  });
});

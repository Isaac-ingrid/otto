import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  configureAndBind,
  ownerStub,
  pairFakeConnector,
  resetLedgerState,
  waitForWorkerState,
  webLogin,
} from "./helpers.ts";

const ORIGIN = "https://example.com";

async function openWorkspaceSession() {
  const cookie = await webLogin();
  const res = await SELF.fetch(`${ORIGIN}/app/api/workspace`, { headers: { cookie } });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { csrf: string; threads: Array<Record<string, unknown>>; archivedCount: number };
  const post = (path: string, jsonBody: Record<string, unknown>, opts: { origin?: string | null; csrf?: string } = {}) => {
    const headers: Record<string, string> = {
      cookie,
      "content-type": "application/json",
      "x-csrf-token": opts.csrf ?? body.csrf,
    };
    if (opts.origin !== null) headers.origin = opts.origin ?? ORIGIN;
    return SELF.fetch(`${ORIGIN}${path}`, { method: "POST", headers, body: JSON.stringify(jsonBody) });
  };
  return { cookie, csrf: body.csrf, snapshot: body, post };
}

describe("stateless worker_diff relay & hasWorktree reconciliation", () => {
  beforeEach(async () => {
    await resetLedgerState();
    await configureAndBind();
    await ownerStub().setWorkerDiffTimeoutForTest(10_000);
  });

  it("enforces Origin/CSRF, blocks unsafe filePath, and maps unknown/offline/unsupported errors", async () => {
    const connector = await pairFakeConnector("mac-diff", { run: { pushed: true } });
    await connector.connect(); // workerDiff capability false by default
    const dispatched = await ownerStub().dispatchForTest({
      prompt: "implement feature",
      repoRef: "repo-a",
      newTitle: "Diff 权限测试",
    });
    expect(dispatched.kind).toBe("dispatched");
    const { workerId } = await waitForWorkerState("idle");
    const { post } = await openWorkspaceSession();

    // Missing Origin header on /app/api/workers/* -> 403 forbidden
    expect((await post(`/app/api/workers/${workerId}/diff`, {}, { origin: null })).status).toBe(403);
    // Unsafe path traversal -> 400 invalid_path
    const badPath = await post(`/app/api/workers/${workerId}/diff`, { filePath: "../secret.txt" });
    expect(badPath.status).toBe(400);
    expect(await badPath.json()).toEqual({ error: "invalid_path" });
    // Unknown worker -> 404 not_found
    expect((await post("/app/api/workers/w_missing/diff", {})).status).toBe(404);
    // Legacy connector without workerDiff capability -> 409 unsupported
    const unsupported = await post(`/app/api/workers/${workerId}/diff`, {});
    expect(unsupported.status).toBe(409);
    expect(await unsupported.json()).toEqual({ error: "unsupported" });

    // Offline machine -> 409 machine_offline
    connector.close();
    await new Promise((r) => setTimeout(r, 30));
    const offline = await post(`/app/api/workers/${workerId}/diff`, {});
    expect(offline.status).toBe(409);
    expect(await offline.json()).toEqual({ error: "machine_offline" });
  });

  it("relays worker_diff online without SQLite persistence, syncs no_worktree, and reconciles hello.hasWorktree", async () => {
    const connector = await pairFakeConnector("mac-diff-live", { run: { pushed: true } });
    connector.workerDiff = true;
    await connector.connect();
    await ownerStub().dispatchForTest({
      prompt: "add diff viewer",
      repoRef: "repo-a",
      newTitle: "在线 Diff 中继",
    });
    const { workerId } = await waitForWorkerState("idle");
    const { cookie, post } = await openWorkspaceSession();

    const pendingDiff = post(`/app/api/workers/${workerId}/diff`, { filePath: "src/a.ts", contextLines: 5 });
    const [req] = await connector.waitForWorkerDiffRequests(1);
    expect(req).toMatchObject({ t: "worker_diff", workerId, filePath: "src/a.ts", contextLines: 5 });
    connector.send({
      t: "worker_diff_result",
      re: req!.id,
      ok: true,
      diff: {
        branch: "otto/diff-1",
        base: "main",
        ahead: 1,
        dirty: 0,
        pushed: true,
        commits: [{ sha: "abc1234", subject: "add diff viewer" }],
        files: [{ path: "src/a.ts", status: "M", insertions: 3, deletions: 1, binary: false }],
        filesTruncated: false,
        patch: "diff --git a/src/a.ts b/src/a.ts\n+const ok = true;\n",
        patchTruncated: false,
      },
    });
    const okRes = await pendingDiff;
    expect(okRes.status).toBe(200);
    const okBody = (await okRes.json()) as { files: unknown[]; patch: string };
    expect(okBody.files).toHaveLength(1);
    expect(okBody.patch).toContain("+const ok = true;");

    const missingPromise = post(`/app/api/workers/${workerId}/diff`, {});
    const [, req2] = await connector.waitForWorkerDiffRequests(2);
    connector.send({ t: "worker_diff_result", re: req2!.id, ok: false, code: "no_worktree" });
    const missingRes = await missingPromise;
    expect(missingRes.status).toBe(409);
    expect(await missingRes.json()).toEqual({ error: "no_worktree" });

    const wsAfter = (await (await SELF.fetch(`${ORIGIN}/app/api/workspace`, { headers: { cookie } })).json()) as {
      threads: Array<{ workers: Array<{ id: string; worktreeStatus: string }> }>;
    };
    expect(wsAfter.threads[0]!.workers[0]!.worktreeStatus).toBe("cleaned");

    connector.close();
    connector.workers = [
      { workerId, agent: "pi", state: "idle", lastSeq: 4, sessionId: workerId, lastOutcome: "reported:done", hasWorktree: true },
    ];
    await connector.connect();
    expect((await ownerStub().debugSnapshot()).threads[0]!.workers[0]!.worktreeStatus).toBe("active");

    connector.close();
    connector.workers = [
      { workerId, agent: "pi", state: "idle", lastSeq: 4, sessionId: workerId, lastOutcome: "reported:done", hasWorktree: false },
    ];
    await connector.connect();
    expect((await ownerStub().debugSnapshot()).threads[0]!.workers[0]!.worktreeStatus).toBe("cleaned");

    await ownerStub().setWorkerDiffTimeoutForTest(60);
    const timeoutRes = await post(`/app/api/workers/${workerId}/diff`, {});
    expect(timeoutRes.status).toBe(504);
    expect(await timeoutRes.json()).toEqual({ error: "diff_timeout" });
  });
});

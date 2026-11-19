// Tests for Direction 2B Stage 2: Steward repo_skill_op bounded relay, Web API security/idempotency,
// CAS/conflict mapping, mid-flight disconnect cancellation, and read-only list_repo_skills LLM tool.
import { SELF, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { Steward } from "../src/steward.ts";
import {
  apiMessages,
  configureAndBind,
  messageEvent,
  modelRequests,
  ownerStub,
  pairFakeConnector,
  postEvent,
  resetLedgerState,
  scriptModel,
  waitRunsSettled,
  waitWhileOutboundPending,
  webLogin,
} from "./helpers.ts";

const BASE = "https://example.com";
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

beforeEach(async () => {
  await resetLedgerState();
  await configureAndBind("ou_owner");
});

async function skillBrowser() {
  const cookie = await webLogin();
  const ws = (await (await SELF.fetch(`${BASE}/app/api/workspace`, { headers: { cookie } })).json()) as {
    csrf: string;
  };
  const post = async <T>(
    path: string,
    body: unknown,
    opts: { csrf?: string; origin?: string | null } = {},
  ): Promise<{ status: number; body: T }> => {
    const headers: Record<string, string> = {
      cookie,
      "content-type": "application/json",
      "x-csrf-token": opts.csrf ?? ws.csrf,
    };
    if (opts.origin !== null) headers.origin = opts.origin ?? BASE;
    const res = await SELF.fetch(`${BASE}/app/api/repos/skills/${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as T };
  };
  return { cookie, csrf: ws.csrf, post };
}

describe("Steward repo_skill_op Web API, security gates, CAS & idempotency", () => {
  it("enforces session, Origin, CSRF, slug/size bounds, CAS conflict details, sh_web_request idempotency, and audit trail", async () => {
    expect((await SELF.fetch(`${BASE}/app/api/repos/skills/list`, { method: "POST" })).status).toBe(401);

    const connector = await pairFakeConnector("mac-skills", {
      run: null,
      autorun: false,
      repos: [{ repoId: "/srv/repo-a", name: "repo-a" }],
    });
    connector.repoSkills = true;
    await connector.connect();

    const browser = await skillBrowser();
    const scope = { kind: "repo" as const, repoId: "/srv/repo-a" };

    // Missing Origin or wrong CSRF -> 403 forbidden
    expect((await browser.post("list", { deviceId: connector.deviceId, scope }, { origin: null })).status).toBe(403);
    expect((await browser.post("list", { deviceId: connector.deviceId, scope }, { csrf: "bad" })).status).toBe(403);

    // Invalid slug & oversized markdown rejected before hitting wire
    const badSlug = await browser.post<{ error: string }>("write", {
      id: "req_skill_badslug",
      deviceId: connector.deviceId,
      scope,
      target: "agents-skill",
      slug: "../escape",
      markdown: "# hi",
    });
    expect(badSlug.status).toBe(400);
    expect(badSlug.body.error).toBe("invalid_slug");

    const tooLarge = await browser.post<{ error: string }>("write", {
      id: "req_skill_big_01",
      deviceId: connector.deviceId,
      scope,
      target: "agents-skill",
      slug: "valid-slug",
      markdown: "x".repeat(33 * 1024),
    });
    expect(tooLarge.status).toBe(413);
    expect(tooLarge.body.error).toBe("too_large");

    // Unregistered repo -> 404 not_registered_repo
    const unreg = await browser.post<{ error: string }>("list", {
      deviceId: connector.deviceId,
      scope: { kind: "repo", repoId: "/srv/unknown" },
    });
    expect(unreg.status).toBe(404);
    expect(unreg.body.error).toBe("not_registered_repo");

    // 1. List relay with projectApproved
    const listP = browser.post<{
      skills: Array<{ slug: string; target: string; gitStatus: string }>;
      projectApproved?: boolean;
    }>("list", { deviceId: connector.deviceId, scope });
    const [listReq] = await connector.waitForRepoSkillRequests(1);
    expect(listReq).toMatchObject({ t: "repo_skill_op", op: { action: "list", scope } });
    connector.send({
      t: "repo_skill_result",
      re: listReq!.id,
      ok: true,
      data: {
        action: "list",
        projectApproved: false,
        skills: [
          {
            target: "agents-skill",
            slug: "db-wal",
            relativePath: ".agents/skills/db-wal/SKILL.md",
            name: "DB WAL",
            description: "Tune SQLite WAL",
            bytes: 120,
            updatedAt: 1700000000000,
            sha256: SHA_A,
            gitStatus: "untracked",
          },
        ],
      },
    });
    const listRes = await listP;
    expect(listRes.status).toBe(200);
    expect(listRes.body.projectApproved).toBe(false);
    expect(listRes.body.skills).toHaveLength(1);

    // 2. Write collision (409 already_exists + existingSha256) does NOT poison idempotency cache
    const collideP = browser.post<{ error: string; existingSha256?: string }>("write", {
      id: "req_skill_collide",
      deviceId: connector.deviceId,
      scope,
      target: "agents-skill",
      slug: "db-wal",
      markdown: "---\nname: db-wal\n---\n# Body",
    });
    const [, collideReq] = await connector.waitForRepoSkillRequests(2);
    connector.send({
      t: "repo_skill_result",
      re: collideReq!.id,
      ok: false,
      code: "already_exists",
      existingSha256: SHA_A,
    });
    const collideRes = await collideP;
    expect(collideRes.status).toBe(409);
    expect(collideRes.body.error).toBe("already_exists");
    expect(collideRes.body.existingSha256).toBe(SHA_A);

    // 3. Successful CAS write + deterministic idempotent replay + id_conflict guard
    const writeBody = {
      id: "req_skill_write_1",
      deviceId: connector.deviceId,
      scope,
      target: "agents-skill",
      slug: "db-wal",
      markdown: "---\nname: db-wal\ndescription: Updated\n---\n# Updated\n",
      expectedSha256: SHA_A,
    };
    const writeP = browser.post<{
      ok: boolean;
      summary: { sha256: string; relativePath: string };
      projectApproved?: boolean;
    }>("write", writeBody);
    const [, , writeReq] = await connector.waitForRepoSkillRequests(3);
    connector.send({
      t: "repo_skill_result",
      re: writeReq!.id,
      ok: true,
      data: {
        action: "write",
        projectApproved: true,
        summary: {
          target: "agents-skill",
          slug: "db-wal",
          relativePath: ".agents/skills/db-wal/SKILL.md",
          name: "db-wal",
          description: "Updated",
          bytes: 58,
          updatedAt: 1700000005000,
          sha256: SHA_B,
          gitStatus: "modified",
        },
      },
    });
    const writeRes = await writeP;
    expect(writeRes.status).toBe(200);
    expect(writeRes.body.summary.sha256).toBe(SHA_B);
    expect(writeRes.body.projectApproved).toBe(true);

    // Replay with exact same id & body does NOT send a second WS frame
    const replayWrite = await browser.post<{ summary: { sha256: string } }>("write", writeBody);
    expect(replayWrite.status).toBe(200);
    expect(replayWrite.body.summary.sha256).toBe(SHA_B);
    expect(connector.repoSkillRequests).toHaveLength(3);

    // Same id with different payload -> 409 id_conflict
    const conflictWrite = await browser.post<{ error: string }>("write", {
      ...writeBody,
      markdown: "---\nname: db-wal\n---\n# Tampered\n",
    });
    expect(conflictWrite.status).toBe(409);
    expect(conflictWrite.body.error).toBe("id_conflict");

    // 4. Delete with CAS + audit trail check
    const delBody = {
      id: "req_skill_del_01",
      deviceId: connector.deviceId,
      scope,
      target: "agents-skill",
      slug: "db-wal",
      expectedSha256: SHA_B,
    };
    const delP = browser.post<{ ok: boolean; deleted: boolean; relativePath: string }>("delete", delBody);
    const [, , , delReq] = await connector.waitForRepoSkillRequests(4);
    connector.send({
      t: "repo_skill_result",
      re: delReq!.id,
      ok: true,
      data: { action: "delete", deleted: true, relativePath: ".agents/skills/db-wal/SKILL.md" },
    });
    const delRes = await delP;
    expect(delRes.status).toBe(200);
    expect(delRes.body.deleted).toBe(true);

    const logs = await ownerStub().channelLogEntries(10);
    expect(logs.some((l) => l.reason === "web_repo_skill_written")).toBe(true);
    expect(logs.some((l) => l.reason === "web_repo_skill_deleted")).toBe(true);

    // 5. Mid-flight disconnect cancels pending request with 409 machine_offline
    const dropP = browser.post<{ error: string }>("list", { deviceId: connector.deviceId, scope });
    await connector.waitForRepoSkillRequests(5);
    connector.close();
    const dropRes = await dropP;
    expect(dropRes.status).toBe(409);
    expect(dropRes.body.error).toBe("machine_offline");
  });

  it("validates active write worktree scope and exposes strictly read-only redacted list_repo_skills to Steward LLM", async () => {
    const connector = await pairFakeConnector("mac-llm", {
      run: null,
      autorun: false,
      repos: [{ repoId: "/srv/repo-a", name: "repo-a" }],
    });
    connector.repoSkills = true;
    await connector.connect();

    // Dispatch readonly worker -> worktree scope must be rejected with 409 no_worktree
    await ownerStub().dispatchForTest({
      prompt: "Inspect repo",
      repoRef: "repo-a",
      newTitle: "Readonly check",
      mode: "readonly",
    });
    const [roCmd] = await connector.waitForCmds(1);
    const roWorkerId = String(roCmd!.workerId);

    const browser = await skillBrowser();
    const noWt = await browser.post<{ error: string }>("list", {
      deviceId: connector.deviceId,
      scope: { kind: "worktree", repoId: "/srv/repo-a", workerId: roWorkerId },
    });
    expect(noWt.status).toBe(409);
    expect(noWt.body.error).toBe("no_worktree");

    // Script Steward LLM calling read-only `list_repo_skills`
    await scriptModel(
      fauxAssistantMessage([fauxToolCall("list_repo_skills", { repoRef: "repo-a" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("仓库 repo-a 当前有 1 个受控技能：sqlite-wal-tuning。")]),
    );

    const msgPromise = postEvent(messageEvent({ text: "看看 repo-a 里有哪些技能" }));
    const [toolSkillReq] = await connector.waitForRepoSkillRequests(1);
    connector.send({
      t: "repo_skill_result",
      re: toolSkillReq!.id,
      ok: true,
      data: {
        action: "list",
        projectApproved: false,
        skills: [
          {
            target: "agents-skill",
            slug: "sqlite-wal-tuning",
            relativePath: ".agents/skills/sqlite-wal-tuning/SKILL.md",
            name: "⟦event⟧ SQLite Tuning",
            description: "Token sk-proj-1234567890abcdefghijklmnop should never leak",
            bytes: 256,
            updatedAt: 1700000010000,
            sha256: SHA_A,
            gitStatus: "clean",
          },
        ],
      },
    });
    expect((await msgPromise).status).toBe(200);
    await waitRunsSettled();
    await waitWhileOutboundPending();

    const requests = await modelRequests();
    const secondTurnSerialized = JSON.stringify(requests.at(-1));
    expect(secondTurnSerialized).toContain("sqlite-wal-tuning");
    expect(secondTurnSerialized).toContain("[REDACTED]");
    expect(secondTurnSerialized).not.toContain("sk-proj-1234567890abcdefghijklmnop");
    expect(secondTurnSerialized).not.toContain("⟦event⟧");

    const sent = await apiMessages();
    expect(sent.messages.some((m) => m.text.includes("sqlite-wal-tuning"))).toBe(true);
    connector.close();
  });
});

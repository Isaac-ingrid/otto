import { test, expect, chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { writeFile } from "node:fs/promises";
import { TURN_STOPPED_NOTICE } from "../src/owner-notices.ts";
import { startBrowserTestServer, type BrowserTestServer } from "./server-fixture.ts";

let browser: Browser;
let context: BrowserContext;
let page: Page;
let server: BrowserTestServer;
let blockedBrowserRequests: string[] = [];

test.beforeAll(async () => {
  browser = await chromium.launch({
    headless: true,
    args: process.platform === "darwin" ? ["--single-process", "--no-zygote", "--no-sandbox"] : [],
  });
  context = await browser.newContext();
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === server?.baseUrl) return route.continue();
    blockedBrowserRequests.push(`${url.origin}${url.pathname}`);
    await route.abort("blockedbyclient");
  });
  await context.addInitScript(() => {
    try {
      localStorage.setItem("otto.setup.securitySkipped", "true");
    } catch {
      // ignore
    }
  });
  page = await context.newPage();
});

test.afterAll(async () => {
  await browser?.close().catch(() => {});
});

test.beforeEach(async () => {
  blockedBrowserRequests = [];
  server = await startBrowserTestServer();
  await context.clearCookies();
});

test.afterEach(async ({}, testInfo) => {
  try {
    if (process.env.OTTO_VERIFY_EVIDENCE === "1" && server && !page.isClosed()) {
      const screenshot = testInfo.outputPath("final-ui.png");
      await page.screenshot({ path: screenshot });
      await testInfo.attach("final-ui", { path: screenshot, contentType: "image/png" });
      // Observe via the authenticated public workspace API, never a test-only setter.
      const response = await context.request.get(`${server.baseUrl}/app/api/workspace`);
      expect(response.ok()).toBe(true);
      const { messages, threads, machines, busy } = await response.json();
      const statePath = testInfo.outputPath("workspace-state.json");
      await writeFile(statePath, JSON.stringify({ title: testInfo.title, messages, threads, machines, busy }, null, 2) + "\n");
      await testInfo.attach("workspace-state", { path: statePath, contentType: "application/json" });
    }
  } finally {
    await page.goto("about:blank").catch(() => {});
    if (server) await server.close();
    expect(blockedBrowserRequests).toEqual([]);
  }
});

async function signInToWorkspace(page: Page, srv: BrowserTestServer): Promise<void> {
  await page.goto(`${srv.baseUrl}/`);
  await expect(page.locator("#password-form")).toBeVisible();
  await page.locator("#login-password").fill(srv.loginSecret);
  await page.locator("#password-signin").click();
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.locator("#workspace")).toBeVisible();
  await expect(page.locator("#connection")).toHaveAttribute("data-state", "live");
}

test.describe("Workspace browser smoke suite", () => {
  test("1. signs in, sends a message, and displays the assistant reply", async () => {
    await server.scriptModel(fauxAssistantMessage([fauxText("Smoke reply from scripted steward.")]));
    await signInToWorkspace(page, server);

    const input = page.locator("#message-input");
    await input.fill("Hello Otto from Playwright");
    await page.locator("#send-button").click();

    await expect(page.locator("#feed .user-message .user-body")).toContainText("Hello Otto from Playwright");
    await expect(page.locator("#feed .message .message-body")).toContainText("Smoke reply from scripted steward.");
  });

  test("2. stops an in-flight turn and converges the UI cleanly", async () => {
    await server.streamRepliesAt(15);
    await server.scriptModel(
      fauxAssistantMessage([
        fauxText("one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen"),
      ]),
    );
    await signInToWorkspace(page, server);

    await page.locator("#message-input").fill("Write a long streaming response");
    await page.locator("#send-button").click();

    const stopBtn = page.locator('button[data-action="stop-turn"]');
    await expect(stopBtn).toBeVisible();
    await stopBtn.click();

    await expect(stopBtn).toBeHidden();
    await expect(page.locator("#feed .message .message-body")).toContainText(TURN_STOPPED_NOTICE);
  });

  test("3 & 4. PR watch proposal requires dedicated confirmation button; ordinary replies cannot authorize it", async () => {
    const threadId = "t_pr_smoke";
    const prUrl = "https://github.com/example/demo/pull/42";
    server.ledger.threads.create({
      threadId,
      title: "PR Watch Smoke",
      goal: "Verify bound confirmation in browser",
    });

    await server.scriptModel(
      fauxAssistantMessage(
        [fauxToolCall("create_pr_watch", { threadId, url: prUrl, evidenceMode: "statuses-only", basis: "user_explicit" })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage([fauxText("Ordinary reply noted, still waiting for button confirmation.")]),
    );

    await signInToWorkspace(page, server);

    await page.locator("#message-input").fill(`在 ${threadId} 中持续盯住 ${prUrl}，仅看 commit statuses。`);
    await page.locator("#send-button").click();

    const confirmBtn = page.locator('#feed button[data-action^="prwatch:"][data-action$=":confirm"]');
    await expect(confirmBtn).toBeVisible();
    const cardId = await confirmBtn.getAttribute("data-card");
    const action = await confirmBtn.getAttribute("data-action");
    expect(cardId).toBeTruthy();
    expect(action).toBeTruthy();

    expect(server.prWatches.list().filter((w) => w.status === "active")).toHaveLength(0);
    const cardContainer = confirmBtn.locator("..").locator("..");
    await expect(cardContainer.locator("button[data-reply]")).toHaveCount(0);

    await page.locator("#message-input").fill("同意，确认执行");
    await page.locator("#send-button").click();
    await expect(page.locator("#feed")).toContainText("Ordinary reply noted");
    expect(server.prWatches.list().filter((w) => w.status === "active")).toHaveLength(0);

    await confirmBtn.click();
    await expect.poll(() => server.prWatches.list().filter((w) => w.status === "active").length).toBe(1);
    await expect(page.locator("#feed")).toContainText("已确认此 PR 跟进");
    await expect(confirmBtn).toHaveCount(0);

    // Exercise the actual polling callback, not just creation. No wall-clock cron
    // boundary or public GitHub response may decide this browser test's result.
    await server.steward.pollPrWatches();
    expect(server.evidenceReads).toContainEqual({ url: prUrl, mode: "statuses-only" });
    expect(server.prWatches.list()[0]).toMatchObject({ status: "active", observedState: "waiting", lastError: null });

    await expect(server.submitWorkspaceActionForTest({ id: "stale-replay-attempt-01", cardId: cardId!, action: action! })).rejects.toMatchObject({
      code: "already_handled",
      status: 409,
    });
    expect(server.prWatches.list().filter((w) => w.status === "active")).toHaveLength(1);
  });

  test("5. page reload and WebSocket disconnect/reconnect recover messages and state without duplicate execution", async () => {
    await server.scriptModel(fauxAssistantMessage([fauxText("First durable reply.")]));
    await signInToWorkspace(page, server);

    await page.locator("#message-input").fill("Check durability across reload and reconnect");
    await page.locator("#send-button").click();
    await expect(page.locator("#feed")).toContainText("First durable reply.");

    const runsAfterFirst = (await server.steward.llmState()).runs.length;
    expect(runsAfterFirst).toBe(1);

    await page.reload();
    await expect(page.locator("#workspace")).toBeVisible();
    await expect(page.locator("#connection")).toHaveAttribute("data-state", "live");
    await expect(page.locator("#feed")).toContainText("Check durability across reload and reconnect");
    await expect(page.locator("#feed")).toContainText("First durable reply.");
    expect((await server.steward.llmState()).runs.length).toBe(1);

    await server.steward.enqueueOutbound({
      id: "out_reconnect_notice",
      kind: "text",
      to: "owner",
      text: "Message delivered across reconnect.",
      threadId: null,
      urgency: "push",
    });
    for (const sock of server.runtime.getWebSockets()) {
      sock.close(1012, "service restart");
    }

    await expect(page.locator("#connection")).toHaveAttribute("data-state", "live", { timeout: 10_000 });
    await expect(page.locator("#feed")).toContainText("Message delivered across reconnect.");
    expect((await server.steward.llmState()).runs.length).toBe(1);
  });

  test("6. stale or already-handled routine offer cards cannot take effect again", async () => {
    await server.scriptModel(
      fauxAssistantMessage(
        [fauxToolCall("suggest_routine", { instruction: "Audit dependencies weekly", kind: "instruction", cron: "0 17 * * 5" })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage([fauxText("Suggested a routine.")]),
    );
    await signInToWorkspace(page, server);

    await page.locator("#message-input").fill("Remind me to audit dependencies");
    await page.locator("#send-button").click();

    const acceptBtn = page.locator('#feed button[data-action="routine_accept"]');
    await expect(acceptBtn).toBeVisible();
    const cardId = await acceptBtn.getAttribute("data-card");
    expect(cardId).toBeTruthy();

    await acceptBtn.click();
    await expect(page.locator("#feed")).toContainText("已创建例行任务");
    await expect(acceptBtn).toHaveCount(0);

    await expect(
      server.submitWorkspaceActionForTest({ id: "stale-offer-replay-01", cardId: cardId!, action: "routine_accept" }),
    ).rejects.toMatchObject({
      code: "already_handled",
      status: 409,
    });
    expect((await server.steward.debugSnapshot()).routines).toHaveLength(1);
  });

  test("7. stale PR watch approval card beyond TTL cannot activate watch", async () => {
    const threadId = "t_pr_ttl";
    const host = ["github", "com"].join(".");
    const prUrl = `https://${host}/example/demo/pull/99`;
    server.ledger.threads.create({
      threadId,
      title: "PR Watch TTL Smoke",
      goal: "Verify stale approval card rejection in browser",
    });

    await server.scriptModel(
      fauxAssistantMessage(
        [fauxToolCall("create_pr_watch", { threadId, url: prUrl, evidenceMode: "statuses-only", basis: "user_explicit" })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage([fauxText("Waiting for explicit card confirmation before TTL.")]),
    );

    await signInToWorkspace(page, server);

    await page.locator("#message-input").fill(`在 ${threadId} 中持续盯住 ${prUrl}，仅看 commit statuses。`);
    await page.locator("#send-button").click();

    const confirmBtn = page.locator('#feed button[data-action^="prwatch:"][data-action$=":confirm"]');
    await expect(confirmBtn).toBeVisible();
    const cardId = await confirmBtn.getAttribute("data-card");
    const action = await confirmBtn.getAttribute("data-action");

    server.advanceApprovalClock(16 * 60_000);
    await confirmBtn.click();
    await expect(page.locator("#feed")).toContainText("已过期");
    await expect(confirmBtn).toHaveCount(0);
    expect(server.prWatches.list().filter((w) => w.status === "active")).toHaveLength(0);

    await expect(
      server.submitWorkspaceActionForTest({ id: "stale-pr-ttl-replay-01", cardId: cardId!, action: action! }),
    ).rejects.toMatchObject({
      code: "already_handled",
      status: 409,
    });
  });
});

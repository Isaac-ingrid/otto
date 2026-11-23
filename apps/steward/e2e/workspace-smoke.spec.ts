import { test, expect, chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { writeFile } from "node:fs/promises";
import WebSocket from 'ws';
import { TURN_STOPPED_NOTICE } from "../src/owner-notices.ts";
import type { ModelConfigStore } from '../src/model-config.ts';
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

  test('8. model failure survives reload; retry and activation are distinct owner actions', async () => {
    // Substitute only the external provider response; browser forms, auth, API, crypto and
    // SQLite are real. This does not claim that these fake credentials work with DeepSeek.
    const store = (server.steward as unknown as { modelConfigStore: ModelConfigStore }).modelConfigStore;
    const original = store.verifyAndProbe;
    let succeeds = false;
    store.verifyAndProbe = async () => succeeds ? { ok: true } : { ok: false, error: 'authentication' };
    try {
      await signInToWorkspace(page, server);
      await page.locator('[data-action="account"]').click();
      await page.locator('#dialog .more-providers > summary').click();
      await page.locator('#dialog [data-action="provider"][data-provider="deepseek"]').click();
      await page.locator('#model-key').fill('browser-candidate-key');
      await page.locator('#model-form button[type="submit"]').click();
      await expect(page.locator('#model-form [role="alert"]')).toContainText('current model is unchanged');
      expect(await server.steward.modelConfig()).toMatchObject({ provider: 'faux' });
      await page.reload();
      await expect(page.locator('#workspace')).toBeVisible();
      await page.locator('[data-action="account"]').click();
      await expect(page.locator('#dialog .connection-test')).toContainText('Connection test failed');
      succeeds = true;
      await page.locator('#dialog [data-operation="verify"]').click();
      await expect(page.locator('#dialog [data-operation="activate"]')).toBeVisible();
      expect(await server.steward.modelConfig()).toMatchObject({ provider: 'faux' });
      await page.locator('#dialog [data-operation="activate"]').click();
      await expect(page.locator('#dialog [data-operation="activate"]')).toHaveCount(0);
      expect(await server.steward.modelConfig()).toMatchObject({ provider: 'deepseek', apiKey: 'browser-candidate-key' });
    } finally { store.verifyAndProbe = original; }
  });

  test('9. stale model activation shows the conflict inside the settings dialog', async () => {
    await server.steward.setModelConfig('deepseek', 'fixture-key', 'deepseek-flash');
    const store = (server.steward as unknown as { modelConfigStore: ModelConfigStore }).modelConfigStore;
    const draft = await store.saveDraft({ provider: 'deepseek', modelId: 'deepseek-flash', apiKey: 'fixture-key' });
    const original = store.verifyAndProbe;
    try {
      store.verifyAndProbe = async () => ({ ok: true });
      await store.verifyDraft(draft.draftId!, draft.revision!);
    } finally { store.verifyAndProbe = original; }
    await signInToWorkspace(page, server);
    await page.locator('[data-action="account"]').click();
    await expect(page.locator('#dialog [data-operation="activate"]')).toBeEnabled();
    // Another window's authenticated public composer action, without a model call.
    const { csrf } = await (await context.request.get(`${server.baseUrl}/app/api/workspace`)).json();
    const switched = await context.request.post(`${server.baseUrl}/app/api/settings/model/selection`, {
      headers: { 'x-csrf-token': csrf, origin: server.baseUrl },
      data: { provider: 'deepseek', modelId: 'deepseek-v4-pro', thinkingLevel: 'high' },
    });
    expect(switched.status()).toBe(200);
    await page.locator('#dialog [data-operation="activate"]').click();
    await expect(page.locator('#dialog [role="alert"]')).toContainText('Configuration changed');
    expect(await server.steward.modelConfig()).toMatchObject({ modelId: 'deepseek-v4-pro' });
  });

  test('10. model activation explains busy and re-enables after a reply stops without closing settings', async () => {
    const store = (server.steward as unknown as { modelConfigStore: ModelConfigStore }).modelConfigStore;
    const draft = await store.saveDraft({ provider: 'deepseek', modelId: 'deepseek-flash', apiKey: 'fixture-key' });
    const original = store.verifyAndProbe;
    try {
      store.verifyAndProbe = async () => ({ ok: true });
      await store.verifyDraft(draft.draftId!, draft.revision!);
    } finally { store.verifyAndProbe = original; }
    await server.streamRepliesAt(2);
    await server.scriptModel(fauxAssistantMessage([fauxText('A long streaming reply. '.repeat(100))]));
    await signInToWorkspace(page, server);
    const other = await context.newPage();
    try {
      await other.goto(`${server.baseUrl}/app`);
      await expect(other.locator('#workspace')).toBeVisible();
      await expect(other.locator('#connection')).toHaveAttribute('data-state', 'live');
      await page.locator('[data-action="account"]').click();
      await expect(page.locator('#dialog [data-operation="activate"]')).toBeEnabled();
      await other.locator('#message-input').fill('Write a long reply for the busy regression.');
      await other.locator('#send-button').click();
      await expect(other.locator('[data-action="stop-turn"]')).toBeVisible();
      await expect(page.locator('#dialog [data-operation="activate"]')).toBeDisabled();
      await expect(page.locator('#dialog')).toContainText('A reply is in progress');
      await other.locator('[data-action="stop-turn"]').click();
      await expect(page.locator('#dialog [data-operation="activate"]')).toBeEnabled();
      await expect(page.locator('#dialog')).not.toContainText('A reply is in progress');
      expect(await server.steward.modelConfig()).toMatchObject({ provider: 'faux' });
    } finally { await other.close(); }
  });

  test('11. local-agent defaults are separate from the steward model and shared by Settings and Machines', async () => {
    // Only machine facts are fixture prerequisites; saving/resetting uses real owner forms.
    server.db.prepare("INSERT INTO device (deviceId, name, epoch, revoked, createdAt) VALUES ('model-machine', 'Local model machine', 1, 0, ?)").run(Date.now());
    server.ledger.machines.upsertFromHello({
      t: 'hello', id: 'models', protocol: { min: 1, max: 1 }, deviceId: 'model-machine', bootId: 'fake', connEpoch: 1,
      connector: { version: 'fake', os: 'test', arch: 'test', node: 'test' }, machine: { name: 'Local model machine', memTotalMB: 1024, memFreeMB: 512 },
      agents: [{ kind: 'codex', version: 'fake', capabilities: {}, modelCatalog: { status: 'ready', capabilities: { selection: 'launch', discovery: 'suggested', customModelInput: true, actualModelObservation: false, thinkingSelection: false }, models: [{ id: 'suggested-model', name: 'Suggested' }] } }],
      repos: [], workers: [], pendingAcks: [], limits: { maxWorkers: 1, running: 0 },
    });
    await signInToWorkspace(page, server);
    await page.locator('[data-action="account"]').click();
    const form = page.locator('#dialog form[data-agent-model="codex"]');
    await expect(form).toBeVisible();
    await form.locator('[name="model"]').fill('custom/model');
    await form.locator('button[type="submit"]').click();
    await expect(page.locator('#dialog')).toContainText('Task default saved');
    expect(await server.steward.modelConfig()).toMatchObject({ provider: 'faux', modelId: 'faux-1' });
    await page.reload();
    await expect(page.locator('#workspace')).toBeVisible();
    await page.locator('[data-action="machines"]').first().click();
    const machineForm = page.locator('#dialog form[data-agent-model="codex"]');
    await expect(machineForm.locator('[name="model"]')).toHaveValue('custom/model');
    await machineForm.locator('[name="model"]').fill('');
    await machineForm.locator('button[type="submit"]').click();
    await expect(machineForm.locator('[name="model"]')).toHaveValue('');
    const settings = await (await context.request.get(`${server.baseUrl}/app/api/settings`)).json();
    expect(settings.localAgentModels).toEqual([expect.objectContaining({ deviceId: 'model-machine', agent: 'codex', model: null })]);
    expect(settings.model).toMatchObject({ provider: 'faux', modelId: 'faux-1' });
  });

  test('12. pi picker discovers local models, refreshes without changing defaults, and labels offline cache', async () => {
    const { code } = await server.steward.createPairing();
    const paired = await server.steward.pair(code, 'Local pi discovery');
    if (!paired.ok) throw new Error('Fixture pairing failed');
    const local = { status: 'ready', source: 'local-pi', refreshable: true, discoveredAt: Date.now() - 60_000, defaultModel: 'mine/alpha',
      capabilities: { selection: 'launch', discovery: 'suggested', customModelInput: true, actualModelObservation: true, thinkingSelection: false, idFormat: 'qualified' },
      models: [{ id: 'mine/alpha', name: 'My Alpha' }] };
    let fail = false, requests = 0;
    const ws = new WebSocket(`${server.baseUrl.replace('http:', 'ws:')}/agents/steward/owner?role=connector`, { headers: { authorization: `Bearer ${paired.token}` } });
    try {
      await new Promise<void>((resolve, reject) => {
        ws.on('error', reject);
        ws.on('message', raw => {
          const frame = JSON.parse(raw.toString());
          if (frame.t === 'welcome') resolve();
          if (frame.t === 'agent_models') {
            requests++;
            ws.send(JSON.stringify(fail ? { t: 'agent_models_result', re: frame.id, ok: false, code: 'discovery_failed' }
              : { t: 'agent_models_result', re: frame.id, ok: true, catalog: { ...local, discoveredAt: Date.now(), defaultModel: 'mine/beta', models: [{ id: 'mine/beta', name: 'My Beta' }] } }));
          }
        });
        ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', id: 'local-discovery', protocol: { min: 1, max: 1 }, deviceId: paired.deviceId, bootId: 'scripted-local-discovery', connEpoch: 1,
          connector: { version: 'scripted', os: 'test', arch: 'test', node: 'test' }, machine: { name: 'Local pi discovery', memTotalMB: 1024, memFreeMB: 512 },
          agents: [{ kind: 'pi', version: 'scripted', capabilities: {}, modelCatalog: local }], repos: [], workers: [], pendingAcks: [], limits: { maxWorkers: 1, running: 0 } })));
      });
      await signInToWorkspace(page, server);
      await page.locator('[data-action="account"]').click();
      const form = page.locator('#dialog form[data-agent-model="pi"]');
      await expect(form.locator('select[name="model"] option')).toHaveCount(2);
      await expect(form).toContainText('Pi default at discovery: mine/alpha');
      await expect(form.locator('.agent-model-advanced')).not.toHaveAttribute('open');
      await form.locator('select[name="model"]').selectOption('mine/alpha');
      await form.locator('button[type="submit"]').click();
      await expect(page.locator('#dialog')).toContainText('Task default saved');
      await form.locator('[data-action="agent-model-refresh"]').click();
      await expect(page.locator('#dialog')).toContainText('Local model list refreshed');
      await expect(form.locator('select[name="model"]')).toHaveValue('mine/alpha');
      await expect(form.locator('select[name="model"] option[value="mine/beta"]')).toHaveCount(1);
      await form.locator('.agent-model-advanced summary').click();
      await form.locator('[name="useCustomModel"]').check();
      await form.locator('[name="customModel"]').fill('mine/custom');
      await form.locator('button[type="submit"]').click();
      await expect(form.locator('select[name="model"]')).toHaveValue('mine/custom');
      fail = true;
      await form.locator('[data-action="agent-model-refresh"]').click();
      await expect(page.locator('#dialog')).toContainText('Could not refresh');
      await expect(form).toContainText('Cached discovery:');
      await expect(form.locator('select[name="model"] option[value="mine/beta"]')).toHaveCount(1);
      ws.close();
      await expect(form.locator('[data-action="agent-model-refresh"]')).toBeDisabled();
      await expect(form).toContainText('Machine offline');
      expect(requests).toBe(2);
      const settings = await (await context.request.get(`${server.baseUrl}/app/api/settings`)).json();
      expect(settings.localAgentModels[0]).toMatchObject({ model: 'mine/custom', catalog: { status: 'unavailable', defaultModel: 'mine/beta' } });
      expect(settings.model).toMatchObject({ provider: 'faux', modelId: 'faux-1' });
      expect((await (await context.request.get(`${server.baseUrl}/app/api/workspace`)).json()).threads).toHaveLength(0);
    } finally { ws.close(); }
  });

  test('13. legacy pi library suggestions are hidden rather than presented as local discovery', async () => {
    server.db.prepare("INSERT INTO device (deviceId, name, epoch, revoked, createdAt) VALUES ('legacy-pi', 'Legacy pi', 1, 0, ?)").run(Date.now());
    server.ledger.machines.upsertFromHello({
      t: 'hello', id: 'legacy-pi', protocol: { min: 1, max: 1 }, deviceId: 'legacy-pi', bootId: 'fake', connEpoch: 1,
      connector: { version: 'fake', os: 'test', arch: 'test', node: 'test' }, machine: { name: 'Legacy pi', memTotalMB: 1024, memFreeMB: 512 },
      agents: [{ kind: 'pi', version: 'fake', capabilities: {}, modelCatalog: { status: 'ready', capabilities: { selection: 'launch', discovery: 'suggested', customModelInput: true, actualModelObservation: true, thinkingSelection: false }, models: Array.from({ length: 100 }, (_, i) => ({ id: `library/m${i}`, name: `Library model ${i}` })) } }],
      repos: [], workers: [], pendingAcks: [], limits: { maxWorkers: 1, running: 0 },
    });
    await signInToWorkspace(page, server);await page.locator('[data-action="account"]').click();
    const form = page.locator('#dialog form[data-agent-model="pi"]');
    await expect(form.locator('select[name="model"] option')).toHaveCount(1);
    await expect(form).toContainText('Library-wide suggestions are not shown');
    await expect(form.locator('[data-action="agent-model-refresh"]')).toBeDisabled();
    await expect(form.locator('.agent-model-advanced')).not.toHaveAttribute('open');
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

  test("14. P0 UI invariants: Top Layer toast & live region in modal, drag-out & dirty-form dialog guards, Safari IME Enter, and defined CSS tokens", async () => {
    await signInToWorkspace(page, server);

    // Safari post-compositionend (<50ms) Enter must not prematurely submit #composer-form.
    await page.locator("#message-input").fill("你好世界");
    const submittedDuringImeWindow = await page.evaluate(() => {
      const input = document.querySelector("#message-input") as HTMLTextAreaElement;
      const form = document.querySelector("#composer-form") as HTMLFormElement;
      let submitted = false;
      const onSubmit = (e: Event) => {
        submitted = true;
        e.preventDefault();
      };
      form.addEventListener("submit", onSubmit, { once: true });
      const compEnd = new CompositionEvent("compositionend", { bubbles: true, data: "你好世界" });
      input.dispatchEvent(compEnd);
      const enterAfterIme = new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        bubbles: true,
        cancelable: true,
      });
      input.dispatchEvent(enterAfterIme);
      form.removeEventListener("submit", onSubmit);
      return submitted;
    });
    expect(submittedDuringImeWindow).toBe(false);
    await expect(page.locator("#message-input")).toHaveValue("你好世界");
    await page.locator("#message-input").fill("");

    // Open Machines modal: clean top-level modal allows backdrop click, blocks drag-out dismiss,
    // and promotes #toast into Top Layer while mirroring to #dialog-announcer.
    await page.locator('[data-action="machines"]').first().click();
    const dialog = page.locator("#dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute("closedby", "any");

    // Trigger a toast inside the open modal via pairing command creation + copy.
    await page.locator('#dialog [data-action="create-pairing"]').click();
    await expect(page.locator('#dialog [data-action="copy-pairing"]')).toBeVisible();
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: server.baseUrl });
    await page.locator('#dialog [data-action="copy-pairing"]').click();
    await expect(page.locator("#toast")).toBeVisible();
    const toastInTopLayer = await page.locator("#toast").evaluate((el) => el.matches(":popover-open"));
    expect(toastInTopLayer).toBe(true);
    await expect(page.locator("#dialog-announcer")).not.toHaveText("");

    // Dragging from inside #dialog out to the backdrop must NOT close #dialog.
    const box = await dialog.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + 24);
    await page.mouse.down();
    await page.mouse.move(4, 4);
    await page.mouse.up();
    await expect(dialog).toBeVisible();

    // Clean backdrop click outside #dialog bounds light-dismisses #dialog.
    await page.mouse.click(4, 4);
    await expect(dialog).toBeHidden();

    // Open Account modal: verify .provider-variant uses defined --surface token (non-transparent)
    // and dirty #passkey-label blocks backdrop light-dismiss and prompts on Escape.
    await page.locator('[data-action="account"]').click();
    await expect(dialog).toBeVisible();
    await page.locator("#dialog .more-providers > summary").click();
    await page.locator('#dialog .more-providers [data-action="provider"][data-provider="zai"]').click();
    const firstVariant = page.locator("#dialog .provider-variant").first();
    await expect(firstVariant).toBeVisible();
    const variantBg = await firstVariant.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(variantBg).not.toBe("rgba(0, 0, 0, 0)");
    await page.locator('#dialog [data-action="close-dialog"]').first().click();
    await expect(dialog).toBeVisible(); // returned to Account modal

    const passkeyInput = page.locator("#passkey-label");
    await passkeyInput.click();
    await passkeyInput.fill("My MacBook Touch ID");
    await expect(dialog).toHaveAttribute("closedby", "closerequest");

    // Backdrop click must NOT dismiss when form is dirty.
    await page.mouse.click(4, 4);
    await expect(dialog).toBeVisible();

    // Escape prompts confirmation; cancelling keeps draft intact, accepting closes dialog.
    let confirmSeen = 0;
    page.once("dialog", (confirmDialog) => {
      confirmSeen += 1;
      void confirmDialog.dismiss();
    });
    await page.keyboard.press("Escape");
    expect(confirmSeen).toBe(1);
    await expect(dialog).toBeVisible();
    await expect(passkeyInput).toHaveValue("My MacBook Touch ID");

    // Re-establish user activation before the second Escape so CloseWatcher fires cancel cleanly.
    await passkeyInput.click();
    page.once("dialog", (confirmDialog) => {
      confirmSeen += 1;
      void confirmDialog.accept();
    });
    await page.keyboard.press("Escape");
    expect(confirmSeen).toBe(2);
    await expect(dialog).toBeHidden();
  });
});

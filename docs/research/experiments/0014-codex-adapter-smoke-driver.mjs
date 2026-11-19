#!/usr/bin/env node
// Experiment 0014 smoke & acceptance driver: OpenAI Codex CLI (`codex`) adapter,
// readonly sandbox (`-s read-only`), `-i` image attachments, launch model selection +
// rollout `turn_context` model observation, cold SQLite `exec resume --json` continuation,
// crash recovery (`reconcileStartup`), deduplicated normalized history, and Web `describeRecord`.
//
// Modes:
//   1. `--preflight` (default): ZERO agent runs, ZERO API calls, ZERO provider fees.
//      Checks `CodexAdapter` capabilities/catalog, `validateModel` positive/negative cases,
//      and probes local `codex --version` + auth file/env readiness.
//   2. `--selftest`: ZERO API calls, ZERO provider fees.
//      Runs the full isolated SQLite + WorkerManager + CodexAdapter + Web `session-model.js`
//      protocol against `apps/connector/test/fake-codex.mjs` and writes a receipt.
//   3. `--live --confirm-paid [--model gpt-5.3-codex] [--negative-model nonexistent-codex-model-0014]`:
//      Runs the isolated smoke protocol against the REAL installed `codex` CLI in an OS
//      temporary Git repository outside this checkout (report-only synthetic nonce + 1x1 PNG).
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { acceptsAgentModel } from "../../../packages/protocol/src/agent-models.ts";
import { CodexAdapter, codexCommandFromEnv } from "../../../apps/connector/src/codex-adapter.ts";
import { redactText } from "../../../apps/connector/src/redact.ts";
import { LocalStore } from "../../../apps/connector/src/store.ts";
import { WorkerManager } from "../../../apps/connector/src/worker-manager.ts";
import { createAssembler, describeRecord } from "../../../apps/steward/ui/session-model.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");
const FAKE_CODEX_PATH = join(REPO_ROOT, "apps/connector/test/fake-codex.mjs");
const FAKE_PI_SCENARIO_CONTENT = JSON.stringify({ runs: [] });
const DEFAULT_EVIDENCE_ROOT = join(REPO_ROOT, ".verification/evidence/codex-adapter-smoke");

// Minimal valid 1x1 transparent PNG (base64) for `-i <file>` attachment verification.
const ONE_PIXEL_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function parseArgs(argv) {
  const envCmd = codexCommandFromEnv();
  const out = {
    mode: "preflight",
    model: "gpt-5.3-codex",
    negativeModel: null,
    codexBin: envCmd?.[0] ?? "codex",
    codexExtraArgs: envCmd ? envCmd.slice(1) : [],
    confirmPaid: false,
    evidenceRoot: DEFAULT_EVIDENCE_ROOT,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--preflight") out.mode = "preflight";
    else if (arg === "--selftest") out.mode = "selftest";
    else if (arg === "--live") out.mode = "live";
    else if (arg === "--confirm-paid") out.confirmPaid = true;
    else if (arg === "--model" && argv[i + 1]) out.model = argv[++i];
    else if (arg === "--negative-model" && argv[i + 1]) out.negativeModel = argv[++i];
    else if (arg === "--codex-bin" && argv[i + 1]) {
      out.codexBin = argv[++i];
      out.codexExtraArgs = [];
    } else if (arg === "--evidence-dir" && argv[i + 1]) out.evidenceRoot = resolve(argv[++i]);
    else if (arg === "--help" || arg === "-h") out.help = true;
    else throw new Error(`Unknown or incomplete argument: ${arg}`);
  }
  return out;
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function assertCondition(cond, message) {
  if (!cond) throw new Error(`Assertion failed: ${message}`);
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const val = predicate();
    if (val) return val;
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, 40));
  }
}

function probeCodexBinary(codexBin, extraArgs = []) {
  const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
  const hasAuthJson = existsSync(join(codexHome, "auth.json"));
  const hasApiKeyEnv = Boolean(process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim().length > 0);
  const probe = spawnSync(codexBin, [...extraArgs, "--version"], {
    encoding: "utf8",
    timeout: 8_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (probe.error || probe.status !== 0) {
    return {
      installed: false,
      bin: codexBin,
      hasAuthJson,
      hasApiKeyEnv,
      error: probe.error ? probe.error.message : (probe.stderr || probe.stdout || `exit ${probe.status}`).trim(),
    };
  }
  return {
    installed: true,
    bin: codexBin,
    version: (probe.stdout || probe.stderr).trim().split(/\r?\n/)[0] ?? "unknown",
    hasAuthJson,
    hasApiKeyEnv,
    authReadyGuess: hasAuthJson || hasApiKeyEnv,
  };
}

function runStaticCapabilityChecks() {
  const scratchDir = mkdtempSync(join(tmpdir(), "otto-codex-preflight-"));
  try {
    const adapter = new CodexAdapter({ stateDir: scratchDir, workerLogsDir: null });
    const caps = adapter.capabilities;
    const catalog = adapter.modelCatalog;
    assertCondition(caps.readonly === true && caps.images === true && caps.history === true, "readonly/images/history must be true");
    assertCondition(caps.structuredReport === true && caps.resume === true && !caps.steer && !caps.followUp, "capabilities mismatch");
    assertCondition(catalog.capabilities.selection === "launch" && catalog.capabilities.actualModelObservation === true, "catalog mismatch");

    const validSamples = ["gpt-5.4", "gpt-5.3-codex", "gpt-5.2-codex", "o3", "o4-mini", "codex-mini-latest"];
    for (const m of validSamples) {
      assertCondition(adapter.validateModel(m) && acceptsAgentModel(catalog, m), `expected valid model '${m}'`);
    }
    const invalidSamples = ["", "--dangerously-bypass-approvals-and-sandbox", "-s", "gpt-5.4 --help", "gpt-5.4\no3", "gpt..5", "openai//gpt-5", "openai:", "gpt@", "provider/"];
    for (const bad of invalidSamples) {
      assertCondition(!adapter.validateModel(bad) && !acceptsAgentModel(catalog, bad), `expected invalid model ${JSON.stringify(bad)}`);
    }
    return { validCount: validSamples.length, invalidCount: invalidSamples.length };
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
}

function initTempGitRepo(repoDir) {
  mkdirSync(repoDir, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: repoDir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "otto-acceptance@example.invalid"], { cwd: repoDir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Otto Acceptance"], { cwd: repoDir, stdio: "ignore" });
  writeFileSync(join(repoDir, "FIXTURE.txt"), "synthetic codex acceptance fixture — do not modify\n", "utf8");
  execFileSync("git", ["add", "FIXTURE.txt"], { cwd: repoDir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "chore: synthetic fixture"], { cwd: repoDir, stdio: "ignore" });
}

function writeSelftestScripts(tempRoot, nonce, model1, negativeModel) {
  const positiveScriptPath = join(tempRoot, "fake-codex-positive.json");
  writeFileSync(
    positiveScriptPath,
    JSON.stringify({
      startup: { rolloutModel: model1 },
      runs: [
        [
          {
            emit: {
              type: "item.completed",
              item: {
                id: "prop_1",
                type: "mcp_tool_call",
                server: "otto",
                tool: "propose",
                status: "completed",
                arguments: {
                  kind: "readonly_probe",
                  targetRepoRef: "synthetic-repo",
                  prompt: "Inspect FIXTURE.txt",
                  reason: "Selftest proposal check",
                  proposalKey: "selftest-probe-1",
                },
              },
            },
          },
          {
            emit: {
              type: "item.completed",
              item: { id: "msg_1", type: "agent_message", text: `Checked readonly + PNG (${nonce})` },
            },
          },
          {
            emit: {
              type: "item.completed",
              item: {
                id: "rep_1",
                type: "mcp_tool_call",
                server: "otto",
                tool: "report",
                status: "completed",
                arguments: { status: "done", summary: `Run 1 ok (${nonce})`, answer: `NONCE=${nonce}; SUM=42` },
              },
            },
          },
        ],
        [
          {
            emit: {
              type: "item.completed",
              item: { id: "msg_2", type: "agent_message", text: `Recalled ${nonce}` },
            },
          },
          {
            emit: {
              type: "item.completed",
              item: {
                id: "rep_2",
                type: "mcp_tool_call",
                server: "otto",
                tool: "report",
                status: "completed",
                arguments: { status: "done", summary: `Cold resume recalled ${nonce}`, answer: `RECALLED=${nonce}` },
              },
            },
          },
        ],
      ],
    }),
    "utf8",
  );

  const negativeScriptPath = join(tempRoot, "fake-codex-negative.json");
  writeFileSync(
    negativeScriptPath,
    JSON.stringify({
      startup: { rolloutModel: negativeModel },
      runs: [[{ emit: { type: "turn.failed", error: { message: `Model '${negativeModel}' does not exist or you do not have access` } } }]],
    }),
    "utf8",
  );
  return { positiveScriptPath, negativeScriptPath };
}

function reassembleFullRecords(pages) {
  const assembler = createAssembler();
  const out = [];
  for (const page of pages) {
    for (const entry of page.entries) {
      const res = assembler.push(entry);
      if (res.error) throw new Error(`Assembler error: ${res.error}`);
      if (res.record) out.push(res.record);
    }
  }
  assertCondition(!assembler.partial, "Assembler left partial fragment");
  return out;
}

async function runIsolatedAcceptance(opts) {
  const runId = `${opts.mode}-${randomUUID()}`;
  const evidenceDir = join(opts.evidenceRoot, runId);
  mkdirSync(evidenceDir, { recursive: true });

  const tempRoot = mkdtempSync(join(tmpdir(), `otto-codex-0014-${opts.mode}-`));
  const repoDir = join(tempRoot, "synthetic-repo");
  const stateDir = join(tempRoot, "connector-state");
  const fakeCodexHome = join(tempRoot, "codex-home");
  mkdirSync(stateDir, { recursive: true });
  initTempGitRepo(repoDir);

  const nonce = `NONCE_${randomUUID().slice(0, 12)}`;
  const workerId = `w_codex0014_${Date.now().toString(36)}`;
  const events = [];
  const argvLogPath = join(tempRoot, "codex-argv.jsonl");
  const promptLogPath = join(tempRoot, "codex-prompt.jsonl");

  const isSelftest = opts.mode === "selftest";
  const negativeModelId = opts.negativeModel ?? (isSelftest ? "nonexistent-codex-model-0014" : null);
  const selftestScripts = isSelftest
    ? writeSelftestScripts(tempRoot, nonce, "gpt-5.3-codex-2026-11-a", negativeModelId ?? "nonexistent-codex-model-0014")
    : null;

  let store = null;
  let manager = null;

  const buildStack = (scriptOverride) => {
    const s = new LocalStore(join(stateDir, "connector.sqlite"));
    const adapter = new CodexAdapter({
      stateDir,
      command: isSelftest ? [process.execPath, FAKE_CODEX_PATH] : [opts.codexBin, ...opts.codexExtraArgs],
      env: isSelftest
        ? {
            FAKE_CODEX_SCRIPT: scriptOverride,
            FAKE_CODEX_ARGV_LOG: argvLogPath,
            FAKE_CODEX_LOG: promptLogPath,
            CODEX_HOME: fakeCodexHome,
          }
        : undefined,
      initTimeoutMs: 45_000,
    });
    const m = new WorkerManager({
      store: s,
      stateDir,
      adapters: [adapter],
      recovery: isSelftest ? { autoResumeBackoffMs: 120 } : undefined,
      emit: (wId, fields) => {
        events.push({ workerId: wId, at: Date.now(), ...fields });
      },
    });
    return { store: s, adapter, manager: m };
  };

  try {
    // --- Step 1: Readonly start_worker + 1x1 PNG image + explicit launch model ---
    ({ store, manager } = buildStack(selftestScripts?.positiveScriptPath));
    store.addRepo({
      repoId: "repo-synthetic",
      name: "synthetic-repo",
      path: repoDir,
      capability: { kind: "git", gitRoot: repoDir, defaultBranch: "main", remote: null },
    });

    const startRes = await manager.startWorker("cmd-codex-start-1", {
      workerId,
      threadId: "t_codex_0014",
      repoId: "repo-synthetic",
      mode: "readonly",
      agent: "codex",
      model: opts.model,
      modelSource: "task-default",
      images: [{ data: ONE_PIXEL_PNG_B64, mimeType: "image/png" }],
      prompt: [
        "Synthetic Codex smoke acceptance check (readonly mode: do NOT modify files or run destructive commands).",
        `Remember token "${nonce}" and compute 19 + 23.`,
        `Immediately call the Otto report tool with status="done", summary="ok", and answer="NONCE=${nonce}; SUM=42".`,
      ].join("\n"),
    });

    assertCondition(typeof startRes.sessionId === "string" && startRes.sessionId.length > 0, "missing sessionId on start");
    const sessionId = startRes.sessionId;

    const firstSettled = await waitFor(
      () => events.find((e) => e.workerId === workerId && e.type === "settled"),
      isSelftest ? 10_000 : 120_000,
      "first codex run settled",
    );
    assertCondition(firstSettled.outcome === "reported", `expected first outcome 'reported', got '${firstSettled.outcome}' (${firstSettled.errorMessage ?? ""})`);

    const rowAfterRun1 = store.getWorker(workerId);
    assertCondition(rowAfterRun1?.sessionFile === null, "Codex worker.sessionFile MUST remain null for crash-recovery safety");
    assertCondition(rowAfterRun1?.requestedModel === opts.model, "requestedModel not persisted");
    const launchObs1 = rowAfterRun1?.launchObservedModel ? JSON.parse(rowAfterRun1.launchObservedModel) : null;
    assertCondition(Boolean(launchObs1?.id), "expected launchObservedModel from rollout/stream");

    // --- Step 2: Cold SQLite reopen + `codex exec resume --json` continuation ---
    await manager.stopProcess(workerId);
    manager.stop();
    store.close();
    manager = null;
    store = null;

    if (isSelftest && selftestScripts) {
      const updated = JSON.parse(readFileSync(selftestScripts.positiveScriptPath, "utf8"));
      updated.startup.rolloutModel = "gpt-5.3-codex-2026-11-b";
      writeFileSync(selftestScripts.positiveScriptPath, JSON.stringify(updated), "utf8");
    }

    ({ store, manager } = buildStack(selftestScripts?.positiveScriptPath));
    const sendRes = await manager.handleCommand("cmd-codex-cold-2", "send", {
      workerId,
      text: "Without running shell commands, call the Otto report tool with status='done' and repeat the exact NONCE_... token from our first turn in `answer`.",
      intent: "auto",
    });
    assertCondition(sendRes && sendRes.relaunched === true, "expected cold send to relaunch codex");

    const secondSettled = await waitFor(
      () => events.filter((e) => e.workerId === workerId && e.type === "settled")[1],
      isSelftest ? 10_000 : 120_000,
      "cold codex resume settled",
    );
    assertCondition(secondSettled.outcome === "reported", `expected second outcome 'reported', got '${secondSettled.outcome}'`);

    const reports = events.filter((e) => e.workerId === workerId && e.type === "report");
    assertCondition(reports.length === 2, `expected 2 reports, got ${reports.length}`);
    assertCondition(`${reports[1].summary ?? ""} ${reports[1].answer ?? ""}`.includes(nonce), "resumed run did not recall nonce");

    const rowAfterRun2 = store.getWorker(workerId);
    const launchObs2 = rowAfterRun2?.launchObservedModel ? JSON.parse(rowAfterRun2.launchObservedModel) : null;
    const lastObs2 = rowAfterRun2?.lastObservedModel ? JSON.parse(rowAfterRun2.lastObservedModel) : null;
    assertCondition(launchObs2?.id === launchObs1.id, "launchObservedModel must stay immutable");
    if (isSelftest) {
      assertCondition(lastObs2?.id === "gpt-5.3-codex-2026-11-b", "expected lastObservedModel to advance on run 2");
      assertCondition(events.some((e) => e.workerId === workerId && e.type === "proposal"), "expected selftest MCP proposal event");
    }

    // --- Step 3: Normalized & Full session history + Web `describeRecord` verification ---
    await manager.stopProcess(workerId);
    const normHistory = await manager.history(workerId, undefined, 1024 * 1024);
    assertCondition(normHistory.done === true && normHistory.entries.length >= 2, "expected non-empty normalized history");
    assertCondition(
      !normHistory.entries.some((e) => e.text.includes("<environment_context>")),
      "synthetic <environment_context> must be filtered from normalized history",
    );
    if (isSelftest) {
      const run1UserCount = normHistory.entries.filter((e) => e.role === "user" && e.text.includes("19 + 23")).length;
      assertCondition(run1UserCount === 1, `expected deduplicated user turn count 1, got ${run1UserCount}`);
    }

    const fullPage = await manager.history(workerId, undefined, 1024 * 1024, "full");
    assertCondition(fullPage.format === "full" && fullPage.done === true, "expected full history page");
    const rawRecords = reassembleFullRecords([fullPage]);
    const described = rawRecords.map((r) => describeRecord(r));
    assertCondition(described.length > 0 && described.every((d) => d.agent === "codex"), "Web session-model must classify all rollout lines as codex");

    const wtStatus = execFileSync("git", ["status", "--porcelain"], { cwd: repoDir, encoding: "utf8" }).trim();
    assertCondition(wtStatus === "", `expected clean readonly repo, got: ${wtStatus}`);

    // --- Step 4 (optional or selftest): Single negative nonexistent-model check ---
    let negativeSummary = null;
    if (negativeModelId) {
      manager.stop();
      store.close();
      manager = null;
      store = null;

      ({ store, manager } = buildStack(selftestScripts?.negativeScriptPath));
      const negWorkerId = `${workerId}_neg`;
      let startRejected = null;
      try {
        await manager.startWorker("cmd-codex-neg-1", {
          workerId: negWorkerId,
          threadId: "t_codex_0014_neg",
          repoId: "repo-synthetic",
          mode: "readonly",
          agent: "codex",
          model: negativeModelId,
          modelSource: "override",
          prompt: "Call Otto report with status='done'.",
        });
      } catch (err) {
        startRejected = { code: err?.code ?? "startup_failed", message: redactText(err instanceof Error ? err.message : String(err)) };
      }

      if (!startRejected) {
        const negSettled = await waitFor(
          () => events.find((e) => e.workerId === negWorkerId && e.type === "settled"),
          isSelftest ? 10_000 : 60_000,
          "negative codex model settled",
        );
        await new Promise((r) => setTimeout(r, isSelftest ? 200 : 1_500));
        assertCondition(negSettled.outcome === "error", `expected negative outcome 'error', got '${negSettled.outcome}'`);
        assertCondition(store.countResumes(negWorkerId) === 0, "negative model run must not auto-resume");
        negativeSummary = {
          mode: "settled_error",
          requestedModel: negativeModelId,
          errorClass: negSettled.errorClass,
          errorMessage: redactText(String(negSettled.errorMessage ?? "")),
          autoResumes: 0,
        };
      } else {
        negativeSummary = { mode: "startup_rejected", requestedModel: negativeModelId, ...startRejected, autoResumes: 0 };
      }
    }

    const receipt = {
      experiment: "0014-codex-adapter-smoke",
      runId,
      mode: opts.mode,
      at: new Date().toISOString(),
      requestedModel: opts.model,
      sessionId,
      sessionFileInDb: rowAfterRun2?.sessionFile ?? null,
      launchObservedModel: launchObs2,
      lastObservedModel: lastObs2,
      normalizedEntriesCount: normHistory.entries.length,
      fullRecordsCount: rawRecords.length,
      reportsCount: reports.length,
      worktreeClean: true,
      negativeCheck: negativeSummary,
      sourceHashes: {
        codexAdapterTs: sha256File(join(REPO_ROOT, "apps/connector/src/codex-adapter.ts")),
        sessionHistoryTs: sha256File(join(REPO_ROOT, "apps/connector/src/session-history.ts")),
        sessionModelJs: sha256File(join(REPO_ROOT, "apps/steward/ui/session-model.js")),
        driverMjs: sha256File(fileURLToPath(import.meta.url)),
      },
    };
    const receiptPath = join(evidenceDir, "receipt.json");
    writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n", "utf8");
    return { receiptPath, receipt };
  } finally {
    if (manager) {
      await manager.stopProcess(workerId).catch(() => undefined);
      manager.stop();
    }
    if (store) store.close();
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(
      [
        "Usage: node --experimental-transform-types docs/research/experiments/0014-codex-adapter-smoke-driver.mjs [options]",
        "  --preflight                    Static capability/validation check + local codex binary probe (default, 0 cost)",
        "  --selftest                     Full isolated SQLite + readonly/PNG + cold resume + history check via fake-codex",
        "  --live --confirm-paid          Real installed codex CLI smoke acceptance in an isolated temp repo",
        "  --model <id>                   Model ID to request (default: gpt-5.3-codex)",
        "  --negative-model <id>          Optional nonexistent model ID to verify zero-retry error propagation",
        "  --codex-bin <path>             Path/name of codex executable (default: codex)",
        "  --evidence-dir <dir>           Directory to store redacted receipt.json",
      ].join("\n"),
    );
    return;
  }

  const staticChecks = runStaticCapabilityChecks();
  const binaryProbe = probeCodexBinary(opts.codexBin, opts.codexExtraArgs);

  if (opts.mode === "preflight") {
    console.log(
      JSON.stringify(
        {
          mode: "preflight",
          staticChecksPassed: true,
          validSamplesChecked: staticChecks.validCount,
          invalidSamplesChecked: staticChecks.invalidCount,
          codexBinary: binaryProbe,
          readyForLiveRun: Boolean(binaryProbe.installed && binaryProbe.authReadyGuess),
          nextCommand: binaryProbe.installed
            ? `node --experimental-transform-types docs/research/experiments/0014-codex-adapter-smoke-driver.mjs --live --confirm-paid --model ${opts.model} --negative-model nonexistent-codex-model-0014`
            : "Install OpenAI Codex CLI (`codex --version`) or pass `--codex-bin /path/to/codex`, then re-run with `--live --confirm-paid`.",
        },
        null,
        2,
      ),
    );
    return;
  }

  if (opts.mode === "selftest") {
    const { receiptPath, receipt } = await runIsolatedAcceptance(opts);
    console.log(JSON.stringify({ ok: true, receiptPath, receipt }, null, 2));
    return;
  }

  if (opts.mode === "live") {
    if (!opts.confirmPaid) {
      throw new Error("Refusing `--live` without `--confirm-paid` (real Codex CLI calls may consume quota/credits).");
    }
    if (!binaryProbe.installed) {
      throw new Error(`Codex CLI '${opts.codexBin}' is not available (${binaryProbe.error}).`);
    }
    const { receiptPath, receipt } = await runIsolatedAcceptance(opts);
    console.log(JSON.stringify({ ok: true, codexVersion: binaryProbe.version, receiptPath, receipt }, null, 2));
  }
}

main().catch((err) => {
  console.error(`[0014-driver] FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

#!/usr/bin/env node
// Experiment 0013 acceptance driver: Claude Code (`claude-code`) explicit model selection,
// cold SQLite continuation (`--resume <uuid> --model <id>`), and invalid-model error propagation.
//
// Modes:
//   1. `--preflight` (default): ZERO child tasks, ZERO API calls, ZERO provider fees.
//      Checks `ClaudeAdapter.modelCatalog`, `validateModel` positive/negative boundaries,
//      and inspects whether a `claude` executable is installed locally (`--claude-bin <path>`).
//   2. `--selftest`: ZERO API calls, ZERO provider fees.
//      Runs the full isolated SQLite + WorkerManager + ClaudeAdapter acceptance protocol
//      against `apps/connector/test/fake-claude.mjs` (start -> close & reopen SQLite -> cold send
//      recalling nonce -> negative invalid-model run with zero auto-retry) and writes a receipt.
//   3. `--live --confirm-paid [--model sonnet] [--negative-model nonexistent-model-0013] [--claude-bin claude]`:
//      Runs the isolated acceptance protocol against the REAL installed `claude` CLI in an
//      OS temporary Git repository outside this checkout (report-only synthetic nonce task,
//      verifying zero workspace file edits, session continuity, model request/observation
//      separation, and optional single-shot invalid-model rejection).
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { acceptsAgentModel, validateClaudeModelId } from "../../../packages/protocol/src/agent-models.ts";
import { ClaudeAdapter, claudeSessionId } from "../../../apps/connector/src/claude-adapter.ts";
import { redactText } from "../../../apps/connector/src/redact.ts";
import { LocalStore } from "../../../apps/connector/src/store.ts";
import { WorkerManager } from "../../../apps/connector/src/worker-manager.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");
const FAKE_CLAUDE_PATH = join(REPO_ROOT, "apps/connector/test/fake-claude.mjs");
const DEFAULT_EVIDENCE_ROOT = join(REPO_ROOT, ".verification/evidence/claude-model-selection");

function parseArgs(argv) {
  const out = {
    mode: "preflight",
    model: "sonnet",
    negativeModel: null,
    claudeBin: "claude",
    confirmPaid: false,
    evidenceRoot: DEFAULT_EVIDENCE_ROOT,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--preflight") out.mode = "preflight";
    else if (arg === "--selftest") out.mode = "selftest";
    else if (arg === "--live") out.mode = "live";
    else if (arg === "--confirm-paid") out.confirmPaid = true;
    else if (arg === "--model" && argv[i + 1]) out.model = argv[++i];
    else if (arg === "--negative-model" && argv[i + 1]) out.negativeModel = argv[++i];
    else if (arg === "--claude-bin" && argv[i + 1]) out.claudeBin = argv[++i];
    else if (arg === "--evidence-dir" && argv[i + 1]) out.evidenceRoot = resolve(argv[++i]);
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

function probeClaudeBinary(claudeBin) {
  const probe = spawnSync(claudeBin, ["--version"], {
    encoding: "utf8",
    timeout: 8_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (probe.error || probe.status !== 0) {
    return {
      installed: false,
      bin: claudeBin,
      error: probe.error ? probe.error.message : (probe.stderr || probe.stdout || `exit ${probe.status}`).trim(),
    };
  }
  return {
    installed: true,
    bin: claudeBin,
    version: (probe.stdout || probe.stderr).trim().split(/\r?\n/)[0] ?? "unknown",
  };
}

function runStaticCapabilityChecks() {
  const scratchDir = mkdtempSync(join(tmpdir(), "otto-claude-preflight-"));
  try {
    const adapter = new ClaudeAdapter({ stateDir: scratchDir, workerLogsDir: null });
    const catalog = adapter.modelCatalog;
    assertCondition(catalog.capabilities.selection === "launch", "selection must be 'launch'");
    assertCondition(catalog.capabilities.discovery === "suggested", "discovery must be 'suggested'");
    assertCondition(catalog.capabilities.customModelInput === true, "customModelInput must be true");
    assertCondition(catalog.capabilities.actualModelObservation === true, "actualModelObservation must be true");
    assertCondition(catalog.capabilities.idFormat === "opaque", "idFormat must be 'opaque'");

    const validSamples = [
      "sonnet",
      "opus",
      "haiku",
      "opusplan",
      "sonnet[1m]",
      "claude-sonnet-4-6",
      "us.anthropic.claude-sonnet-4-6-v1:0",
      "claude-sonnet-4-5@20250929",
    ];
    for (const m of validSamples) {
      assertCondition(validateClaudeModelId(m), `expected validateClaudeModelId('${m}') === true`);
      assertCondition(adapter.validateModel(m), `expected adapter.validateModel('${m}') === true`);
      assertCondition(acceptsAgentModel(catalog, m), `expected acceptsAgentModel(catalog, '${m}') === true`);
    }

    const invalidSamples = [
      "",
      "--dangerously-skip-permissions",
      "-p",
      "sonnet --help",
      "sonnet\nop",
      "sonnet[",
      "sonnet[]",
      "[1m]",
      "a[1m]b",
      "../sonnet",
      "anthropic:",
      "claude@",
      "provider/",
    ];
    for (const bad of invalidSamples) {
      assertCondition(!validateClaudeModelId(bad), `expected validateClaudeModelId(${JSON.stringify(bad)}) === false`);
      assertCondition(!adapter.validateModel(bad), `expected adapter.validateModel(${JSON.stringify(bad)}) === false`);
      assertCondition(!acceptsAgentModel(catalog, bad), `expected acceptsAgentModel(catalog, ${JSON.stringify(bad)}) === false`);
    }
    return {
      catalog,
      validCount: validSamples.length,
      invalidCount: invalidSamples.length,
    };
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
}

function initTempGitRepo(repoDir) {
  mkdirSync(repoDir, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: repoDir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "otto-acceptance@example.invalid"], { cwd: repoDir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Otto Acceptance"], { cwd: repoDir, stdio: "ignore" });
  writeFileSync(join(repoDir, "FIXTURE.txt"), "synthetic acceptance fixture — do not modify\n", "utf8");
  execFileSync("git", ["add", "FIXTURE.txt"], { cwd: repoDir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "chore: synthetic fixture"], { cwd: repoDir, stdio: "ignore" });
}

function writeSelftestScripts(tempRoot, nonce, concreteInitModel1, concreteInitModel2, negativeModel) {
  const positiveScriptPath = join(tempRoot, "fake-claude-positive.json");
  writeFileSync(
    positiveScriptPath,
    JSON.stringify({
      startup: { model: concreteInitModel1, mcpStatus: "connected" },
      runs: [
        [
          {
            emit: {
              type: "assistant",
              message: {
                stop_reason: "tool_use",
                content: [
                  {
                    type: "tool_use",
                    id: "tu_1",
                    name: "mcp__otto__report",
                    input: {
                      status: "done",
                      summary: `Initial synthetic run complete (${nonce}; 19+23=42)`,
                      answer: `NONCE=${nonce}; SUM=42`,
                    },
                  },
                ],
              },
            },
          },
        ],
        [
          {
            emit: {
              type: "system",
              subtype: "init",
              model: concreteInitModel2,
              mcp_servers: [{ name: "otto", status: "connected" }],
            },
          },
          {
            emit: {
              type: "assistant",
              message: {
                stop_reason: "tool_use",
                content: [
                  {
                    type: "tool_use",
                    id: "tu_2",
                    name: "mcp__otto__report",
                    input: {
                      status: "done",
                      summary: `Cold resume recalled ${nonce}`,
                      answer: `RECALLED=${nonce}`,
                    },
                  },
                ],
              },
            },
          },
        ],
      ],
    }),
    "utf8",
  );

  const negativeScriptPath = join(tempRoot, "fake-claude-negative.json");
  writeFileSync(
    negativeScriptPath,
    JSON.stringify({
      startup: { model: negativeModel, mcpStatus: "connected" },
      runs: [
        [
          {
            result: {
              subtype: "error_during_execution",
              is_error: true,
              result: "",
              errors: [`There's an issue with the selected model (${negativeModel}). It may not exist or you may not have access to it.`],
            },
          },
        ],
      ],
    }),
    "utf8",
  );
  return { positiveScriptPath, negativeScriptPath };
}

async function runIsolatedAcceptance(opts) {
  const runId = `${opts.mode}-${randomUUID()}`;
  const evidenceDir = join(opts.evidenceRoot, runId);
  mkdirSync(evidenceDir, { recursive: true });

  const tempRoot = mkdtempSync(join(tmpdir(), `otto-claude-0013-${opts.mode}-`));
  const repoDir = join(tempRoot, "synthetic-repo");
  const stateDir = join(tempRoot, "connector-state");
  mkdirSync(stateDir, { recursive: true });
  initTempGitRepo(repoDir);

  const nonce = `NONCE_${randomUUID().slice(0, 12)}`;
  const workerId = `w_claude0013_${Date.now().toString(36)}`;
  const expectedSessionUuid = claudeSessionId(workerId);
  const events = [];
  const argvLogPath = join(tempRoot, "claude-argv.jsonl");

  const isSelftest = opts.mode === "selftest";
  const negativeModelId = opts.negativeModel ?? (isSelftest ? "nonexistent-claude-model-0013" : null);
  const selftestScripts = isSelftest
    ? writeSelftestScripts(
        tempRoot,
        nonce,
        "claude-sonnet-4-6-20260514",
        "claude-sonnet-4-6-20260601",
        negativeModelId ?? "nonexistent-claude-model-0013",
      )
    : null;

  let store = null;
  let manager = null;

  const buildStack = (scriptOverride) => {
    const s = new LocalStore(join(stateDir, "connector.sqlite"));
    const adapter = new ClaudeAdapter({
      stateDir,
      command: isSelftest ? [process.execPath, FAKE_CLAUDE_PATH] : [opts.claudeBin],
      env: isSelftest
        ? {
            FAKE_CLAUDE_SCRIPT: scriptOverride,
            FAKE_CLAUDE_ARGV_LOG: argvLogPath,
          }
        : undefined,
      initTimeoutMs: 45_000,
    });
    const m = new WorkerManager({
      store: s,
      stateDir,
      adapters: [adapter],
      recovery: isSelftest ? { autoResumeBackoffMs: 60 } : undefined,
      emit: (wId, fields) => {
        events.push({ workerId: wId, at: Date.now(), ...fields });
      },
    });
    return { store: s, adapter, manager: m };
  };

  try {
    // --- Step 1: Initial start_worker with explicit `model` & `modelSource: 'task-default'` ---
    ({ store, manager } = buildStack(selftestScripts?.positiveScriptPath));
    store.addRepo({
      repoId: "repo-synthetic",
      name: "synthetic-repo",
      path: repoDir,
      capability: { kind: "git", defaultBranch: "main", remote: "" },
    });

    const startPrompt = [
      `Synthetic model-selection acceptance check (do NOT read, edit, create, or delete any files, and do NOT run shell commands).`,
      `Remember token "${nonce}" and compute 19 + 23.`,
      `Immediately call the Otto report tool with status="done", summary="ok", and answer="NONCE=${nonce}; SUM=42".`,
    ].join("\n");

    const startRes = await manager.startWorker("cmd-start-1", {
      workerId,
      threadId: "t_claude_0013",
      repoId: "repo-synthetic",
      mode: "write",
      agent: "claude-code",
      model: opts.model,
      modelSource: "task-default",
      prompt: startPrompt,
    });

    assertCondition(startRes.sessionId === expectedSessionUuid, `expected sessionId ${expectedSessionUuid}, got ${startRes.sessionId}`);

    const firstSettled = await waitFor(
      () => events.find((e) => e.workerId === workerId && e.type === "settled"),
      isSelftest ? 10_000 : 120_000,
      "first run settled",
    );
    assertCondition(
      firstSettled.outcome === "reported",
      `expected first run outcome 'reported', got '${firstSettled.outcome}' (${firstSettled.errorMessage ?? ""})`,
    );

    const firstReport = events.find((e) => e.workerId === workerId && e.type === "report");
    assertCondition(Boolean(firstReport), "expected structured report event on first run");
    const firstReportText = `${firstReport.summary ?? ""} ${firstReport.answer ?? ""}`;
    assertCondition(firstReportText.includes(nonce), "first report did not echo synthetic nonce");

    const rowAfterRun1 = store.getWorker(workerId);
    assertCondition(rowAfterRun1?.requestedModel === opts.model, "requestedModel was not persisted");
    assertCondition(rowAfterRun1?.modelSource === "task-default", "modelSource was not persisted as 'task-default'");
    const launchObs1 = rowAfterRun1?.launchObservedModel ? JSON.parse(rowAfterRun1.launchObservedModel) : null;
    const lastObs1 = rowAfterRun1?.lastObservedModel ? JSON.parse(rowAfterRun1.lastObservedModel) : null;
    assertCondition(launchObs1?.source === "init" && typeof launchObs1.id === "string", "missing launchObservedModel from system/init");

    // --- Step 2: Tear down process + SQLite, rebuild cold (zero in-memory StartSpec!), and send continuation ---
    await manager.stopProcess(workerId);
    manager.stop();
    store.close();
    manager = null;
    store = null;

    // For selftest's second invocation, update startup.model so we also prove launchObservedModel
    // stays pinned to run 1 while lastObservedModel advances to run 2!
    if (isSelftest && selftestScripts) {
      const updated = JSON.parse(readFileSync(selftestScripts.positiveScriptPath, "utf8"));
      updated.startup.model = "claude-sonnet-4-6-20260601";
      writeFileSync(selftestScripts.positiveScriptPath, JSON.stringify(updated), "utf8");
    }

    ({ store, manager } = buildStack(selftestScripts?.positiveScriptPath));

    const sendRes = await manager.handleCommand("cmd-cold-send-2", "send", {
      workerId,
      text: "Without touching any files or running shell commands, call the Otto report tool with status='done' and put the exact NONCE_... token from our first turn into `answer`.",
      intent: "auto",
    });
    assertCondition(sendRes && sendRes.relaunched === true, "expected cold send to relaunch process");

    const secondSettled = await waitFor(
      () => events.filter((e) => e.workerId === workerId && e.type === "settled")[1],
      isSelftest ? 10_000 : 120_000,
      "cold send settled",
    );
    assertCondition(
      secondSettled.outcome === "reported",
      `expected cold send outcome 'reported', got '${secondSettled.outcome}' (${secondSettled.errorMessage ?? ""})`,
    );

    const reports = events.filter((e) => e.workerId === workerId && e.type === "report");
    assertCondition(reports.length === 2, `expected 2 reports, got ${reports.length}`);
    const secondReportText = `${reports[1].summary ?? ""} ${reports[1].answer ?? ""}`;
    assertCondition(
      secondReportText.includes(nonce),
      "cold-resumed run did not recall the nonce from the persisted Claude session",
    );

    const rowAfterRun2 = store.getWorker(workerId);
    const launchObs2 = rowAfterRun2?.launchObservedModel ? JSON.parse(rowAfterRun2.launchObservedModel) : null;
    const lastObs2 = rowAfterRun2?.lastObservedModel ? JSON.parse(rowAfterRun2.lastObservedModel) : null;
    assertCondition(rowAfterRun2?.requestedModel === opts.model, "requestedModel drifted across cold send");
    assertCondition(rowAfterRun2?.sessionId === expectedSessionUuid, "sessionId drifted across cold send");
    assertCondition(launchObs2?.id === launchObs1.id, "launchObservedModel must remain immutable after run 1");
    assertCondition(Boolean(lastObs2?.id), "lastObservedModel missing after cold send");
    if (isSelftest) {
      assertCondition(lastObs2.id === "claude-sonnet-4-6-20260601", "expected lastObservedModel to advance on run 2");
      const argvLines = readFileSync(argvLogPath, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      assertCondition(argvLines.length === 2, `expected 2 spawned claude processes, got ${argvLines.length}`);
      assertCondition(
        argvLines[0].includes("--session-id") && argvLines[0].includes(expectedSessionUuid) && argvLines[0].includes("--model") && argvLines[0].includes(opts.model),
        "run 1 argv missing --session-id or --model",
      );
      assertCondition(
        argvLines[1].includes("--resume") && argvLines[1].includes(expectedSessionUuid) && argvLines[1].includes("--model") && argvLines[1].includes(opts.model),
        "run 2 argv missing --resume or --model",
      );
    }

    // Verify worktree remained clean (zero file mutations).
    const wtStatus = execFileSync("git", ["status", "--porcelain"], {
      cwd: rowAfterRun2.worktree ?? repoDir,
      encoding: "utf8",
    }).trim();
    assertCondition(wtStatus === "", `expected clean worktree, got: ${wtStatus}`);
    assertCondition(store.countResumes(workerId) === 0, "expected zero automatic crash resumes");

    // --- Step 3 (optional or selftest): Single negative nonexistent-model check ---
    let negativeSummary = null;
    if (negativeModelId) {
      await manager.stopProcess(workerId);
      manager.stop();
      store.close();
      manager = null;
      store = null;

      ({ store, manager } = buildStack(selftestScripts?.negativeScriptPath));
      const negWorkerId = `${workerId}_neg`;
      let startRejected = null;
      try {
        await manager.startWorker("cmd-neg-1", {
          workerId: negWorkerId,
          threadId: "t_claude_0013_neg",
          repoId: "repo-synthetic",
          mode: "write",
          agent: "claude-code",
          model: negativeModelId,
          modelSource: "override",
          prompt: "Call Otto report with status='done' and summary='should fail'.",
        });
      } catch (err) {
        startRejected = {
          code: err?.code ?? "startup_failed",
          message: redactText(err instanceof Error ? err.message : String(err)),
        };
      }

      if (!startRejected) {
        const negSettled = await waitFor(
          () => events.find((e) => e.workerId === negWorkerId && e.type === "settled"),
          isSelftest ? 10_000 : 60_000,
          "negative model settled",
        );
        // Hold past backoff window in selftest (or 2s sanity window) to prove zero auto-retry.
        await new Promise((r) => setTimeout(r, isSelftest ? 200 : 2_000));
        assertCondition(negSettled.outcome === "error", `expected negative run outcome 'error', got '${negSettled.outcome}'`);
        assertCondition(
          !events.some((e) => e.workerId === negWorkerId && e.type === "report"),
          "negative model run must not emit a false report",
        );
        assertCondition(store.countResumes(negWorkerId) === 0, "negative model run must not auto-resume");
        negativeSummary = {
          mode: "settled_error",
          requestedModel: negativeModelId,
          errorClass: negSettled.errorClass,
          errorMessage: redactText(String(negSettled.errorMessage ?? "")),
          autoResumes: store.countResumes(negWorkerId),
        };
      } else {
        negativeSummary = {
          mode: "startup_rejected",
          requestedModel: negativeModelId,
          ...startRejected,
          autoResumes: store.countResumes(negWorkerId),
        };
      }
    }

    const receipt = {
      experiment: "0013-claude-model-selection",
      runId,
      mode: opts.mode,
      at: new Date().toISOString(),
      requestedModel: opts.model,
      sessionId: expectedSessionUuid,
      launchObservedModel: launchObs2,
      lastObservedModel: lastObs2,
      reportsCount: reports.length,
      autoResumes: 0,
      worktreeClean: true,
      negativeCheck: negativeSummary,
      sourceHashes: {
        agentModelsTs: sha256File(join(REPO_ROOT, "packages/protocol/src/agent-models.ts")),
        claudeAdapterTs: sha256File(join(REPO_ROOT, "apps/connector/src/claude-adapter.ts")),
        workerManagerTs: sha256File(join(REPO_ROOT, "apps/connector/src/worker-manager.ts")),
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
        "Usage: node --experimental-transform-types docs/research/experiments/0013-claude-model-selection-driver.mjs [options]",
        "",
        "Modes:",
        "  --preflight                     Static capability/validation check + local claude binary probe (default, 0 cost)",
        "  --selftest                      Full isolated SQLite + cold-resume + negative check via fake-claude (0 cost)",
        "  --live --confirm-paid           Real installed claude CLI acceptance in an isolated temp repo",
        "",
        "Options:",
        "  --model <id>                    Model ID/alias to request (default: sonnet)",
        "  --negative-model <id>           Optional nonexistent model ID to verify zero-retry error propagation",
        "  --claude-bin <path>             Path/name of claude executable (default: claude)",
        "  --evidence-dir <dir>            Directory to store redacted receipt.json",
      ].join("\n"),
    );
    return;
  }

  const staticChecks = runStaticCapabilityChecks();
  const binaryProbe = probeClaudeBinary(opts.claudeBin);

  if (opts.mode === "preflight") {
    console.log(
      JSON.stringify(
        {
          mode: "preflight",
          staticChecksPassed: true,
          validSamplesChecked: staticChecks.validCount,
          invalidSamplesChecked: staticChecks.invalidCount,
          claudeBinary: binaryProbe,
          readyForLiveRun: binaryProbe.installed,
          nextCommand: binaryProbe.installed
            ? `node --experimental-transform-types docs/research/experiments/0013-claude-model-selection-driver.mjs --live --confirm-paid --model ${opts.model} --negative-model nonexistent-claude-model-0013`
            : "Install Claude Code CLI (`claude --version`) or pass `--claude-bin /path/to/claude`, then re-run with `--live --confirm-paid`.",
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
      throw new Error("Refusing `--live` without `--confirm-paid` (real Claude CLI calls may incur provider charges).");
    }
    if (!binaryProbe.installed) {
      throw new Error(`Claude CLI '${opts.claudeBin}' is not available (${binaryProbe.error}). Pass --claude-bin <path> or install Claude Code first.`);
    }
    const { receiptPath, receipt } = await runIsolatedAcceptance(opts);
    console.log(JSON.stringify({ ok: true, claudeVersion: binaryProbe.version, receiptPath, receipt }, null, 2));
  }
}

main().catch((err) => {
  console.error(`[0013-driver] FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

// Memory eval runner (steward.md §2.3–§2.5, §10.3; the memory-trust review): every case in
// `memory-dataset.ts` runs against a real ledger (node:sqlite, the real migrations, the real
// notes module) and the real steward extension. The model is SCRIPTED — the faux provider, like
// run-eval.ts's `--selftest` — so this needs no API key and no network, and a failure names a
// rule rather than a sampling accident.
//
// What this measures is not accuracy but the trust boundary: which claims the module is allowed
// to believe, what it does with the ones it refuses, and what the model is told. Trust
// boundaries are not a percentage, so the exit code is 0 only when every case holds.
//
// Usage: node eval/run-memory-eval.ts [--only id,id] [--verbose]

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, createRegistry, MemoryStorage } from "@earendil-works/pi-durable";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { buildStewardExtension, type StewardExtensionContext } from "../src/llm/extension.ts";
import { buildStewardModels } from "../src/llm/models.ts";
import { createLedger, type Ledger } from "../src/ledger.ts";
import { MIGRATIONS, runMigrations, type SqlExecutor } from "../src/schema.ts";
import { nodeSql } from "./harness.ts";
import { MEMORY_CASES, type MemoryCase, type MemoryIds, type ScriptedStep } from "./memory-dataset.ts";

const REPO_A = "repo-mem-a";
const REPO_B = "repo-mem-b";
const WORKER_ID = "w_mem";
const QUESTION_ID = "q_mem";
const END: ScriptedStep = { text: "好。" };

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const ONLY = arg("only")?.split(",");
const VERBOSE = process.argv.includes("--verbose");

interface World {
  ledger: Ledger;
  ids: MemoryIds;
  /** Answers that actually reached a worker (the stub records them instead of sending). */
  relays: string[];
}

/** A fresh world per case: machine, both repos, one worker with a repo, then the fixtures. */
function buildWorld(c: MemoryCase): World {
  const sql = nodeSql(":memory:");
  runMigrations(sql as SqlExecutor, MIGRATIONS);
  const ledger = createLedger({ sql, tx: (fn) => fn() });
  ledger.machines.setOnline("dev_mem", true, "eval-machine");
  const at = Date.now();
  for (const [repoId, name] of [
    [REPO_A, "repo-a"],
    [REPO_B, "repo-b"],
  ] as const) {
    sql`INSERT OR REPLACE INTO sh_repo (repoId, deviceId, name, path, defaultBranch, remote, updatedAt)
        VALUES (${repoId}, 'dev_mem', ${name}, ${`/srv/${name}`}, 'main', NULL, ${at})`;
  }
  const thread = ledger.threads.create({ title: "记忆评测", goal: "记忆信任边界", createdFromMsg: "eval" });
  ledger.workers.register({
    workerId: WORKER_ID,
    threadId: thread.threadId,
    deviceId: "dev_mem",
    agent: "pi",
    mode: "write",
    repoId: c.workerWithoutRepo ? undefined : REPO_A,
  });
  // Run history for the staleness read (§2.7): a seeded failure/success pair on the case's
  // repo is what makes an environment note's basis overtaken.
  for (const [i, run] of (c.runs ?? []).entries()) {
    const deviceId = run.deviceId ?? "dev_mem";
    const ranAt = at + run.atOffsetMs;
    sql`INSERT INTO sh_worker (workerId, threadId, deviceId, repoId, agent, mode, state, lastOutcome, createdAt, updatedAt)
        VALUES (${`w_run_${c.id}_${i}`}, ${thread.threadId}, ${deviceId}, ${run.repo === "B" ? REPO_B : REPO_A}, 'pi', 'write', 'idle', ${run.outcome}, ${ranAt}, ${ranAt})`;
  }

  const ref: Record<string, string> = {};
  for (const seed of c.seed) {
    const target = seed.supersedes !== undefined ? ref[seed.supersedes] : undefined;
    if (seed.supersedes !== undefined && target === undefined) {
      throw new Error(`${c.id}: fixture ${seed.ref} supersedes ${seed.supersedes} before it exists`);
    }
    const result = ledger.notes.commit(
      {
        text: seed.text,
        kind: seed.kind,
        source: seed.source,
        layer: seed.layer,
        ...(seed.repo !== undefined ? { scopeRepoId: seed.repo === "A" ? REPO_A : REPO_B } : {}),
      },
      target !== undefined ? { supersedes: [target] } : {},
    );
    if (!result.ok) throw new Error(`${c.id}: fixture ${seed.ref} refused — ${result.message}`);
    ref[seed.ref] = result.note.noteId;
    if (seed.confirmed === true) {
      const confirmed = ledger.notes.confirm(result.note.noteId, "user:om_seed");
      if (!confirmed.ok) throw new Error(`${c.id}: fixture ${seed.ref} could not be confirmed (${confirmed.reason})`);
    }
  }
  // Fixture bookkeeping is not part of the case: clear it so the model's own log rows are the
  // only ones a case can trip over.
  ledger.notes.drainPendingForReply();
  return { ledger, ids: { ref, repoA: REPO_A, repoB: REPO_B, workerId: WORKER_ID, questionId: QUESTION_ID }, relays: [] };
}

/** The extension context over a memory world: dispatch/ask are inert, the relay is recorded,
 *  and a confirmation's message always postdates the note it confirms. */
function buildContext(ledger: Ledger, relays: string[], input: string): StewardExtensionContext {
  return {
    ledger,
    buildBrief: () => "",
    currentRun: async () => ({
      operationId: "user:eval_mem",
      kind: "user",
      provenance: "user:eval_mem",
      routedThreadId: null,
    }),
    checkProvenanceRef: async () => true,
    messageReceivedAt: async () => Date.now() + 1_000,
    ownerMessageText: async (ref) => ref === "user:eval_mem" ? input : null,
    isOwnerMessage: async (msgId) => msgId.startsWith("eval_") || msgId.startsWith("om_"),
    startWorker: async () => ({ kind: "refused", reason: "memory eval does not dispatch" }),
    sendToWorker: async () => ({ kind: "refused", reason: "memory eval does not relay instructions" }),
    interruptWorker: async () => ({ kind: "interrupted", threadId: "t_mem", machineOffline: false }),
    askUser: async () => {},
    // The deterministic half of answer_worker: the gate in the beforeTool hook has already
    // passed (or blocked) by the time this is called, so recording the text is exactly the
    // "what reached the worker" signal the evidence cases need.
    answerWorker: async (input) => {
      relays.push(input.text);
      return { kind: "answered", delivery: "queued", threadId: "t_mem" };
    },
    notifyUser: async () => {},
    recordProactiveOutcome: () => {},
    prWatches: {
      list: () => [], targetsForThread: () => [], threadsForUrl: () => [],
      create: async () => { throw new Error("memory eval does not create PR watches"); },
      cancel: () => false,
    },
    routines: {
      create: async () => ({ ok: false as const, reason: "not in the memory eval" }),
      suggest: async () => ({ ok: true as const }),
      setFollowup: async () => ({ ok: false as const, reason: "not in the memory eval" }),
      cancel: async () => ({ ok: true as const, what: "n/a" }),
      pause: async () => ({ ok: true as const, what: "n/a" }),
    },
    audit: () => {},
  };
}

interface RunResult {
  toolResults: string[];
  relays: string[];
  ledger: Ledger;
  ids: MemoryIds;
}

/** Drives the case: fixtures + (when the case scripts one) one scripted model turn. */
async function runCase(c: MemoryCase): Promise<RunResult> {
  const world = buildWorld(c);
  const steps = c.script !== undefined && c.script.length > 0 ? c.script : [END];
  const built = buildStewardModels({ provider: "faux", modelId: "faux-1", explicit: true }, undefined);
  const registry = createRegistry();
  registry.install(buildStewardExtension(buildContext(world.ledger, world.relays, c.input ?? "（记忆评测输入）")));
  const harness = await Harness.open(new MemoryStorage(), { models: built.models, registry }, BACKGROUND_CONTEXT);
  try {
    const conversation = await harness.root(BACKGROUND_CONTEXT, {
      agent: { model: { provider: "faux", modelId: "faux-1" } },
    });
    built.faux!.setSteps(
      steps.map((step) =>
        "text" in step
          ? fauxAssistantMessage([fauxText(step.text)])
          : fauxAssistantMessage([fauxToolCall(step.tool, step.args(world.ids))], { stopReason: "toolUse" }),
      ) as never[],
    );
    const settled = await conversation!.submit(
      { type: "input", content: c.input ?? "（记忆评测输入）" },
      BACKGROUND_CONTEXT,
    );
    await settled.wait(BACKGROUND_CONTEXT);
    return {
      toolResults: [...built.faux!.requests()].map((r) => String(r.lastToolResult ?? "")),
      relays: world.relays,
      ledger: world.ledger,
      ids: world.ids,
    };
  } finally {
    await harness.close(BACKGROUND_CONTEXT).catch(() => undefined);
  }
}

/** Every expectation of one case; returns the failures (empty = pass). */
function judge(c: MemoryCase, run: RunResult): string[] {
  const failures: string[] = [];
  const haystack = [...run.toolResults, ...run.relays].join("\n");
  const idOf = (ref: string): string => {
    const id = run.ids.ref[ref];
    if (id === undefined) throw new Error(`${c.id}: expectation names unknown fixture ${ref}`);
    return id;
  };

  for (const needle of c.expect.results ?? []) {
    if (!run.toolResults.some((r) => r.includes(needle))) failures.push(`expected a tool result containing「${needle}」`);
  }
  if (c.expect.relays !== undefined) {
    const actual = run.relays.filter((r) => r.includes(c.expect.relays!.contains)).length;
    if (actual !== c.expect.relays.count) {
      failures.push(`relays containing「${c.expect.relays.contains}」: ${actual} ≠ ${c.expect.relays.count}`);
    }
  }
  for (const leak of c.expect.leaks ?? []) {
    if (haystack.includes(leak)) failures.push(`leak: 「${leak}」 appeared in a result or relay`);
  }
  if (c.expect.storedTexts !== undefined) {
    const stored = run.ledger.notes.list({ layer: "all" }).map((n) => n.text);
    if (JSON.stringify(stored) !== JSON.stringify(c.expect.storedTexts)) {
      failures.push(`stored texts: ${JSON.stringify(stored)} ≠ ${JSON.stringify(c.expect.storedTexts)}`);
    }
  }
  for (const want of c.expect.state ?? []) {
    const note = run.ledger.notes.get(idOf(want.ref));
    if (note === null) {
      failures.push(`fixture ${want.ref} is gone`);
      continue;
    }
    const mismatch =
      (want.layer !== undefined && note.layer !== want.layer) ||
      (want.status !== undefined && note.status !== want.status) ||
      (want.confirmed !== undefined && note.confirmed !== want.confirmed);
    if (mismatch) {
      failures.push(
        `fixture ${want.ref}: ${note.layer}/${note.status}/confirmed=${note.confirmed}` +
          ` ≠ ${want.layer ?? "*"}/${want.status ?? "*"}/confirmed=${want.confirmed ?? "*"}`,
      );
    }
  }
  if (c.expect.search !== undefined) {
    const spec = c.expect.search;
    const hits = run.ledger.notes.search(spec.q, {
      ...(spec.layers !== undefined ? { layers: spec.layers } : {}),
      ...(spec.repo !== undefined ? { repoIds: [spec.repo === "A" ? REPO_A : REPO_B] } : {}),
    });
    const got = hits.map((n) => n.noteId);
    const want = spec.firstIds.map(idOf);
    if (got.slice(0, want.length).join(",") !== want.join(",")) {
      failures.push(`search「${spec.q}」 order: [${got.join(", ")}] ≠ first [${want.join(", ")}]`);
    }
  }
  if (c.expect.context !== undefined) {
    const spec = c.expect.context;
    const injected = run.ledger.notes.context(
      { repoIds: [spec.repo === "B" ? REPO_B : REPO_A] },
      { maxChars: spec.maxChars },
    );
    if (injected.project.length !== spec.projectCount || injected.omitted !== spec.omitted) {
      failures.push(
        `context(maxChars=${spec.maxChars}): project ${injected.project.length} ≠ ${spec.projectCount},` +
          ` omitted ${injected.omitted} ≠ ${spec.omitted}`,
      );
    }
  }
  return failures;
}

const cases = ONLY !== undefined ? MEMORY_CASES.filter((c) => ONLY.includes(c.id)) : MEMORY_CASES;
let failed = 0;
console.log(`memory eval — ${cases.length} case(s), scripted model, no key needed\n`);
for (const c of cases) {
  const failures = judge(c, await runCase(c));
  if (failures.length === 0) {
    console.log(`  ✓ ${c.id} — ${c.title}`);
    continue;
  }
  failed++;
  console.log(`  ✗ ${c.id} — ${c.title}`);
  console.log(`      为什么: ${c.why}`);
  for (const failure of failures) console.log(`      · ${failure}`);
  if (VERBOSE) console.log(`      tool results: ${JSON.stringify(await Promise.resolve(c.script ?? []))}`);
}
console.log(failed === 0 ? "\nmemory eval OK" : `\nmemory eval FAILED (${failed}/${cases.length})`);
process.exit(failed === 0 ? 0 : 1);

// Deterministic L1 Worker Checkpoint collector (`worker_checkpoint` -> `worker_checkpoint_result`).
// Summarizes normalized session history (`pi`, `claude-code`, `codex`) plus live Git worktree
// facts into a compact, secret-redacted snapshot within WORKER_CHECKPOINT_MAX_BYTES (32 KiB).
import { existsSync } from "node:fs";
import {
  WORKER_CHECKPOINT_MAX_BYTES,
  WORKER_CHECKPOINT_MAX_COMMANDS,
  WORKER_CHECKPOINT_MAX_FILES,
  WORKER_CHECKPOINT_MAX_NOTES,
  type HistoryEntry,
  type WorkerCheckpointGit,
  type WorkerCheckpointPayload,
  type WorkerCheckpointResult,
  type WorkerCheckpointStep,
} from "@isaac2ingrid/protocol";
import { collectGitFacts } from "./git-facts.ts";
import { redactText } from "./redact.ts";

const WRITE_TOOL_RE = /^(?:write|edit|multiedit|write_file|write_to_file|replace_file_content|multi_replace_file_content|create_file|patch|apply_patch|str_replace_editor|notebookedit)$/i;
const READ_TOOL_RE = /^(?:read|view|read_file|view_file|grep|grep_search|glob|find|find_by_name|ls|list_dir|search)$/i;
const CMD_TOOL_RE = /^(?:bash|sh|shell|exec|run_command|local_shell_call|execute_command|terminal)$/i;

function cleanText(raw: string, maxChars: number, secrets: readonly string[]): string {
  const redacted = redactText(raw, secrets).replace(/\r\n/g, "\n").trim();
  if (redacted.length <= maxChars) return redacted;
  return `${redacted.slice(0, Math.max(1, maxChars - 1))}…`;
}

function stripHandoffPrefix(prompt: string): string {
  const marker = "\n本次任务：\n";
  const idx = prompt.indexOf(marker);
  if (prompt.startsWith("【交接简报】") && idx !== -1) {
    const rest = prompt.slice(idx + marker.length).trim();
    if (rest.length > 0) return rest;
  }
  return prompt;
}

export interface CollectWorkerCheckpointOptions {
  workerId: string;
  agent: string;
  sessionId: string | null;
  entries: HistoryEntry[];
  workDir?: string | null;
  base?: string | null;
  extraSecrets?: readonly string[];
}

export async function collectWorkerCheckpoint(opts: CollectWorkerCheckpointOptions): Promise<WorkerCheckpointResult> {
  const secrets = opts.extraSecrets ?? [];
  let turnCount = 0;
  let toolCallCount = 0;
  let initialGoal: string | null = null;
  let lastPrompt: string | null = null;
  const assistantNotes: string[] = [];
  const readSet = new Set<string>();
  const modifiedSet = new Set<string>();
  const collapsedCmds: Array<{ cmd: string; count: number }> = [];
  let lastStep: WorkerCheckpointStep | null = null;

  for (const entry of opts.entries) {
    if (entry.role === "user") {
      const text = stripHandoffPrefix(entry.text ?? "").trim();
      if (text) {
        turnCount += 1;
        const cleaned = cleanText(text, 500, secrets);
        if (initialGoal === null) initialGoal = cleaned;
        lastPrompt = cleaned;
      }
      continue;
    }
    if (entry.role !== "assistant") continue;
    const msg = (entry.text ?? "").trim();
    if (msg && !msg.startsWith("+")) {
      assistantNotes.push(cleanText(msg, 800, secrets));
    }
    for (const t of entry.tools ?? []) {
      if (!t.name || t.name.startsWith("+")) continue;
      toolCallCount += 1;
      const argClean = t.args ? cleanText(t.args.replace(/[\r\n]+/g, " "), 200, secrets) : undefined;
      lastStep = { tool: t.name.slice(0, 128), ...(argClean ? { args: argClean } : {}) };

      if (CMD_TOOL_RE.test(t.name) && argClean) {
        const cmdText = argClean.slice(0, 150);
        const prev = collapsedCmds[collapsedCmds.length - 1];
        if (prev && prev.cmd === cmdText) prev.count += 1;
        else collapsedCmds.push({ cmd: cmdText, count: 1 });
      } else if (WRITE_TOOL_RE.test(t.name) && argClean) {
        modifiedSet.add(argClean.slice(0, 512));
      } else if (READ_TOOL_RE.test(t.name) && argClean) {
        readSet.add(argClean.slice(0, 512));
      }
    }
  }

  let git: WorkerCheckpointGit | null = null;
  if (opts.workDir && opts.base && existsSync(opts.workDir)) {
    const facts = await collectGitFacts(opts.workDir, opts.base);
    if (facts.branch !== "unknown" || facts.dirty > 0 || facts.ahead > 0) {
      git = {
        branch: facts.branch.slice(0, 256),
        base: facts.base.slice(0, 256),
        ...(facts.head ? { head: facts.head.slice(0, 64) } : {}),
        ahead: facts.ahead,
        dirty: facts.dirty,
        filesChanged: facts.filesChanged,
        insertions: facts.insertions,
        deletions: facts.deletions,
        pushed: facts.pushed,
        ...(facts.changedFiles ? { changedFiles: facts.changedFiles.map((f) => f.slice(0, 512)).slice(0, 100) } : {}),
      };
      for (const changed of facts.changedFiles ?? []) modifiedSet.add(changed.slice(0, 512));
    }
  }

  for (const mod of modifiedSet) readSet.delete(mod);

  const commandsRun = collapsedCmds
    .slice(-WORKER_CHECKPOINT_MAX_COMMANDS)
    .map((item) => (item.count > 1 ? `${item.cmd} (×${item.count})` : item.cmd));

  let payload: WorkerCheckpointPayload = {
    workerId: opts.workerId,
    agent: opts.agent,
    sessionId: opts.sessionId,
    turnCount,
    toolCallCount,
    initialGoal,
    lastPrompt: lastPrompt === initialGoal ? null : lastPrompt,
    recentNotes: assistantNotes.slice(-WORKER_CHECKPOINT_MAX_NOTES),
    touchedFiles: {
      read: [...readSet].slice(-WORKER_CHECKPOINT_MAX_FILES),
      modified: [...modifiedSet].slice(-WORKER_CHECKPOINT_MAX_FILES),
    },
    commandsRun,
    lastStep,
    git,
  };

  if (Buffer.byteLength(JSON.stringify(payload), "utf8") > WORKER_CHECKPOINT_MAX_BYTES) {
    payload = {
      ...payload,
      recentNotes: payload.recentNotes.map((n) => n.slice(0, 300)),
      touchedFiles: {
        read: payload.touchedFiles.read.slice(-20),
        modified: payload.touchedFiles.modified.slice(-30),
      },
      commandsRun: payload.commandsRun.slice(-10),
    };
  }

  return { ok: true, checkpoint: payload };
}

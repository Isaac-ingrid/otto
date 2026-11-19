// Session-history reads (connector-pi.md §11.4): the JSONL fallback parses the session file
// along the CURRENT branch (walking back from the leaf via parentId — forks leave off-branch
// entries in the file), normalizes to roles/text/tool summaries, truncates, and caps at
// maxBytes with a pagination cursor. Claude Code transcripts are normalized via
// `readClaudeSessionHistory` / `normalizeClaudeEntries`.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  normalizeClaudeEntries,
  normalizeCodexEntries,
  normalizeSessionEntries,
  readClaudeSessionHistory,
  readCodexSessionHistory,
  readSessionHistory,
} from "../src/session-history.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "otto-session-history-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});

function entry(id: string, parentId: string | null, body: Record<string, unknown>): Record<string, unknown> {
  return { id, parentId, timestamp: Date.now(), ...body };
}

function userMessage(text: string): Record<string, unknown> {
  return { type: "message", message: { role: "user", content: text } };
}

function assistantMessage(content: unknown, stopReason = "stop"): Record<string, unknown> {
  return { type: "message", message: { role: "assistant", content, stopReason } };
}

/** A session whose live branch is e1 → e2 → e3(toolResult) → e7, with e6 forked off e1. */
function branchFixture(): Array<Record<string, unknown>> {
  return [
    entry("e1", null, userMessage("/otto cmd-1\nFix the login bug")),
    entry("e2", "e1", assistantMessage([{ type: "text", text: "Working on it" }, { type: "toolCall", id: "c1", name: "edit", arguments: { file_path: "src/auth/session.ts" } }])),
    entry("e3", "e2", { type: "message", message: { role: "toolResult", toolCallId: "c1", toolName: "edit", content: [] } }),
    entry("e4", "e2", { type: "usage", tokens: { input: 10 } }),
    entry("e5", "e2", { type: "custom", commandId: "cmd-1" }),
    entry("e6", "e1", assistantMessage("abandoned fork")),
    entry("e7", "e3", assistantMessage([{ type: "text", text: "Done" }])),
  ];
}

function writeFixture(name: string, entries: Array<Record<string, unknown>>): string {
  const path = join(dir, `${name}.jsonl`);
  const lines = [
    JSON.stringify({ type: "session", version: 3, id: name, timestamp: new Date().toISOString(), cwd: dir }),
    ...entries.map((e) => JSON.stringify(e)),
  ];
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
}

describe("readSessionHistory (JSONL along the current branch)", () => {
  it("reads only the current branch, normalized: roles, text, tool summaries; bookkeeping skipped", () => {
    const file = writeFixture("w-branch", branchFixture());
    const page = readSessionHistory(file);
    expect(page.done).toBe(true);
    expect(page.cursor).toBe("e7");
    expect(page.entries).toEqual([
      { id: "e1", role: "user", text: "/otto cmd-1\nFix the login bug" },
      {
        id: "e2",
        role: "assistant",
        text: "Working on it",
        tools: [{ name: "edit", args: "src/auth/session.ts" }],
      },
      { id: "e7", role: "assistant", text: "Done" },
    ]);
  });

  it("caps tool-call summaries at 50 with a count marker (one entry can never outgrow a chunk)", () => {
    const blocks = Array.from({ length: 5000 }, (_, i) => ({ type: "toolCall", id: `c${i}`, name: "bash", arguments: { command: `echo ${i}` } }));
    const file = writeFixture("w-tools", [
      entry("e1", null, userMessage("go")),
      entry("e2", "e1", assistantMessage([{ type: "text", text: "working" }, ...blocks])),
    ]);
    const page = readSessionHistory(file);
    const tools = page.entries[1]!.tools!;
    expect(tools).toHaveLength(51);
    expect(tools[49]).toEqual({ name: "bash", args: "echo 49" });
    expect(tools[50]).toEqual({ name: "+4950 more tool calls" });
    expect(Buffer.byteLength(JSON.stringify(page.entries[1]))).toBeLessThan(16 * 1024);
  });

  it("truncates overly long text to 4000 chars and tool args to 80", () => {
    const long = "x".repeat(10_000);
    const deepPath = `${"d/".repeat(60)}file.ts`;
    const file = writeFixture("w-trunc", [
      entry("e1", null, userMessage(long)),
      entry("e2", "e1", assistantMessage([{ type: "text", text: long }, { type: "toolCall", id: "c1", name: "bash", arguments: { command: deepPath } }])),
    ]);
    const page = readSessionHistory(file);
    expect(page.entries[0]!.text).toHaveLength(4000);
    expect(page.entries[1]!.text).toHaveLength(4000);
    expect(page.entries[1]!.tools).toEqual([{ name: "bash", args: deepPath.slice(0, 80) }]);
  });

  it("resumes after the since cursor along the branch", () => {
    const file = writeFixture("w-since", branchFixture());
    const page = readSessionHistory(file, { since: "e2" });
    expect(page.entries.map((e) => e.id)).toEqual(["e7"]);
    expect(page.done).toBe(true);
    expect(page.cursor).toBe("e7");
  });

  it("stops at maxBytes with done=false and a resumable cursor", () => {
    const file = writeFixture("w-budget", branchFixture());
    const whole = readSessionHistory(file);
    const sizeOfFirst = JSON.stringify(whole.entries[0]).length;
    const page = readSessionHistory(file, { maxBytes: sizeOfFirst + 10 });
    expect(page.entries.map((e) => e.id)).toEqual(["e1"]);
    expect(page.done).toBe(false);
    expect(page.cursor).toBe("e1");
    const rest = readSessionHistory(file, { since: page.cursor! });
    expect(rest.entries.map((e) => e.id)).toEqual(["e2", "e7"]);
  });

  it("returns an empty done page for a missing file, an empty file, or content-free entries", () => {
    expect(readSessionHistory(join(dir, "never-written.jsonl"))).toEqual({ entries: [], cursor: null, done: true });
    const onlyBookkeeping = writeFixture("w-quiet", [entry("e1", null, { type: "usage" })]);
    expect(readSessionHistory(onlyBookkeeping)).toEqual({ entries: [], cursor: null, done: true });
  });

  it("skips a torn final line (a crash mid-write) instead of failing", () => {
    const path = join(dir, "w-torn.jsonl");
    const lines = [
      JSON.stringify({ type: "session", version: 3, id: "w-torn" }),
      JSON.stringify(entry("e1", null, userMessage("hello"))),
      JSON.stringify(entry("e2", "e1", assistantMessage([{ type: "text", text: "half-writ" }]))).slice(0, 40),
    ];
    writeFileSync(path, lines.join("\n") + "\n");
    const page = readSessionHistory(path);
    expect(page.entries.map((e) => e.id)).toEqual(["e1"]);
    expect(page.done).toBe(true);
  });
});

describe("normalizeSessionEntries (the live get_entries path's shared normalizer)", () => {
  it("normalizes pi's get_entries payload shape (header included, string content)", () => {
    const page = normalizeSessionEntries([
      { type: "session", id: "s1" },
      entry("e1", null, userMessage("do it")),
      entry("e2", "e1", assistantMessage("did it")),
    ]);
    expect(page.entries).toEqual([
      { id: "e1", role: "user", text: "do it" },
      { id: "e2", role: "assistant", text: "did it" },
    ]);
    expect(page.done).toBe(true);
    expect(page.cursor).toBe("e2");
  });

  it("system-prompt-shaped messages are not transcript", () => {
    const page = normalizeSessionEntries([entry("e0", null, { type: "message", message: { role: "system", content: "You are…" } })]);
    expect(page.entries).toEqual([]);
    expect(page.done).toBe(true);
  });
});

describe("readClaudeSessionHistory & normalizeClaudeEntries (Claude Code JSONL transcripts)", () => {
  function writeClaudeFixture(name: string, records: Array<Record<string, unknown>>, trailingRaw = ""): string {
    const path = join(dir, `${name}.jsonl`);
    const body = records.map((r) => JSON.stringify(r)).join("\n") + "\n" + trailingRaw;
    writeFileSync(path, body, "utf8");
    return path;
  }

  it("normalizes Claude user/assistant records, preserves sibling parallel tool_use entries, and skips sidechains, pure tool_result wrappers, and bookkeeping", () => {
    const records = [
      { type: "system", subtype: "init", uuid: "sys-1", content: "init" },
      { type: "user", uuid: "u-1", parentUuid: null, message: { role: "user", content: "Inspect auth and config" } },
      // Parallel sibling assistant tool_use entries sharing parentUuid "u-1" (must BOTH be kept!):
      {
        type: "assistant",
        uuid: "a-1a",
        parentUuid: "u-1",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "internal reasoning" },
            { type: "text", text: "Reading auth..." },
            { type: "tool_use", id: "tu-1", name: "Read", input: { file_path: "src/auth.ts" } },
          ],
        },
      },
      {
        type: "assistant",
        uuid: "a-1b",
        parentUuid: "u-1",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "tu-2", name: "Bash", input: { command: "git status --short" } }],
        },
      },
      // Pure tool_result user wrapper (must be skipped like pi's role='toolResult'):
      {
        type: "user",
        uuid: "u-toolres",
        parentUuid: "a-1b",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tu-1", content: "export function login() {}" }],
        },
      },
      // Sub-agent sidechain entry (must be skipped in normalized view):
      {
        type: "assistant",
        uuid: "a-side",
        parentUuid: "u-1",
        isSidechain: true,
        message: { role: "assistant", content: "sub-agent internal note" },
      },
      // Thinking-only assistant entry with no text or tool calls (skipped):
      {
        type: "assistant",
        uuid: "a-think-only",
        parentUuid: "u-toolres",
        message: { role: "assistant", content: [{ type: "thinking", thinking: "pondering" }] },
      },
      {
        type: "assistant",
        uuid: "a-final",
        parentUuid: "u-toolres",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "All checks passed." }],
        },
      },
      { type: "file-history-snapshot", messageId: "a-final" },
    ];

    // Also append an unterminated trailing line (no newline yet -> mid-write by live claude):
    const halfWritten = '{"type":"assistant","uuid":"a-writing","message":{"role":"assistant","content":"still str';
    const file = writeClaudeFixture("claude-1", records, halfWritten);

    const page = readClaudeSessionHistory(file);
    expect(page.done).toBe(true);
    expect(page.cursor).toBe("a-final");
    expect(page.entries).toEqual([
      { id: "u-1", role: "user", text: "Inspect auth and config" },
      {
        id: "a-1a",
        role: "assistant",
        text: "Reading auth...",
        tools: [{ name: "Read", args: "src/auth.ts" }],
      },
      {
        id: "a-1b",
        role: "assistant",
        text: "",
        tools: [{ name: "Bash", args: "git status --short" }],
      },
      { id: "a-final", role: "assistant", text: "All checks passed." },
    ]);

    // Cursor pagination (`since`) and byte budget (`maxBytes`) work identically to pi!
    const afterFirstTool = readClaudeSessionHistory(file, { since: "a-1a" });
    expect(afterFirstTool.entries.map((e) => e.id)).toEqual(["a-1b", "a-final"]);

    const firstEntryBytes = Buffer.byteLength(JSON.stringify(page.entries[0]), "utf8");
    const budgeted = normalizeClaudeEntries(records, { maxBytes: firstEntryBytes + 8 });
    expect(budgeted.done).toBe(false);
    expect(budgeted.cursor).toBe("u-1");
    expect(budgeted.entries).toHaveLength(1);
    const tail = normalizeClaudeEntries(records, { since: budgeted.cursor! });
    expect(tail.entries.map((e) => e.id)).toEqual(["a-1a", "a-1b", "a-final"]);
  });
});

describe("readCodexSessionHistory & normalizeCodexEntries (Codex CLI rollout JSONL)", () => {
  it("deduplicates twin response_item + event_msg utterances, skips synthetic context, summarizes tools, and paginates", () => {
    const path = join(dir, "codex-rollout.jsonl");
    const lines = [
      { type: "session_meta", payload: { id: "019a-1", cwd: "/work" } },
      { type: "turn_context", payload: { model: "gpt-5.4" } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>\n<cwd>/work</cwd>\n</environment_context>" }] } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Run tests and fix bug" }] } },
      { type: "event_msg", payload: { type: "user_message", message: "Run tests and fix bug" } },
      { type: "response_item", payload: { type: "function_call", name: "shell", arguments: JSON.stringify({ command: ["bash", "-lc", "pnpm test"] }) } },
      { type: "response_item", payload: { type: "custom_tool_call", name: "apply_patch", input: "*** Begin Patch\n*** Update File: src/app.ts" } },
      { type: "event_msg", payload: { type: "agent_message", message: "Tests fixed and green." } },
      { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Tests fixed and green." }] } },
      { type: "turn_context", payload: { model: "gpt-5.4" } },
      { type: "event_msg", payload: { type: "user_message", message: "Run tests and fix bug" } },
    ];
    writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n" + '{"type":"event_msg","payload":{"type":"agent_m');

    const page = readCodexSessionHistory(path);
    expect(page.done).toBe(true);
    expect(page.entries).toEqual([
      { id: "codex-line-4", role: "user", text: "Run tests and fix bug" },
      { id: "codex-line-6", role: "assistant", text: "", tools: [{ name: "shell", args: "pnpm test" }] },
      { id: "codex-line-7", role: "assistant", text: "", tools: [{ name: "apply_patch", args: "*** Begin Patch" }] },
      { id: "codex-line-8", role: "assistant", text: "Tests fixed and green." },
      { id: "codex-line-11", role: "user", text: "Run tests and fix bug" },
    ]);
    expect(readCodexSessionHistory(path, { since: "codex-line-7" }).entries.map((e) => e.id)).toEqual([
      "codex-line-8",
      "codex-line-11",
    ]);
    const small = normalizeCodexEntries([{ id: "c1", role: "user", text: "hello" }, { id: "c2", role: "assistant", text: "world" }], { maxBytes: 45 });
    expect(small.done).toBe(false);
    expect(small.cursor).toBe("c1");
  });
});

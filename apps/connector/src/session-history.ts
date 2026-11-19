// On-demand history reads (connector-pi.md §11.4): a normalized transcript of one worker's
// session — roles, text (truncated), tool-call summaries — with a maxBytes cap and a
// pagination cursor. Two sources feed the same normalizer for pi: the live process
// (`get_entries{since}`) and the session JSONL parsed directly along the current branch
// (walking back from the leaf via parentId), used when no process is running.
//
// Claude Code keeps flat/parallel-tool JSONL transcripts under `<claudeConfig>/projects/<slug>/<uuid>.jsonl`
// (`{type:"user"|"assistant", uuid, parentUuid, isSidechain, message:{role, content}}`), where
// parallel tool calls share a `parentUuid` without representing abandoned forks (see ui/session-model.js).
import { readFileSync } from "node:fs";
import {
  HISTORY_ENTRY_TEXT_MAX_CHARS,
  HISTORY_MAX_BYTES,
  HISTORY_TOOL_ARGS_MAX_CHARS,
  HISTORY_TOOLS_MAX,
  type HistoryEntry,
  type HistoryPage,
} from "@isaac2ingrid/protocol";

interface SessionEntry {
  id?: unknown;
  parentId?: unknown;
  type?: unknown;
  message?: {
    role?: unknown;
    content?: unknown;
  } | null;
}

export interface ClaudeTranscriptRecord {
  uuid?: unknown;
  id?: unknown;
  parentUuid?: unknown;
  isSidechain?: unknown;
  type?: unknown;
  message?: {
    id?: unknown;
    role?: unknown;
    content?: unknown;
  } | null;
}

export interface CodexTranscriptRecord {
  id: string;
  role: "user" | "assistant";
  text: string;
  tools?: NonNullable<HistoryEntry["tools"]>;
}

export interface NormalizeOptions {
  /** Only entries after this entry id (already applied by `get_entries{since}` on the live path). */
  since?: string;
  /** Cumulative JSON-byte budget for the normalized entries (default 2 MB). */
  maxBytes?: number;
}

/**
 * Normalizes already-ordered session entries (branch order, oldest first) into a HistoryPage.
 * Shared by the live `get_entries` path and the JSONL branch walk. Pure: no I/O.
 */
export function normalizeSessionEntries(entries: SessionEntry[], opts: NormalizeOptions = {}): HistoryPage {
  const maxBytes = opts.maxBytes ?? HISTORY_MAX_BYTES;
  const since = opts.since;
  const out: HistoryEntry[] = [];
  let bytes = 0;
  let cursor: string | null = null;
  let skippedSince = !since; // without `since` everything counts as "after"

  for (const entry of entries) {
    if (entry.type === "session") continue;
    if (since && entry.id === since) {
      skippedSince = true;
      continue;
    }
    const normalized = normalizeEntry(entry);
    if (!normalized) continue; // bookkeeping / toolResult / system messages: not transcript
    if (!skippedSince) continue;
    const size = jsonBytes(normalized);
    if (bytes + size > maxBytes) {
      return { entries: out, cursor, done: false };
    }
    out.push(normalized);
    cursor = normalized.id;
    bytes += size;
  }
  return { entries: out, cursor, done: true };
}

/**
 * Normalizes ordered Claude Code transcript records into a HistoryPage.
 * Skips sub-agent sidechains (`isSidechain === true`), bookkeeping records (`system`, `summary`,
 * `file-history-snapshot`), and Anthropic `user` wrapper messages that carry only `tool_result`
 * blocks without user text. Preserves sibling parallel tool-call entries in file order.
 */
export function normalizeClaudeEntries(records: ClaudeTranscriptRecord[], opts: NormalizeOptions = {}): HistoryPage {
  const maxBytes = opts.maxBytes ?? HISTORY_MAX_BYTES;
  const since = opts.since;
  const out: HistoryEntry[] = [];
  let bytes = 0;
  let cursor: string | null = null;
  let skippedSince = !since;

  for (const record of records) {
    if (record.isSidechain === true) continue;
    const entryId =
      typeof record.uuid === "string" && record.uuid.length > 0
        ? record.uuid
        : typeof record.id === "string" && record.id.length > 0
          ? record.id
          : null;
    if (since && entryId === since) {
      skippedSince = true;
      continue;
    }
    const normalized = normalizeClaudeRecord(record, entryId);
    if (!normalized) continue;
    if (!skippedSince) continue;
    const size = jsonBytes(normalized);
    if (bytes + size > maxBytes) {
      return { entries: out, cursor, done: false };
    }
    out.push(normalized);
    cursor = normalized.id;
    bytes += size;
  }
  return { entries: out, cursor, done: true };
}

/**
 * Parses a pi session JSONL directly and reads along the current branch: the chain from the
 * file's last tree entry back to the root (forks/steer restarts leave off-branch entries in
 * the file; only the live branch is the conversation pi would continue).
 */
export function readSessionHistory(sessionFile: string, opts: NormalizeOptions = {}): HistoryPage {
  let text: string;
  try {
    text = readFileSync(sessionFile, "utf8");
  } catch {
    return { entries: [], cursor: null, done: true }; // no file → nothing ever happened
  }
  const entries: SessionEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as SessionEntry);
    } catch {
      // a torn mid-crash write; skip it like the §9.1 tail reader does
    }
  }
  return normalizeSessionEntries(currentBranch(entries), opts);
}

/**
 * Parses a Claude Code `<sessionUuid>.jsonl` transcript into a normalized HistoryPage.
 * Ignores any unterminated final line (when `claude` is actively appending mid-run) as well
 * as torn crash lines.
 */
export function readClaudeSessionHistory(sessionFile: string, opts: NormalizeOptions = {}): HistoryPage {
  let text: string;
  try {
    text = readFileSync(sessionFile, "utf8");
  } catch {
    return { entries: [], cursor: null, done: true };
  }
  const rawLines = text.split("\n");
  // If the file does not end with LF, the final slice may still be mid-write; leave it for the next read.
  const completeLines = text.endsWith("\n") ? rawLines : rawLines.slice(0, -1);
  const records: ClaudeTranscriptRecord[] = [];
  for (const rawLine of completeLines) {
    const trimmed = rawLine.endsWith("\r") ? rawLine.slice(0, -1).trim() : rawLine.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed) as ClaudeTranscriptRecord);
    } catch {
      // skip torn line
    }
  }
  return normalizeClaudeEntries(records, opts);
}

/**
 * Normalizes in-memory or parsed Codex transcript records into a HistoryPage.
 */
export function normalizeCodexEntries(records: CodexTranscriptRecord[], opts: NormalizeOptions = {}): HistoryPage {
  const maxBytes = opts.maxBytes ?? HISTORY_MAX_BYTES;
  const since = opts.since;
  const out: HistoryEntry[] = [];
  let bytes = 0;
  let cursor: string | null = null;
  let skippedSince = !since;

  for (const record of records) {
    if (since && record.id === since) {
      skippedSince = true;
      continue;
    }
    if (!skippedSince) continue;
    const normalized: HistoryEntry = {
      id: record.id,
      role: record.role,
      text: record.text.slice(0, HISTORY_ENTRY_TEXT_MAX_CHARS),
      ...(record.tools && record.tools.length > 0 ? { tools: record.tools.slice(0, HISTORY_TOOLS_MAX) } : {}),
    };
    const size = jsonBytes(normalized);
    if (bytes + size > maxBytes) {
      return { entries: out, cursor, done: false };
    }
    out.push(normalized);
    cursor = normalized.id;
    bytes += size;
  }
  return { entries: out, cursor, done: true };
}

function isCodexSyntheticContext(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith("<environment_context>") || t.startsWith("<permissions instructions>") || t.startsWith("<user_instructions>");
}

function summarizeCodexCmd(cmd: unknown): string | undefined {
  if (typeof cmd === "string" && cmd.length > 0) return cmd.slice(0, HISTORY_TOOL_ARGS_MAX_CHARS);
  if (Array.isArray(cmd)) {
    if (cmd.length === 3 && typeof cmd[1] === "string" && /^-[a-z]*c[a-z]*$/i.test(cmd[1]) && typeof cmd[2] === "string") {
      return cmd[2].slice(0, HISTORY_TOOL_ARGS_MAX_CHARS);
    }
    const joined = cmd.filter((p): p is string => typeof p === "string" && p.length > 0).join(" ");
    return joined ? joined.slice(0, HISTORY_TOOL_ARGS_MAX_CHARS) : undefined;
  }
  return undefined;
}

function summarizeCodexArgs(rawArgs: unknown): string | undefined {
  if (typeof rawArgs === "string") {
    try {
      return summarizeCodexArgs(JSON.parse(rawArgs));
    } catch {
      const line = rawArgs.split("\n").find((l) => l.trim().length > 0)?.trim() ?? "";
      return line ? line.slice(0, HISTORY_TOOL_ARGS_MAX_CHARS) : undefined;
    }
  }
  if (typeof rawArgs !== "object" || rawArgs === null) return undefined;
  const obj = rawArgs as Record<string, unknown>;
  return summarizeCodexCmd(obj.command ?? obj.cmd) ?? summarizeArgs(obj);
}

/**
 * Parses a Codex rollout JSONL file (`response_item` / `event_msg` / `agent_message` / `user_message`)
 * into a normalized HistoryPage, deduplicating twin `response_item` + `event_msg` utterances per turn.
 */
export function readCodexSessionHistory(sessionFile: string, opts: NormalizeOptions = {}): HistoryPage {
  let text: string;
  try {
    text = readFileSync(sessionFile, "utf8");
  } catch {
    return { entries: [], cursor: null, done: true };
  }
  const rawLines = text.split("\n");
  const completeLines = text.endsWith("\n") ? rawLines : rawLines.slice(0, -1);
  const records: CodexTranscriptRecord[] = [];
  let idx = 0;
  let lastUserInTurn: string | null = null;
  let lastAssistantInTurn: string | null = null;

  const pushUser = (id: string, msg: string) => {
    if (!msg || isCodexSyntheticContext(msg) || lastUserInTurn === msg) return;
    lastUserInTurn = msg;
    lastAssistantInTurn = null;
    records.push({ id, role: "user", text: msg });
  };
  const pushAssistant = (id: string, msg: string) => {
    if (!msg || lastAssistantInTurn === msg) return;
    lastAssistantInTurn = msg;
    lastUserInTurn = null;
    records.push({ id, role: "assistant", text: msg });
  };
  const pushTool = (id: string, name: string, args?: string) => {
    lastUserInTurn = null;
    lastAssistantInTurn = null;
    records.push({ id, role: "assistant", text: "", tools: [{ name, ...(args ? { args } : {}) }] });
  };

  for (const rawLine of completeLines) {
    const trimmed = rawLine.endsWith("\r") ? rawLine.slice(0, -1).trim() : rawLine.trim();
    if (!trimmed) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    idx += 1;
    const id = typeof parsed.id === "string" && parsed.id.length > 0 ? parsed.id : `codex-line-${idx}`;
    if (parsed.type === "turn_context") {
      lastUserInTurn = null;
      lastAssistantInTurn = null;
      continue;
    }
    if (parsed.type === "response_item" && typeof parsed.payload === "object" && parsed.payload !== null) {
      const payload = parsed.payload as Record<string, unknown>;
      if (payload.type === "message" && (payload.role === "user" || payload.role === "assistant")) {
        const content = Array.isArray(payload.content) ? (payload.content as Array<Record<string, unknown>>) : [];
        const textPart = content.map((c) => (typeof c.text === "string" ? c.text : "")).filter(Boolean).join("");
        if (payload.role === "user") pushUser(id, textPart);
        else pushAssistant(id, textPart);
      } else if (payload.type === "function_call" && typeof payload.name === "string") {
        pushTool(id, payload.name, summarizeCodexArgs(payload.arguments));
      } else if (payload.type === "custom_tool_call" && typeof payload.name === "string") {
        pushTool(id, payload.name, summarizeCodexArgs(payload.input));
      } else if (payload.type === "local_shell_call") {
        const action = typeof payload.action === "object" && payload.action !== null ? (payload.action as Record<string, unknown>) : undefined;
        pushTool(id, "Bash", summarizeCodexCmd(action?.command ?? payload.command));
      } else if (payload.type === "web_search_call") {
        const action = typeof payload.action === "object" && payload.action !== null ? (payload.action as Record<string, unknown>) : undefined;
        pushTool(id, "WebSearch", typeof action?.query === "string" ? action.query.slice(0, HISTORY_TOOL_ARGS_MAX_CHARS) : undefined);
      }
    } else if (parsed.type === "event_msg" && typeof parsed.payload === "object" && parsed.payload !== null) {
      const payload = parsed.payload as Record<string, unknown>;
      if (payload.type === "user_message" && typeof payload.message === "string") pushUser(id, payload.message);
      else if (payload.type === "agent_message" && typeof payload.message === "string") pushAssistant(id, payload.message);
    }
  }
  return normalizeCodexEntries(records, opts);
}

/** The branch ending at the file's last tree entry, oldest-first. */
function currentBranch(entries: SessionEntry[]): SessionEntry[] {
  const tree = entries.filter((e) => e.type !== "session" && typeof e.id === "string");
  if (tree.length === 0) return [];
  const byId = new Map<string, SessionEntry>();
  for (const entry of tree) byId.set(entry.id as string, entry);
  const chain: SessionEntry[] = [];
  let current: SessionEntry | undefined = tree[tree.length - 1];
  // Cycle-proof by construction: a chain longer than the tree must contain a cycle; stop.
  while (current && chain.length < tree.length) {
    chain.push(current);
    const parent = current.parentId;
    current = typeof parent === "string" && parent !== current.id ? byId.get(parent) : undefined;
  }
  return chain.reverse();
}

function normalizeEntry(entry: SessionEntry): HistoryEntry | null {
  if (entry.type !== "message" || !entry.message) return null;
  const role = entry.message.role;
  if (role !== "user" && role !== "assistant") return null; // toolResult/system: not shown
  const id = typeof entry.id === "string" && entry.id.length > 0 ? entry.id : null;
  if (!id) return null; // no id → cannot be cursor-addressed
  const { text, tools } = normalizeContent(entry.message.content);
  const normalized: HistoryEntry = { id, role, text: text.slice(0, HISTORY_ENTRY_TEXT_MAX_CHARS) };
  if (tools.length > 0) normalized.tools = tools;
  return normalized;
}

function normalizeClaudeRecord(record: ClaudeTranscriptRecord, id: string | null): HistoryEntry | null {
  if (!id) return null;
  const role =
    record.type === "user" || record.type === "assistant"
      ? record.type
      : record.message?.role === "user" || record.message?.role === "assistant"
        ? record.message.role
        : null;
  if (role !== "user" && role !== "assistant") return null;
  const content = record.message?.content;
  const { text, tools, onlyToolResults } = normalizeClaudeContent(content);
  if (role === "user" && onlyToolResults) return null;
  if (role === "assistant" && text.length === 0 && tools.length === 0) return null;
  const normalized: HistoryEntry = { id, role, text: text.slice(0, HISTORY_ENTRY_TEXT_MAX_CHARS) };
  if (tools.length > 0) normalized.tools = tools;
  return normalized;
}

function normalizeContent(content: unknown): { text: string; tools: NonNullable<HistoryEntry["tools"]> } {
  if (typeof content === "string") return { text: content, tools: [] };
  if (!Array.isArray(content)) return { text: "", tools: [] };
  let text = "";
  const tools: NonNullable<HistoryEntry["tools"]> = [];
  let toolCalls = 0;
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const b = block as { type?: unknown; text?: unknown; name?: unknown; arguments?: unknown };
    if (b.type === "text" && typeof b.text === "string") {
      text += b.text;
    } else if (b.type === "toolCall" && typeof b.name === "string") {
      toolCalls += 1;
      if (tools.length < HISTORY_TOOLS_MAX) {
        const args = summarizeArgs(b.arguments);
        tools.push(args === undefined ? { name: b.name } : { name: b.name, args });
      }
    }
    // toolResult/image blocks: shown through the assistant's tool-call summary, not verbatim.
    // toolCalls past HISTORY_TOOLS_MAX are summarized below — the point of the cap is that
    // one entry can never outgrow the 256 KiB chunk limit (protocol §3.6).
  }
  if (toolCalls > HISTORY_TOOLS_MAX) {
    tools.push({ name: `+${toolCalls - HISTORY_TOOLS_MAX} more tool calls` });
  }
  return { text, tools };
}

function normalizeClaudeContent(content: unknown): {
  text: string;
  tools: NonNullable<HistoryEntry["tools"]>;
  onlyToolResults: boolean;
} {
  if (typeof content === "string") return { text: content, tools: [], onlyToolResults: false };
  if (!Array.isArray(content)) return { text: "", tools: [], onlyToolResults: false };
  let text = "";
  const tools: NonNullable<HistoryEntry["tools"]> = [];
  let toolCalls = 0;
  let sawPrimaryBlock = false;
  let sawToolResult = false;
  for (const block of content) {
    if (typeof block === "string") {
      text += block;
      sawPrimaryBlock = true;
      continue;
    }
    if (typeof block !== "object" || block === null) continue;
    const b = block as {
      type?: unknown;
      text?: unknown;
      name?: unknown;
      input?: unknown;
      arguments?: unknown;
    };
    if (b.type === "text" && typeof b.text === "string") {
      text += b.text;
      sawPrimaryBlock = true;
    } else if ((b.type === "tool_use" || b.type === "toolCall") && typeof b.name === "string") {
      sawPrimaryBlock = true;
      toolCalls += 1;
      if (tools.length < HISTORY_TOOLS_MAX) {
        const args = summarizeArgs(b.input ?? b.arguments);
        tools.push(args === undefined ? { name: b.name } : { name: b.name, args });
      }
    } else if (b.type === "image") {
      sawPrimaryBlock = true;
    } else if (b.type === "tool_result") {
      sawToolResult = true;
    }
  }
  if (toolCalls > HISTORY_TOOLS_MAX) {
    tools.push({ name: `+${toolCalls - HISTORY_TOOLS_MAX} more tool calls` });
  }
  return { text, tools, onlyToolResults: !sawPrimaryBlock && sawToolResult };
}

/** First 80 chars of the target-ish argument — a path or command, never file contents (§11.2). */
function summarizeArgs(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  const raw = args as Record<string, unknown>;
  for (const key of ["file_path", "filePath", "path", "filename", "command", "pattern", "query", "url", "description", "prompt"]) {
    const value = raw[key];
    if (typeof value === "string" && value.length > 0) return value.slice(0, HISTORY_TOOL_ARGS_MAX_CHARS);
  }
  return undefined;
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

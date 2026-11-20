// Derived views over the workspace snapshot (see workspace.ts for its shape). Pure functions,
// no DOM: the controller asks these what to draw, and tests exercise them directly.

import { plainText } from './format.js';

export const THREAD_STATE_ORDER = ['waiting_you', 'running', 'idle'];
const ACTIVE_WORKER_STATES = ['queued', 'starting', 'running', 'recovering'];

export const isActiveWorker = (worker) => ACTIVE_WORKER_STATES.includes(worker.state);

// Bound PR decisions only accept their dedicated buttons, never a composer answer.
// Use the durable card identity so this also covers cards saved before the copy fix.
export const canAnswerCard = (card, cardId, open) => open && card.kind === 'question' && !cardId.startsWith('prwatchapproval:');

export function threadMatches(thread, query) {
  const needle = String(query ?? '').trim().toLowerCase();
  if (needle === '') return true;
  const haystack = [
    thread.title, thread.goal, thread.summary, thread.machine, ...thread.repos,
    ...thread.workers.flatMap((worker) => [worker.agent, worker.machine, worker.branch]),
  ];
  return haystack.filter(Boolean).join('\n').toLowerCase().includes(needle);
}

/** Threads grouped for the sidebar: waiting on the owner first, then running, then idle, then archived. */
export function groupThreads(threads, query) {
  const shown = threads.filter((thread) => threadMatches(thread, query));
  const active = shown.filter((thread) => !thread.archived);
  const archived = shown.filter((thread) => Boolean(thread.archived));
  const groups = THREAD_STATE_ORDER
    .map((state) => ({ state, threads: active.filter((thread) => thread.state === state) }))
    .filter((group) => group.threads.length > 0);
  if (archived.length > 0) groups.push({ state: 'archived', threads: archived });
  return groups;
}

/** Messages belonging to a thread, or everything when no thread is selected. */
export const messagesFor = (messages, threadId) => (threadId ? messages.filter((message) => message.threadId === threadId) : messages);

/**
 * The owner's sent-but-unconfirmed messages, shown right away. The server names a web message
 * `user:web:<request id>`, so once the snapshot contains it the pending copy disappears by id.
 * Pending messages are the newest by definition: they go last whatever the clocks say.
 */
export function withPending(messages, pending) {
  const known = new Set(messages.map((message) => message.id));
  const extra = [...pending.values()]
    .map((entry) => ({ id: `user:web:${entry.id}`, role: 'user', channel: 'web', at: entry.at, threadId: entry.threadId ?? null, text: entry.text, pending: entry.status }))
    .filter((message) => !known.has(message.id));
  return [...messages, ...extra];
}

/** Messages grouped under one divider per local calendar day. */
export function groupByDay(messages, dayKeyOf) {
  const groups = [];
  for (const message of messages) {
    const key = dayKeyOf(message.at);
    const last = groups[groups.length - 1];
    if (last?.key === key) last.messages.push(message);
    else groups.push({ key, at: message.at, messages: [message] });
  }
  return groups;
}

export function workOn(snapshot, machine) {
  return snapshot.threads.filter((thread) => thread.workers.some((worker) => isActiveWorker(worker) && worker.machine === machine.name));
}

export function summarize(snapshot) {
  const machines = snapshot.machines.filter((machine) => !machine.revoked);
  return {
    machinesTotal: machines.length,
    machinesOnline: machines.filter((machine) => machine.online).length,
    running: snapshot.threads.filter((thread) => !thread.archived && thread.state === 'running').length,
    needs: snapshot.attention.length,
  };
}

export const attentionFor = (snapshot, threadId) => snapshot.attention.filter((item) => item.threadId === threadId);

/** One line for the sidebar: the latest thing said in the thread, else its summary or goal. */
export function previewOf(thread, messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.threadId !== thread.id) continue;
    const text = message.text ?? message.card?.title ?? message.card?.body?.[0];
    if (text) return plainText(text);
  }
  return plainText(thread.summary ?? thread.goal ?? '');
}

/** Open messages that ask for a decision, newest last. */
export const openCards = (messages) => messages.filter((message) => message.card && message.open);

/** The model id the Settings draft should carry after its provider changed (issue #74): the
 *  current id when the new provider's catalog has it, else its first model. `null` means the
 *  provider is not in the catalog (custom free text) — leave the field as typed. */
export function modelAfterProviderChange(providers, provider, currentModelId) {
  const entry = (providers ?? []).find((candidate) => candidate.id === provider);
  if (!entry) return null;
  if (entry.models.some((model) => model.id === currentModelId)) return currentModelId;
  return entry.models[0]?.id ?? null;
}

/** Open worker requests the composer can answer: cards with something to reply to. */
export const replyTarget = (snapshot, cardId) => snapshot.attention.find((item) => item.id === cardId) ?? null;

// ---- copy tables: which interface string a piece of server data maps to ---------------------------

/** Card buttons whose meaning is fixed by the system (the template labels are Chinese). */
export const ACTION_KEYS = {
  pr_approve: 'actionApprove', pr_decline: 'actionDecline', wait_online: 'actionWait', switch_machine: 'actionSwitch', cancel: 'actionCancel',
  routine_accept: 'actionRoutineAccept', routine_decline: 'actionRoutineDecline', note_archive: 'actionArchive', note_keep: 'actionKeep',
  note_confirm: 'actionNoteConfirm', note_remove: 'actionNoteRemove',
  skill_offer_accept: 'actionSkillOfferAccept', skill_offer_decline: 'actionSkillOfferDecline',
};

/** Fixed titles of the system's own cards. */
export const KNOWN_TITLES = {
  '需要你拍板': 'titleDecision',
  '一条记忆很久没用了': 'titleMemory',
  '要把这个变成例行任务吗？': 'titleRoutine',
  '记住这条项目观察吗？': 'titleNoteConfirm',
  '要把这次排障套路存成仓库技能吗？': 'titleSkillOffer',
};

/** Full-screen states: [title, body]. */
export const FATAL_COPY = {
  signed_out: ['sessionExpiredTitle', 'sessionExpiredBody'],
  logged_out: ['signedOutTitle', 'signedOut'],
  unreachable: ['loadFailedTitle', 'loadFailedBody'],
};

/** Missing model credentials block first use; passkeys are an optional first-run step. */
export function initialSetupStep(settings, hasConversation, securitySkipped) {
  if (!settings.model?.apiKey) return 'model';
  if (!settings.passkeys.length && !hasConversation && !securitySkipped) return 'security';
  return null;
}

/** Preserve a compatible choice; otherwise use the model's advertised default. */
export function thinkingAfterModelChange(model, current = 'off') {
  return model?.thinkingLevels?.includes(current) ? current : model?.defaultThinkingLevel ?? 'off';
}

/** Report only a server adjustment to the requested tier, not an intentional tier change. */
export function thinkingAdjusted(requested, next) {
  return Boolean(next) && requested?.thinkingLevel !== next.thinkingLevel;
}

/** The copy key for a reason a save did not activate (issue #70). The server reports the same
 *  vocabulary as the manual connection test, so the cause reads the same wherever it appears. */
export function modelRejectionKey(testError) {
  return `modelTest_${testError || 'provider_error'}`;
}

/** Only configured providers belong in the chat's model menu. */
export function availableChatModels(settings) {
  return (settings?.providers ?? []).filter((provider) => settings.keyedProviders.includes(provider.id));
}

export const DIFF_ERROR_KEYS = {
  machine_offline: 'diffErr_machine_offline',
  no_worktree: 'diffErr_no_worktree',
  not_git_repo: 'diffErr_not_git_repo',
  unsupported: 'diffErr_unsupported',
  diff_timeout: 'diffErr_diff_timeout',
  busy: 'diffErr_busy',
};

export const WORKTREE_STATUS_KEYS = {
  cleaning: 'worktreeCleaning',
  cleaned: 'worktreeCleaned',
  cleanup_blocked: 'worktreeBlocked',
};

export function diffErrorKey(code) {
  return DIFF_ERROR_KEYS[code] ?? 'diffErr_failed';
}

export function canInspectWorkerDiff(worker) {
  return Boolean(worker?.branch || worker?.git || (worker?.worktreeStatus && worker.worktreeStatus !== 'none'));
}

function unquoteGitPath(raw) {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"')) return trimmed;
  const inner = trimmed.slice(1, -1);
  const bytes = [];
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === '\\' && i + 1 < inner.length) {
      const oct = inner.slice(i + 1, i + 4);
      if (/^[0-7]{3}$/.test(oct)) { bytes.push(parseInt(oct, 8)); i += 3; continue; }
      const esc = { n: 10, t: 9, r: 13, '"': 34, '\\': 92 }[inner[i + 1]];
      bytes.push(esc ?? inner.charCodeAt(i + 1));
      i += 1;
    } else {
      for (const byte of new TextEncoder().encode(inner[i])) bytes.push(byte);
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** Splits a multi-file unified git patch into a Map of file path -> file patch text. */
export function splitPatchByFile(patch) {
  const map = new Map();
  if (!patch) return map;
  for (const chunk of String(patch).split(/(?=^diff --git )/m)) {
    if (!chunk.startsWith('diff --git ')) continue;
    let aPath = null;
    let bPath = null;
    for (const line of chunk.split('\n')) {
      if (line.startsWith('@@ ')) break;
      if (line.startsWith('--- ') && line !== '--- /dev/null') aPath = unquoteGitPath(line.slice(4)).replace(/^a\//, '');
      else if (line.startsWith('+++ ') && line !== '+++ /dev/null') bPath = unquoteGitPath(line.slice(4)).replace(/^b\//, '');
    }
    const headerMatch = !bPath && !aPath ? /^diff --git a\/(.+?) b\/(.+)$/m.exec(chunk) : null;
    const key = bPath ?? aPath ?? (headerMatch ? unquoteGitPath(headerMatch[2]) : null);
    if (key) map.set(key, chunk.trimEnd());
  }
  return map;
}

/** Parses unified diff text into plain line descriptors for safe DOM rendering without HTML sinks. */
export function parseDiffLines(patch, maxLines = 1200) {
  const text = String(patch ?? '').replace(/\n$/, '');
  if (!text) return { lines: [], truncated: false, totalLines: 0 };
  const rawLines = text.split('\n');
  const lines = [];
  let oldCursor = 0;
  let newCursor = 0;
  let inHunk = false;
  const limit = Math.min(rawLines.length, maxLines);
  for (let i = 0; i < limit; i++) {
    const line = rawLines[i];
    if (line.startsWith('diff --git ')) {
      inHunk = false;
      lines.push({ kind: 'meta', text: line, oldLine: null, newLine: null });
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      oldCursor = Number(hunk[1]);
      newCursor = Number(hunk[2]);
      inHunk = true;
      lines.push({ kind: 'hunk', text: line, oldLine: null, newLine: null });
    } else if (!inHunk || line.startsWith('\\')) {
      lines.push({ kind: 'meta', text: line, oldLine: null, newLine: null });
    } else if (line.startsWith('+')) {
      lines.push({ kind: 'add', text: line, oldLine: null, newLine: newCursor++ });
    } else if (line.startsWith('-')) {
      lines.push({ kind: 'del', text: line, oldLine: oldCursor++, newLine: null });
    } else {
      lines.push({ kind: 'context', text: line, oldLine: oldCursor++, newLine: newCursor++ });
    }
  }
  return { lines, truncated: rawLines.length > maxLines, totalLines: rawLines.length };
}

// Evaluator-only overlay. No production tools, routing labels, score(), or thresholds change.
import type { Message, ModelThinkingLevel } from '@earendil-works/pi-ai';
import type { Models } from '@earendil-works/pi-ai/models';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { Harness, MemoryStorage, createRegistry, type ModelRef } from '@earendil-works/pi-durable';
import { buildStewardExtension } from '../src/llm/extension.ts';
import type { PrEvidenceMode } from '../src/pr-evidence.ts';
import { PrWatchService } from '../src/pr-watch.ts';
import { buildEvalContext, openSeededLedger, type Observation } from './harness.ts';

export const PR = 'https://github.com/example/otto-demo/pull/12';
export const THREAD = 't_gw_refactor';
const OTHER_THREAD = 't_gw_logs';
type Association = { threadId: string; url: string; activeId?: string };
type Expected =
  | { kind: 'create'; mode: PrEvidenceMode }
  | { kind: 'list' } | { kind: 'cancel' } | { kind: 'ask' }
  | { kind: 'refusal' } | { kind: 'one-shot' };
export interface IntentCase {
  id: number;
  text: string;
  routedThreadId: string | null;
  associations: Association[];
  expected: Expected;
  failCreate?: boolean;
}
const linked: Association[] = [{ threadId: THREAD, url: PR }];
export const INTENT_CASES: IntentCase[] = [
  { id: 1, text: `以后帮我盯 ${PR} 的 CI，有变化提醒我。`, routedThreadId: null, expected: { kind: 'create', mode: 'checks-and-statuses' } },
  { id: 2, text: '这个 PR 后面有变动就提醒我。', expected: { kind: 'create', mode: 'checks-and-statuses' } },
  { id: 3, text: '持续盯住 PR 12，只看 commit statuses，Checks 不用管，有变化提醒我。', expected: { kind: 'create', mode: 'statuses-only' } },
  { id: 4, text: '现在都在盯哪些 PR？', expected: { kind: 'list' } },
  { id: 5, text: 'PR 12 不用盯了。', associations: [{ threadId: THREAD, url: PR, activeId: 'pw_x' }, { threadId: OTHER_THREAD, url: 'https://github.com/example/otto-demo/pull/13', activeId: 'pw_other' }], expected: { kind: 'cancel' } },
  { id: 6, text: '帮我盯着 gateway 那个 PR。', routedThreadId: null, associations: [], expected: { kind: 'ask' } },
  { id: 7, text: '盯一下那个 PR，权限不行就用 statuses 凑合。', expected: { kind: 'ask' } },
  { id: 8, text: `持续盯 ${PR}，有变化提醒我。`, routedThreadId: null, associations: [...linked, { threadId: OTHER_THREAD, url: PR }], expected: { kind: 'ask' } },
  // Backend refusal is injected, not an instruction that teaches the model which tool to choose.
  { id: 9, text: `持续盯 ${PR} 的 CI，有变化提醒我。`, failCreate: true, expected: { kind: 'refusal' } },
  { id: 10, text: '持续盯住 PR 12 的 CI 和 commit statuses，有变化提醒我。', expected: { kind: 'create', mode: 'checks-and-statuses' } },
  { id: 11, text: `现在帮我看下 ${PR} 的 CI，只查这一次，不要创建持续跟进或定时任务。`, expected: { kind: 'one-shot' } },
  { id: 12, text: '现在只看一次 PR 12 的 commit statuses，不要持续跟进。', expected: { kind: 'one-shot' } },
].map(c => ({ routedThreadId: THREAD, associations: linked, ...c }) as IntentCase);

export interface ToolObservation {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  result?: { isError: boolean; text: string };
}
export interface IntentObservation {
  toolCalls: ToolObservation[];
  issues: string[];
}
/** Read actual transcript boundaries, not service stubs: blocked/invalid attempts remain visible.
 * Array order is model call order, not a claim about parallel execution order. Text mentioning a
 * tool is not a call. Do not use a compacted/truncated context as complete measurement evidence.
 */
export function observeIntentCalls(messages: readonly Message[]): IntentObservation {
  const toolCalls: ToolObservation[] = [];
  const issues: string[] = [];
  const byId = new Map<string, ToolObservation>();
  for (const message of messages) {
    if (message.role === 'assistant') for (const part of message.content) {
      if (part.type !== 'toolCall') continue;
      const call = { id: part.id, name: part.name, arguments: structuredClone(part.arguments) };
      if (byId.has(call.id)) issues.push(`duplicate call id: ${call.id}`);
      else byId.set(call.id, call);
      toolCalls.push(call);
    }
    if (message.role === 'toolResult') {
      const call = byId.get(message.toolCallId);
      if (!call || call.name !== message.toolName || call.result) { issues.push(`unmatched result: ${message.toolCallId}`); continue; }
      call.result = { isError: message.isError, text: message.content.flatMap(p => p.type === 'text' ? [p.text] : []).join('\n') };
      if (message.nestedCalls?.calls.length || message.nestedCalls?.complete === false) issues.push(`nested calls require separate inspection: ${message.toolCallId}`);
    }
  }
  for (const call of toolCalls) if (!call.result) issues.push(`missing result: ${call.id}`);
  return { toolCalls, issues };
}

export type IntentVerdict = 'pass' | 'wrong_tool' | 'missed_ask' | 'unnecessary_ask' | 'scope_mismatch' | 'unexpected_persistence' | 'not_verified' | 'refusal_observed' | 'incomplete';
const READS = new Set(['situation', 'find_threads', 'get_thread', 'list_pr_watches']);
const FALLBACK = new Set(['start_worker', 'send_to_worker', 'set_followup', 'create_routine', 'suggest_routine']);
export function scoreIntent(c: IntentCase, observation: IntentObservation): IntentVerdict {
  if (observation.issues.length || observation.toolCalls.some(call => !call.result)) return 'incomplete';
  const calls = observation.toolCalls;
  const success = (name: string) => calls.filter(t => t.name === name && t.result?.isError === false);
  if (c.expected.kind === 'one-shot') {
    if (calls.some(t => t.name === 'send_to_worker')) return 'wrong_tool';
    if (calls.some(t => !READS.has(t.name) && !['start_worker', 'ask_user'].includes(t.name))) return 'unexpected_persistence';
    const starts = calls.filter(t => t.name === 'start_worker');
    if (starts.length > 1 || starts.some(t => t.arguments.mode !== 'readonly')) return 'wrong_tool';
    // Only verifies the one-shot delegation boundary, NOT that real CI evidence was fetched.
    return success('start_worker').length === 1 ? 'pass' : 'not_verified';
  }
  // A blocked fallback still means the model chose the wrong tool; report its error separately.
  if (calls.some(t => FALLBACK.has(t.name))) return 'wrong_tool';
  const allowed = new Set([...READS, 'ask_user', ...(c.expected.kind === 'create' || c.expected.kind === 'refusal' ? ['create_pr_watch'] : []), ...(c.expected.kind === 'cancel' ? ['cancel_pr_watch'] : [])]);
  if (calls.some(t => !allowed.has(t.name))) return c.expected.kind === 'ask' && calls.some(t => t.name === 'create_pr_watch') ? 'missed_ask' : 'wrong_tool';
  if (c.expected.kind === 'ask') return success('ask_user').length ? 'pass' : 'missed_ask';
  if (c.expected.kind === 'refusal') {
    const attempts = calls.filter(t => t.name === 'create_pr_watch');
    if (attempts.some(t => t.arguments.evidenceMode !== 'checks-and-statuses')) return 'scope_mismatch';
    if (attempts.some(t => t.arguments.threadId !== THREAD || (t.arguments.url !== undefined && t.arguments.url !== PR))) return 'wrong_tool';
    if (attempts.length !== 1 || !attempts[0]!.result?.isError) return 'not_verified';
    // Tool refusal proves neither truthful prose nor functional success. Human review is required.
    return success('ask_user').length ? 'pass' : 'refusal_observed';
  }
  if (success('ask_user').length) return 'unnecessary_ask';
  if (c.expected.kind === 'list') return success('list_pr_watches').length ? 'pass' : 'not_verified';
  if (c.expected.kind === 'cancel') {
    const attempts = calls.filter(t => t.name === 'cancel_pr_watch');
    return attempts.length === 1 && attempts[0]!.arguments.watchId === 'pw_x' && attempts[0]!.result?.isError === false ? 'pass' : 'not_verified';
  }
  const creates = calls.filter(t => t.name === 'create_pr_watch');
  const expectedMode = c.expected.mode;
  if (creates.some(t => t.arguments.evidenceMode !== expectedMode)) return 'scope_mismatch';
  if (creates.length !== 1 || !creates[0]!.result || creates[0]!.result.isError) return 'not_verified';
  const args = creates[0]!.arguments;
  return args.threadId === THREAD && (args.url === undefined || args.url === PR) ? 'pass' : 'wrong_tool';
}

/** Explicit caller-supplied models only. No auth-store/env fallback, CLI or paid default. */
export async function runIntentCase(c: IntentCase, models: Models, agent: { model: ModelRef; thinkingLevel: ModelThinkingLevel }) {
  const { ledger, sql } = openSeededLedger(Date.now());
  const effects: Observation = { asks: [], dispatches: [] };
  const ctx = buildEvalContext(ledger, 10_000 + c.id, effects);
  // Use the REAL deterministic backend over the isolated in-memory ledger. No scheduler
  // or tick is installed; any accidental network/notification attempt fails, never goes live.
  const watches = new PrWatchService({ sql, tx: fn => fn(), threadExists: id => !!ledger.threads.get(id),
    notify: async () => { throw new Error('eval forbids outbound notices'); },
    read: async () => { throw new Error('eval forbids GitHub reads'); },
  });
  for (const [i, association] of c.associations.entries()) {
    const id = association.activeId ?? `history_${i}`;
    watches.create({ id, threadId: association.threadId, url: association.url, evidenceMode: 'checks-and-statuses' });
    if (!association.activeId) sql`UPDATE sh_pr_watch SET status = 'completed' WHERE id = ${id}`;
  }
  ctx.currentRun = async () => ({ operationId: `user:eval_${10_000 + c.id}`, kind: 'user', provenance: `user:eval_${10_000 + c.id}`, routedThreadId: c.routedThreadId });
  ctx.ownerMessageText = async () => c.text;
  ctx.prWatches = {
    list: () => watches.list(),
    targetsForThread: id => watches.targetsForThread(id),
    threadsForUrl: url => watches.threadsForUrl(url),
    create: async input => {
      if (c.failCreate) throw new Error('injected backend refusal');
      return watches.create(input);
    },
    cancel: id => watches.cancel(id),
  };
  const registry = createRegistry();
  registry.install(buildStewardExtension(ctx));
  const harness = await Harness.open(new MemoryStorage(), { models, registry, settings: { compaction: { enabled: false } } }, BACKGROUND_CONTEXT);
  try {
    const conversation = await harness.root(BACKGROUND_CONTEXT, { agent });
    const settled = await (await conversation.submit({ type: 'input', content: c.text }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
    const { messages } = await conversation.context(BACKGROUND_CONTEXT);
    const observation = observeIntentCalls(messages);
    if (settled.status !== 'done') observation.issues.push('submission did not finish');
    const reply = messages.filter(m => m.role === 'assistant').flatMap(m => m.content.flatMap(p => p.type === 'text' ? [p.text] : [])).join('\n');
    return { caseId: c.id, observation, verdict: scoreIntent(c, observation), reply, watches: watches.list(), effects };
  } finally { await harness.close(BACKGROUND_CONTEXT); }
}

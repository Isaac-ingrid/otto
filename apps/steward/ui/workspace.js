// The Otto web workspace: one continuous conversation, the threads behind it, and the decisions
// waiting for the owner. This file is the view and the wiring; what to show is decided by the
// pure helpers in model.js, format.js and thread-frames.js. Data comes from /app/api/workspace;
// the WebSocket then either hands over the open Thread's own rows (`thread_events`/`thread_state`,
// protocol §6.9) or says "something changed" and the page refetches in the background.
//
// Everything on screen is built with h() (dom.js) from text nodes: nothing a message, an agent
// or a repository contains is ever parsed as HTML.
import { h, icon, paintIcons, providerIcon } from './dom.js';
import { applyStatic, getLocale, localeTag, setLocale, t, tOr } from './i18n.js';
import { dayKey, formatClock, formatDay, formatRelative, formatUsd, trimOpenMarkup } from './format.js';
import { modelPicker } from './model-picker.js';
import { markup } from './markup.js';
import { createCheckpointModal } from './checkpoint.js';
import { controlPlaneCounts, createControlPlane } from './control-plane.js';
import { applyThreadState, lastTimelineId, mergeTimeline } from './thread-frames.js';
import { mountSessionViewer } from './session.js';
import {
  ACTION_KEYS, FATAL_COPY, KNOWN_TITLES, WORKTREE_STATUS_KEYS, attentionFor, availableChatModels, canAnswerCard, canInspectWorkerDiff, diffErrorKey, groupByDay, groupThreads, isActiveWorker, initialSetupStep, messagesFor, modelAfterProviderChange, modelRejectionKey, parseDiffLines, previewOf, splitPatchByFile, summarize, thinkingAdjusted, thinkingAfterModelChange, withPending, workOn,
} from './model.js';

const $ = (selector) => document.querySelector(selector);
const cap = (word) => word.charAt(0).toUpperCase() + word.slice(1);
const uuid = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
const detailsMedia = matchMedia('(max-width: 1180px)');
let detailsOverlay = null;

const state = {
  snapshot: null,
  csrf: '',
  selected: null,
  filter: '',
  pending: new Map(), // request id -> { id, text, threadId, replyTo, at, status: 'sending' | 'failed' }
  busyCards: new Set(),
  replyTo: null, // outbound id of the card the composer is answering
  drafts: new Map(),
  dialog: null,
  connection: 'connecting',
  fatal: null, // 'signed_out' | 'logged_out' | 'unreachable'
  knownAttention: new Set(),
  live: null, // the reply Otto is writing right now: { text, threadId, ending }
  skew: 0, // server clock minus this browser's clock, so relative times agree with the server's timestamps
  session: null, // within the selected thread: the worker whose recorded session fills the main pane
  viewer: null, // { workerId, handle } while that pane is mounted
  settings: null, // { model, passkeys } from /app/api/settings
  modelDraft: null, // { provider, modelId, baseUrl, apiKey } being typed; kept out of the dialog's redraw signature
  passkeyLabelDraft: '', // ditto, for the new-passkey label field
  directoryForms: new Map(),
  setupChecked: false,
  initialDialog: null,
  settingsError: false,
  pushSubscription: null,
  pushBusy: false,
  pushAction: null, // the data-action of the control that is waiting, so its label can say so
  pushNotice: null, // i18n key of the last push result, shown inside the dialog the toast cannot reach
  pushQuiet: true,
  changingModel: false,
  savingAgentModel: false,
  agentModelNotice: null,
  refreshingAgentModels: false,
  modelDraftNotice: null, // lifecycle feedback belongs inside the settings modal, not behind it
  stopping: false, // a stop request is in flight (ADR-0017): the button stays put and disabled
  onboarding: null, // { step: 'model' | 'security', passkeyAdd, confirm }
  showArchived: false,
  archivingThreads: new Set(),
  workerDiffs: new Map(),
  diffRev: 0,
};

// ---- small pieces ---------------------------------------------------------------------------------

const threadById = (id) => state.snapshot?.threads.find((thread) => thread.id === id) ?? null;
const serverNow = () => Date.now() + state.skew;
const dayLabel = (ts) => formatDay(ts, serverNow(), localeTag(), { today: t('today'), yesterday: t('yesterday') });
const ago = (ts) => formatRelative(ts, serverNow(), localeTag(), t('justNow'));
const stateLabel = (value) => t({ waiting_you: 'needsYou', running: 'running', idle: 'idle', archived: 'archived' }[value] ?? 'idle');
const stateColor = (value) => ({ waiting_you: 'amber', running: 'green', idle: 'gray', archived: 'gray' }[value] ?? 'gray');
const stateClass = (value) => ({ waiting_you: 'waiting', running: 'running', idle: 'idle', archived: 'archived' }[value] ?? 'idle');
const working = () => state.snapshot.busy || [...state.pending.values()].some((entry) => entry.status === 'sending');

/**
 * Redraws a region only when what it shows changed. A refresh that changes nothing then keeps
 * the reader's text selection, scroll position and focus exactly as they were.
 */
const drawn = new Map();
function redraw(region, signature, draw) {
  const next = JSON.stringify(signature);
  if (drawn.get(region) === next) return false;
  drawn.set(region, next);
  draw();
  return true;
}
/** Relative times ("5 min. ago") go stale; regions that show them are redrawn at least this often. */
const minuteBucket = () => Math.floor(Date.now() / 30_000);

function toast(text) {
  const node = $('#toast');
  node.textContent = text;
  node.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { node.hidden = true; }, 3600);
}

/** Keeps keyboard focus on "the same" control across a re-render (items carry data-focus keys). */
function preservingFocus(container, render) {
  const active = document.activeElement;
  const key = active && container.contains(active) ? active.dataset?.focus : null;
  render();
  if (key) container.querySelector(`[data-focus="${CSS.escape(key)}"]`)?.focus({ preventScroll: true });
}

function stateBadge(value) {
  return h('span', { class: `state-badge ${stateClass(value)}` }, h('span', { class: `status-dot ${stateColor(value)}` }), stateLabel(value));
}

// ---- cards ----------------------------------------------------------------------------------------------

const KIND_ICONS = { question: 'help', consent: 'branch', offline: 'monitor', offer: 'repeat', memory: 'memory' };

function buttonLabel(button) {
  const action = button.action ?? '';
  if (action.startsWith('asknew:')) return t('actionNew');
  if (action === 'switch_machine') {
    const names = /^换台机器（(.+)）$/.exec(button.label)?.[1];
    return names ? t('actionSwitchTo', { names }) : t('actionSwitch');
  }
  return ACTION_KEYS[action] ? t(ACTION_KEYS[action]) : button.label;
}

const cardTitle = (card) => (KNOWN_TITLES[card.title] ? t(KNOWN_TITLES[card.title]) : card.title);
const cardHeading = (card) => cardTitle(card) || card.body[0] || t(`kind${cap(card.kind)}`);

function cardNode(card, cardId, open) {
  const busy = state.busyCards.has(cardId);
  const actions = card.buttons.map((button) => {
    const label = buttonLabel(button);
    const className = `button${button.primary ? ' primary' : ''}`;
    if (button.url) return h('a', { class: className, href: button.url, target: '_blank', rel: 'noopener noreferrer' }, label, icon('external'));
    if (!open) return null;
    return h('button', {
      type: 'button', class: className, dataset: { card: cardId, action: button.action, focus: `card:${cardId}:${button.action}` },
      'aria-busy': busy ? 'true' : null, disabled: busy ? true : null,
    }, label);
  }).filter(Boolean);
  const canAnswer = canAnswerCard(card, cardId, open);
  return h('div', { class: `card${open ? ' is-open' : ''}`, dataset: { tone: card.tone, kind: card.kind } },
    h('div', { class: 'card-kind' }, icon(KIND_ICONS[card.kind]), t(`kind${cap(card.kind)}`)),
    cardTitle(card) ? h('h3', { class: 'card-title' }, cardTitle(card)) : null,
    card.body.length ? h('div', { class: 'card-body' }, card.body.map(markup)) : null,
    actions.length || canAnswer ? h('div', { class: 'card-actions' }, actions,
      canAnswer ? h('button', { type: 'button', class: 'button quiet', dataset: { reply: cardId, focus: `reply:${cardId}` } }, t('answer')) : null) : null,
    busy ? h('div', { class: 'card-busy' }, t('cardWorking')) : null,
    !open ? h('div', { class: 'card-state' }, icon('check'), t('cardHandled')) : null,
    card.note ? h('p', { class: 'card-note' }, card.note) : null);
}

// ---- the top bar and the sidebar ---------------------------------------------------------------

function renderTop() {
  const snapshot = state.snapshot;
  const summary = summarize(snapshot);
  $('#machine-summary').textContent = `${summary.machinesOnline} / ${summary.machinesTotal}`;
  $('#machine-dot').className = `status-dot ${summary.machinesTotal === 0 ? 'gray' : summary.machinesOnline > 0 ? 'green' : 'amber'}`;
  $('#running-count').textContent = String(summary.running);
  $('#running-dot').className = `status-dot ${summary.running ? 'green pulse' : 'gray'}`;
  $('#waiting-count').textContent = t(summary.needs === 1 ? 'decisionCountOne' : 'decisionCount', { count: summary.needs });
  $('.waiting-status').classList.toggle('all-clear', summary.needs === 0);
  const cpCounts = controlPlaneCounts(snapshot.controlPlaneSummary);
  $('#control-count').textContent = String(cpCounts.activeAuto);
  $('#control-dot').className = `status-dot ${cpCounts.attentionCount > 0 ? 'amber' : cpCounts.activeAuto > 0 ? 'green' : 'gray'}`;
  $('.control-status').title = t('controlPlaneTooltip', { used: cpCounts.residentUsed, cap: cpCounts.residentCap, auto: cpCounts.activeAuto });
  const sidebarCp = $('#sidebar-control-count');
  if (sidebarCp) sidebarCp.textContent = cpCounts.activeAuto > 0 ? ` · ${cpCounts.activeAuto}` : '';
  const mobile = $('#mobile-count');
  const waitingThreads = snapshot.threads.filter((thread) => thread.state === 'waiting_you').length;
  mobile.textContent = String(waitingThreads);
  mobile.parentElement.setAttribute('aria-label', t('threadsNeedYou', { count: waitingThreads }));
  mobile.hidden = waitingThreads === 0;
  const spend = $('#spend');
  spend.hidden = false;
  spend.classList.toggle('over', snapshot.budget.over);
  spend.title = snapshot.budget.over ? t('overBudget') : t('spendTitle', { limit: formatUsd(snapshot.budget.limitUsd) });
  $('#spend-value').textContent = formatUsd(snapshot.budget.costUsd);
  document.title = `${summary.needs ? `(${summary.needs}) ` : ''}${t('workspaceTitle')}`;
}

function renderConnection() {
  $('#connection').dataset.state = state.connection;
  $('#connection-label').textContent = t(state.connection === 'live' ? 'live' : state.connection);
}

function renderSidebar() {
  const snapshot = state.snapshot;
  const list = $('#thread-list');
  const archivedCount = snapshot.archivedCount ?? 0;
  const rows = snapshot.threads.map((thread) => [thread.id, thread.title, thread.state, Boolean(thread.archived), thread.unread, thread.lastActivityAt, thread.machine, thread.workers.map((worker) => worker.agent), previewOf(thread, snapshot.messages)]);
  redraw('threads', [getLocale(), state.filter, state.selected, state.showArchived, archivedCount, rows, minuteBucket()], () => preservingFocus(list, () => {
    const groups = groupThreads(snapshot.threads, state.filter);
    const archivedToggle = archivedCount > 0 || state.showArchived
      ? h('div', { class: 'archived-toggle-wrap' }, h('button', {
        type: 'button', class: 'archived-toggle', 'aria-pressed': String(state.showArchived),
        dataset: { action: 'toggle-archived', focus: 'toggle-archived' },
      }, h('span', null, icon('archive'), ' ', t('showArchived', { count: archivedCount })), icon(state.showArchived ? 'chevron-down' : 'chevron-right')))
      : null;
    if (groups.length === 0) {
      const searching = state.filter.trim() !== '';
      list.replaceChildren(...[h('div', { class: 'empty-state' }, icon(searching ? 'search' : 'layers'),
        h('strong', null, t(searching ? 'noResults' : 'noThreads')), h('p', null, t(searching ? 'searchHint' : 'noThreadsHelp')),
        searching ? h('button', { type: 'button', class: 'button', dataset: { action: 'clear-search' } }, t('clearSearch')) : null), archivedToggle].filter(Boolean));
      return;
    }
    list.replaceChildren(...groups.map((group) => h('section', { class: 'thread-group' },
      h('h2', { class: 'group-label' }, h('span', { class: `status-dot ${stateColor(group.state)}` }), stateLabel(group.state), h('span', { class: 'group-count' }, t(group.threads.length === 1 ? 'threadCountOne' : 'threadCount', { count: group.threads.length }))),
      group.threads.map((thread) => {
        const active = state.selected === thread.id;
        const meta = [[...new Set(thread.workers.map((worker) => worker.agent))].join(', '), thread.machine].filter(Boolean).join(' · ');
        return h('a', {
          class: `thread-item${active ? ' active' : ''}`, href: `/app/threads/${thread.id}`, dataset: { nav: thread.id, focus: `thread:${thread.id}` },
          'aria-current': active ? 'page' : null,
        },
        h('div', { class: 'thread-title' }, h('span', null, thread.title), thread.unread ? h('span', { class: 'unread', 'aria-label': t('unread') }) : null),
        h('div', { class: 'thread-preview' }, previewOf(thread, snapshot.messages)),
        h('div', { class: 'thread-meta' }, h('span', { title: meta }, meta), h('span', null, ago(thread.lastActivityAt))));
      }))), ...(archivedToggle ? [archivedToggle] : []));
  }));
  $('.all-conversation').classList.toggle('active', !state.selected);
  if (state.selected) $('.all-conversation').removeAttribute('aria-current');
  else $('.all-conversation').setAttribute('aria-current', 'page');

  const summary = summarize(snapshot);
  $('#online-count').textContent = summary.machinesTotal ? t('machineCount', { count: summary.machinesOnline }) : '';
  const machines = snapshot.machines.filter((machine) => !machine.revoked);
  redraw('machines', [getLocale(), machines], () => $('#machine-list').replaceChildren(...(machines.length ? machines.map((machine) => h('button', {
    type: 'button', class: `machine-row${machine.online ? '' : ' offline'}`, dataset: { action: 'machines' },
    title: `${machine.name} · ${machine.online ? t('slots', { used: machine.slots?.running ?? 0, total: machine.slots?.max ?? 0 }) : t('offline')}`,
  }, icon('laptop'), h('span', null, machine.name),
  h('span', { class: 'slots' }, machine.online ? `${machine.slots?.running ?? 0} / ${machine.slots?.max ?? 0}` : t('offline')),
  h('span', { class: `status-dot ${machine.online ? 'green' : 'gray'}` }))) : [h('p', { class: 'muted-copy' }, t('noMachines'))])));
}

// ---- the conversation -----------------------------------------------------------------------------

function threadReference(threadId) {
  const thread = threadById(threadId);
  return thread ? h('a', { class: 'thread-reference', href: `/app/threads/${thread.id}`, dataset: { nav: thread.id } }, icon('layers'), thread.title) : null;
}

function userMessage(message) {
  const failed = message.pending === 'failed';
  const thread = state.selected ? null : threadById(message.threadId);
  return h('article', { class: `user-message${message.pending === 'sending' ? ' is-pending' : ''}${failed ? ' is-failed' : ''}`, id: message.id },
    h('div', { class: 'user-body' }, message.text),
    h('div', { class: 'user-meta' },
      `${t('you')} · ${formatClock(message.at)}${thread ? ` · ${thread.title}` : ''}`,
      message.channel === 'feishu' ? h('span', { class: 'channel-tag' }, t('viaFeishu')) : null,
      message.pending === 'sending' ? ` · ${t('sending')}` : null,
      failed ? [' · ', h('span', { class: 'failed' }, t('notSent')), h('button', { type: 'button', dataset: { retry: message.id.slice('user:web:'.length), focus: `retry:${message.id}` } }, t('retry'))] : null));
}

function assistantMessage(message) {
  return h('article', { class: 'message', id: message.id },
    h('div', { class: 'message-header' }, h('img', { class: 'agent-avatar', src: '/brand/otto.svg', width: 26, height: 26, alt: '' }), 'Otto', h('span', { class: 'message-time' }, formatClock(message.at))),
    h('div', { class: 'message-body' },
      state.selected ? null : threadReference(message.threadId),
      message.card ? cardNode(message.card, message.id, message.open === true) : markup(message.text ?? '')));
}

/** The reply being written, shown as it arrives; the finished message replaces it. */
function liveMessage(live) {
  return h('article', { class: 'message live', id: 'live-reply' },
    h('div', { class: 'message-header' }, h('img', { class: 'agent-avatar', src: '/brand/otto.svg', width: 26, height: 26, alt: '' }), 'Otto'),
    h('div', { class: 'message-body' }, markup(trimOpenMarkup(live.text)), h('span', { class: 'working-dots' }, h('i'), h('i'), h('i'))));
}

function workingNode() {
  const queued = [...state.pending.values()].filter((entry) => entry.status === 'sending').length;
  return h('div', { class: 'working', role: 'status' }, h('span', { class: 'working-dots' }, h('i'), h('i'), h('i')), h('span', { class: 'working-label' }, queued > 1 ? t('workingQueued', { count: queued - 1 }) : t('working')), h('button', { type: 'button', class: 'stop-turn', dataset: { action: 'stop-turn' }, disabled: state.stopping ? '' : null }, t(state.stopping ? 'stopping' : 'stopTurn')));
}

function renderFeed(stick) {
  const snapshot = state.snapshot;
  const feed = $('#feed');
  const thread = state.selected ? threadById(state.selected) : null;
  const titles = snapshot.threads.map((entry) => [entry.id, entry.title, entry.state, Boolean(entry.archived)]);
  const live = state.live && (!state.selected || state.live.threadId === state.selected) ? state.live : null;
  redraw('feed', [getLocale(), state.selected, snapshot.messages, snapshot.busy, state.stopping, [...state.pending.values()], [...state.busyCards], titles, dayKey(serverNow()), live?.text], () => {
    const nearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 40;
    const oldTop = feed.scrollTop;

    $('#conversation-title').textContent = thread ? thread.title : t('allMessages');
    $('#conversation-subtitle').textContent = thread
      ? [thread.repos.join(', '), [...new Set(thread.workers.map((worker) => worker.agent))].join(', '), thread.machine].filter(Boolean).join(' · ')
      : '';
    $('#conversation-subtitle').hidden = !$('#conversation-subtitle').textContent;
    for (const badge of document.querySelectorAll('.heading-line .state-badge')) badge.remove();
    if (thread) {
      $('.heading-line').append(stateBadge(thread.state));
      if (thread.archived) $('.heading-line').append(stateBadge('archived'));
    }
    const banner = $('#scope-banner');
    banner.hidden = !thread;
    banner.replaceChildren(...(thread ? [h('span', null, t('scopeNotice')), h('button', { type: 'button', dataset: { action: 'all' } }, `${t('backToAll')} ↗`)] : []));

    const messages = messagesFor(withPending(snapshot.messages, state.pending), state.selected);
    const body = [];
    if (messages.length === 0) {
      body.push(h('div', { class: 'empty-state' }, icon('chat'), h('strong', null, t(thread ? 'emptyThreadMessages' : 'emptyMessages')), h('p', null, t(thread ? 'emptyThreadHelp' : 'emptyMessagesHelp'))));
    }
    for (const group of groupByDay(messages, dayKey)) {
      body.push(h('div', { class: 'date-divider' }, dayLabel(group.at)));
      for (const message of group.messages) body.push(message.role === 'user' ? userMessage(message) : assistantMessage(message));
    }
    if (live) body.push(liveMessage(live));
    else if (working()) body.push(workingNode());

    preservingFocus(feed, () => feed.replaceChildren(h('div', { class: 'feed-inner' }, body)));
    feed.scrollTop = stick || nearBottom ? feed.scrollHeight : oldTop;
  });
}

// ---- the main pane: the conversation, or one worker's recorded session --------------------------------------

const agentName = (agent) => ({ pi: 'pi', 'claude-code': 'Claude Code', codex: 'Codex', antigravity: 'Antigravity' }[agent] ?? agent);

function urlFor(threadId, workerId) {
  return threadId ? `/app/threads/${threadId}${workerId ? `/workers/${workerId}` : ''}` : '/app';
}

function findWorker(workerId) {
  for (const thread of state.snapshot?.threads ?? []) {
    const worker = thread.workers.find((entry) => entry.id === workerId);
    if (worker) return worker;
  }
  return null;
}

function unmountViewer() {
  state.viewer?.handle.destroy();
  state.viewer = null;
}

/** Conversation | Agent sessions: the two ways to look at one thread. */
function viewTabs(thread, active) {
  return [
    h('button', { type: 'button', class: 'view-tab', dataset: { view: 'conversation', focus: 'view:conversation' }, 'aria-pressed': String(active === 'conversation') }, icon('chat'), t('tabConversation')),
    h('button', { type: 'button', class: 'view-tab', dataset: { view: 'sessions', focus: 'view:sessions' }, 'aria-pressed': String(active === 'sessions'), disabled: thread.workers.length ? null : true },
      icon('layers'), t('tabSessions'), thread.workers.length ? h('span', { class: 'view-count' }, String(thread.workers.length)) : null),
  ];
}

function renderTabs() {
  const thread = state.selected && !state.session ? threadById(state.selected) : null;
  const tabs = $('#view-tabs');
  redraw('tabs', [getLocale(), thread?.id ?? null, thread?.workers.length ?? 0], () => {
    tabs.hidden = !thread || thread.workers.length === 0;
    tabs.replaceChildren(...(thread ? viewTabs(thread, 'conversation') : []));
  });
}

const stateBadgeInline = (worker) => h('span', { class: 'worker-state' }, h('span', { class: `status-dot ${isActiveWorker(worker) ? 'green' : 'gray'}` }), tOr(`worker${cap(worker.state)}`, worker.state));

function renderSessionHeader(thread, worker) {
  const machine = worker.machine ?? '';
  redraw('session-header', [getLocale(), thread.id, thread.title, worker.id, worker.state, worker.branch, worker.createdAt, thread.workers.map((entry) => [entry.id, entry.state]), minuteBucket()], () => {
    $('#session-title').textContent = t('sessionTitle', { agent: agentName(worker.agent), machine });
    const subtitle = $('#session-subtitle');
    subtitle.replaceChildren(thread.title, ' · ', stateBadgeInline(worker));
    $('#session-tabs').replaceChildren(...viewTabs(thread, 'sessions'));
    const toolbar = $('#session-toolbar');
    const sessions = [...thread.workers].sort((a, b) => b.createdAt - a.createdAt);
    toolbar.hidden = sessions.length < 2;
    if (sessions.length < 2) {
      toolbar.replaceChildren();
      return;
    }
    const select = h('select', { id: 'session-picker', 'aria-label': t('sessionPicker') },
      sessions.map((entry) => h('option', { value: entry.id, selected: entry.id === worker.id ? true : null },
        [agentName(entry.agent), entry.machine, entry.branch, tOr(`worker${cap(entry.state)}`, entry.state), ago(entry.createdAt)].filter(Boolean).join(' · '))));
    select.addEventListener('change', () => go({ thread: thread.id, worker: select.value }));
    toolbar.replaceChildren(h('label', { class: 'session-picker', for: 'session-picker' }, h('span', null, t('sessionPicker')), select));
  });
}

function renderPane() {
  const thread = state.selected ? threadById(state.selected) : null;
  const worker = thread && state.session ? thread.workers.find((entry) => entry.id === state.session) ?? null : null;
  $('.conversation').hidden = Boolean(worker);
  $('#session-view').hidden = !worker;
  if (!worker) {
    unmountViewer();
    return;
  }
  renderSessionHeader(thread, worker);
  if (state.viewer?.workerId === worker.id) {
    state.viewer.handle.update();
    return;
  }
  unmountViewer();
  state.viewer = {
    workerId: worker.id,
    handle: mountSessionViewer($('#session-body'), {
      workerId: worker.id,
      agentLabel: agentName(worker.agent),
      isActive: () => {
        const live = findWorker(worker.id);
        return live ? isActiveWorker(live) : false;
      },
      isReachable: () => {
        const live = findWorker(worker.id);
        return Boolean(live && !live.unreachable && state.snapshot.machines.some((machine) => machine.name === live.machine && machine.online));
      },
    }),
  };
}

/** The first thing a new deployment needs: a model key, then a machine. One notice at a time. */
function renderSetup() {
  renderOnboarding();
  const banner = $('#setup-banner');
  const needsKey = state.settings !== null && !state.settings.model?.apiKey;
  const needsMachine = !needsKey && state.snapshot.machines.every((machine) => machine.revoked);
  const which = needsKey ? 'model' : needsMachine ? 'machine' : null;
  redraw('setup', [getLocale(), which], () => {
    banner.hidden = which === null;
    banner.classList.toggle('machine-hint', which === 'machine');
    const forKey = which === 'model';
    banner.replaceChildren(...(which === null ? [] : [
      icon(forKey ? 'shield' : 'laptop'),
      h('span', null, forKey ? t('setupModel') : t('setupMachine')),
      h('button', { type: 'button', class: forKey ? 'button primary' : 'text-button', dataset: { action: forKey ? 'account' : 'machines', focus: 'setup' } }, forKey ? t('setupModelAction') : t('setupMachineAction')),
    ]));
  });
}

// ---- the composer ---------------------------------------------------------------------------------------

function resizeInput() {
  const input = $('#message-input');
  input.rows = matchMedia('(max-width: 650px)').matches ? 1 : 2;
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 128)}px`;
}

function renderComposer() {
  renderComposerModels();
  const thread = state.selected ? threadById(state.selected) : null;
  const target = state.replyTo ? state.snapshot.attention.find((item) => item.id === state.replyTo) : null;
  if (state.replyTo && !target) state.replyTo = null; // the card was handled in the meantime
  $('#scope-label').textContent = thread ? t('scopedRoute', { title: thread.title }) : t('autoRoute');
  $('#scope-chip').title = thread ? thread.title : t('routeHelp');
  $('#scope-chip').classList.toggle('scoped', Boolean(thread));
  $('#message-input').placeholder = state.replyTo ? t('replyPlaceholder') : t(thread ? 'scopedPlaceholder' : 'inputPlaceholder');
  $('#composer-status').textContent = working() ? t('queueHelp') : t(thread ? 'scopeHelp' : 'routeHelp');
  const chip = $('#reply-chip');
  chip.hidden = !state.replyTo;
  chip.replaceChildren(...(target
    ? [icon('help'), h('span', null, t('replyingTo', { title: cardHeading(target) })), h('button', { type: 'button', dataset: { action: 'clear-reply' }, 'aria-label': t('clearReply'), title: t('clearReply') }, icon('close'))]
    : []));
}

function providerChoiceName(provider) {
  const info = provider.info;
  return [info?.familyName ?? provider.name, info?.plan ? t(`providerPlan_${info.plan}`) : '', info?.region ? t(`providerRegion_${info.region}`) : ''].filter(Boolean).join(' · ');
}

function renderComposerModels() {
  const node = $('#composer-model-controls');
  const model = state.settings?.model;
  const busy = state.changingModel || working();
  redraw('composer-model', [getLocale(), state.settings, busy], () => {
    if (!model?.apiKey) {
      // No usable key for the current selection. The control used to disappear, which reads as
      // "this has no settings"; it stays as the way into the same provider form instead.
      node.replaceChildren(h('button', { type: 'button', class: 'model-picker-trigger model-choice-chip', disabled: busy, dataset: { action: 'provider', provider: (state.settings?.providers ?? []).some((entry) => entry.id === model?.provider) ? model.provider : MODEL_CUSTOM } }, t('composerModelUnset')));
      return;
    }
    const verified = (provider, modelId) => (state.settings.verifiedModels ?? []).some((entry) => entry.provider === provider && entry.modelId === modelId);
    const entries = availableChatModels(state.settings).flatMap((provider) => provider.models.filter((entry) => verified(provider.id, entry.id)).map((entry) => ({
      ...entry, id: JSON.stringify([provider.id, entry.id]), modelId: entry.id, provider: provider.id, group: providerChoiceName(provider),
    })));
    for (const saved of state.settings.savedModels ?? []) {
      if (!verified(saved.provider, saved.modelId) || entries.some((entry) => entry.provider === saved.provider && entry.modelId === saved.modelId)) continue;
      entries.push({ id: JSON.stringify([saved.provider, saved.modelId]), modelId: saved.modelId, provider: saved.provider, name: saved.modelId, group: saved.provider, thinkingLevels: saved.provider === 'openai-compatible' ? compatibleThinkingLevels(saved.provider, saved.modelId) : saved.provider === model.provider && saved.modelId === model.modelId ? model.thinkingLevels : ['off'] });
    }
    if (!entries.some((entry) => entry.provider === model.provider && entry.modelId === model.modelId)) entries.unshift({ id: JSON.stringify([model.provider, model.modelId]), modelId: model.modelId, provider: model.provider, name: model.modelId, group: model.provider, thinkingLevels: model.thinkingLevels });
    const selected = entries.find((entry) => entry.provider === model.provider && entry.modelId === model.modelId);
    const levels = model.provider === 'openai-compatible' ? compatibleThinkingLevels(model.provider, model.modelId) : selected?.thinkingLevels ?? model.thinkingLevels;
    const ready = Boolean(levels?.includes(model.thinkingLevel));
    node.replaceChildren(...[
      modelPicker(entries, selected?.id ?? model.modelId, (id) => {
        const entry = entries.find((item) => item.id === id);
        if (entry) void changeComposerModel({ provider: entry.provider, modelId: entry.modelId, thinkingLevel: thinkingAfterModelChange(entry, model.thinkingLevel) });
      }, { name: 'chat-model', compact: true, disabled: busy || !ready, label: `${t('composerModel')}: ${selected?.name ?? model.modelId}`, minWidth: 320 }),
      ready ? modelPicker(levels.map((level) => ({ id: level, name: t(`thinking_${level}`) })), model.thinkingLevel, (level) => {
        void changeComposerModel({ provider: model.provider, modelId: model.modelId, thinkingLevel: level });
      }, { name: 'chat-thinking', compact: true, searchable: false, leadingIcon: 'memory', disabled: busy || levels.length < 2, label: `${t('thinkingTitle')}: ${t(`thinking_${model.thinkingLevel}`)}`, minWidth: 180 })
        : h('button', { type: 'button', class: 'model-picker-trigger model-choice-chip', disabled: busy, dataset: { action: 'retry-settings' } }, t('modelOptionsReload')),
      state.changingModel ? h('span', { class: 'model-saving', role: 'status' }, t('modelSaving')) : null].filter(Boolean));
  });
}

async function changeComposerModel(input) {
  if (state.changingModel || working()) return;
  state.changingModel = true;
  renderComposer();
  $('#send-button').disabled = true;
  try {
    const { status, data } = await request('/app/api/settings/model/selection', input);
    if (status === 200 && data?.model) {
      const adjusted = thinkingAdjusted(input, data.model);
      state.settings = { ...state.settings, model: data.model };
      if (adjusted) toast(t('thinkingAdjusted', { level: t(`thinking_${data.model.thinkingLevel}`) }));
    } else if (status !== 401) {
      // The server's own code, when it gives one, turns "it did not switch" into something
      // actionable instead of a dead end.
      const code = typeof data?.error === 'string' && data.error ? ` (${data.error})` : '';
      toast(status === 409 ? t('modelChangeBusy') : `${t('modelChangeFailed')}${code}`);
    }
  } catch { toast(t('modelChangeFailed')); }
  finally {
    state.changingModel = false;
    renderComposer();
    $('#send-button').disabled = state.changingModel || !$('#message-input').value.trim();
  }
}

// ---- the context panel ----------------------------------------------------------------------------------

function activityItem(entry) {
  const label = tOr(`kind_${entry.kind}`, entry.kind);
  const body = h('div', { class: 'activity-item' }, h('time', null, ago(entry.at)), h('p', null, h('span', { class: 'timeline-kind' }, label), entry.text));
  const thread = entry.threadId ? threadById(entry.threadId) : null;
  return thread ? h('a', { class: 'activity-link', href: `/app/threads/${thread.id}`, dataset: { nav: thread.id } }, body) : body;
}

function attentionNode(item) {
  const inFeed = state.snapshot.messages.some((message) => message.id === item.id);
  return h('div', null,
    cardNode(item, item.id, true),
    inFeed ? h('button', { type: 'button', class: 'context-link', dataset: { jump: item.id } }, t('showInChat')) : null);
}

function bumpDiff() {
  state.diffRev += 1;
  if (state.snapshot) renderContext();
  if (state.dialog?.type === 'diff') bumpDialog();
}

function ensureDiffEntry(workerId) {
  let entry = state.workerDiffs.get(workerId);
  if (!entry) {
    entry = { open: false, status: 'idle', data: null, byFile: new Map(), selectedFile: null, filePatches: new Map(), error: null };
    state.workerDiffs.set(workerId, entry);
  }
  return entry;
}

async function loadWorkerFileDiff(workerId, filePath) {
  const entry = ensureDiffEntry(workerId);
  const existing = entry.filePatches.get(filePath);
  if (existing?.status === 'loading' || existing?.status === 'ready') return;
  entry.filePatches.set(filePath, { status: 'loading', patch: '', truncated: false, error: null });
  bumpDiff();
  try {
    const { status, data } = await request(`/app/api/workers/${encodeURIComponent(workerId)}/diff`, { filePath });
    if (status === 200 && data) {
      entry.filePatches.set(filePath, { status: 'ready', patch: data.patch ?? '', truncated: Boolean(data.patchTruncated), error: null });
    } else {
      entry.filePatches.set(filePath, { status: 'error', patch: '', truncated: false, error: data?.error ?? 'diff_failed' });
    }
  } catch {
    entry.filePatches.set(filePath, { status: 'error', patch: '', truncated: false, error: 'diff_failed' });
  }
  bumpDiff();
}

async function loadWorkerDiff(workerId, force = false) {
  const worker = findWorker(workerId);
  if (!worker || worker.worktreeStatus === 'cleaned') return;
  const entry = ensureDiffEntry(workerId);
  if (entry.status === 'loading' || (!force && entry.status === 'ready')) return;
  entry.status = 'loading';
  entry.error = null;
  if (force) entry.filePatches.clear();
  bumpDiff();
  try {
    const { status, data } = await request(`/app/api/workers/${encodeURIComponent(workerId)}/diff`, {});
    if (status === 200 && data && Array.isArray(data.files)) {
      entry.status = 'ready';
      entry.data = data;
      entry.byFile = splitPatchByFile(data.patch);
      if (entry.selectedFile && !data.files.some((f) => f.path === entry.selectedFile)) entry.selectedFile = null;
      if (!entry.selectedFile && data.patchTruncated && data.files.length > 0 && !data.files[0].binary) {
        entry.selectedFile = data.files[0].path;
        void loadWorkerFileDiff(workerId, entry.selectedFile);
      }
    } else {
      entry.status = 'error';
      entry.error = data?.error ?? 'diff_failed';
    }
  } catch {
    entry.status = 'error';
    entry.error = 'diff_failed';
  }
  bumpDiff();
}

function toggleWorkerDiff(workerId) {
  const entry = ensureDiffEntry(workerId);
  entry.open = !entry.open;
  if (entry.open && entry.status === 'idle') void loadWorkerDiff(workerId);
  bumpDiff();
}

function selectWorkerDiffFile(workerId, filePath) {
  const entry = ensureDiffEntry(workerId);
  entry.selectedFile = filePath || null;
  if (entry.selectedFile && entry.data) {
    const meta = entry.data.files.find((f) => f.path === entry.selectedFile);
    if (!meta?.binary && (entry.data.patchTruncated || !entry.byFile.has(entry.selectedFile))) {
      void loadWorkerFileDiff(workerId, entry.selectedFile);
    }
  }
  bumpDiff();
}

function openDiffDialog(workerId) {
  const entry = ensureDiffEntry(workerId);
  if (entry.status === 'idle') void loadWorkerDiff(workerId);
  state.dialog = { type: 'diff', rev: 0, workerId, returnFocus: `expand-diff:${workerId}` };
  drawn.delete('dialog');
  renderDialog();
}

async function archiveThread(threadId, archived, cleanupPolicy = 'auto') {
  if (!threadId || state.archivingThreads.has(threadId)) return;
  state.archivingThreads.add(threadId);
  renderContext();
  if (state.dialog?.type === 'archive-confirm') bumpDialog();
  try {
    const body = archived ? { id: uuid(), archived: true, cleanupPolicy } : { id: uuid(), archived: false };
    const { status, data } = await request(`/app/api/threads/${encodeURIComponent(threadId)}/archive`, body);
    if (status === 200 && data) {
      if (state.dialog?.type === 'archive-confirm') closeDialog();
      if (!archived) toast(t('threadUnarchivedDone'));
      else if (data.queuedWorkers?.length) toast(t('threadArchivedQueued'));
      else if (data.cleanedWorkers?.length) toast(t('threadArchivedCleaned'));
      else toast(t('threadArchivedDone'));
      await refresh();
      return;
    }
    if (status === 409 && data?.error === 'thread_active') {
      toast(t('archiveActiveHint'));
      await refresh();
      return;
    }
    if (status === 409 && data?.error === 'worktree_unmerged') {
      state.dialog = { type: 'archive-confirm', rev: 0, threadId, unmergedWorkers: Array.isArray(data.unmergedWorkers) ? data.unmergedWorkers : [] };
      drawn.delete('dialog');
      renderDialog();
      return;
    }
    if (status !== 401) toast(t('actionFailed'));
  } catch {
    toast(t('actionFailed'));
  } finally {
    state.archivingThreads.delete(threadId);
    if (state.snapshot) renderContext();
    if (state.dialog?.type === 'archive-confirm') bumpDialog();
  }
}

function diffPatchNode(patch, truncated, maxLines) {
  const parsed = parseDiffLines(patch, maxLines);
  return [
    h('div', { class: 'diff-patch', tabindex: '0' }, parsed.lines.map((line) => h('div', { class: `diff-line diff-${line.kind}` },
      h('span', { class: 'diff-ln' }, line.oldLine ?? ''),
      h('span', { class: 'diff-ln' }, line.newLine ?? ''),
      h('span', { class: 'diff-code' }, line.text)))),
    parsed.truncated ? h('p', { class: 'diff-note' }, t('diffLinesTruncated', { shown: parsed.lines.length, total: parsed.totalLines })) : null,
    truncated ? h('p', { class: 'diff-note' }, t('diffPatchTruncated')) : null,
  ];
}

function diffBodyNode(worker, inDialog = false) {
  if (worker.worktreeStatus === 'cleaned') {
    const files = worker.git?.changedFiles ?? [];
    return h('div', { class: 'worker-diff-drawer' },
      h('p', { class: 'diff-note' }, t('diffWorktreeCleanedHint')),
      files.length ? h('div', { class: 'diff-file-list' }, files.map((path) => h('div', { class: 'diff-file-btn' }, h('span', { class: 'diff-file-path', title: path }, path)))) : null);
  }
  const entry = ensureDiffEntry(worker.id);
  if (entry.status === 'loading' || entry.status === 'idle') return h('div', { class: 'worker-diff-drawer' }, h('p', { class: 'diff-note', role: 'status' }, t('diffLoading')));
  if (entry.status === 'error' || !entry.data) {
    return h('div', { class: 'worker-diff-drawer' },
      h('p', { class: 'diff-error', role: 'alert' }, t(diffErrorKey(entry.error))),
      h('div', { class: 'diff-toolbar-actions' }, h('button', { type: 'button', class: 'button quiet', dataset: { action: 'refresh-diff', worker: worker.id, focus: `refresh-diff:${worker.id}` } }, t('refreshDiff'))));
  }
  const data = entry.data;
  const maxLines = inDialog ? 2500 : 1000;
  let patchView = null;
  if (!data.files.length && !data.patch) patchView = h('p', { class: 'diff-note' }, t('diffEmpty', { base: data.base }));
  else if (!entry.selectedFile) {
    patchView = data.patchTruncated && !data.patch ? h('p', { class: 'diff-note' }, t('diffSelectFileHint')) : diffPatchNode(data.patch, data.patchTruncated, maxLines);
  } else {
    const meta = data.files.find((f) => f.path === entry.selectedFile);
    const cached = !data.patchTruncated ? entry.byFile.get(entry.selectedFile) : null;
    const single = entry.filePatches.get(entry.selectedFile);
    if (meta?.binary) patchView = h('p', { class: 'diff-note' }, t('diffBinaryFile'));
    else if (cached) patchView = diffPatchNode(cached, false, maxLines);
    else if (!single || single.status === 'loading') patchView = h('p', { class: 'diff-note', role: 'status' }, t('diffFileLoading'));
    else if (single.status === 'error') patchView = h('p', { class: 'diff-error', role: 'alert' }, t(diffErrorKey(single.error)));
    else patchView = single.patch ? diffPatchNode(single.patch, single.truncated, maxLines) : h('p', { class: 'diff-note' }, t('diffNoFilePatch'));
  }
  return h('div', { class: 'worker-diff-drawer' },
    h('div', { class: 'diff-toolbar' },
      h('span', null, t('diffBaseBranch', { base: data.base, branch: data.branch })),
      h('div', { class: 'diff-toolbar-actions' },
        h('button', { type: 'button', class: 'button quiet', dataset: { action: 'refresh-diff', worker: worker.id, focus: `refresh-diff:${worker.id}` } }, t('refreshDiff')),
        !inDialog ? h('button', { type: 'button', class: 'button quiet', dataset: { action: 'open-diff-dialog', worker: worker.id, focus: `expand-diff:${worker.id}` } }, t('expandDiff')) : null)),
    data.commits.length ? h('ul', { class: 'diff-commits' }, data.commits.slice(0, 5).map((c) => h('li', null, h('code', null, c.sha), c.subject))) : null,
    data.files.length ? h('div', { class: 'diff-file-list', role: 'listbox' },
      !data.patchTruncated && data.files.length > 1 ? h('button', {
        type: 'button', class: 'diff-file-btn', role: 'option', 'aria-selected': String(!entry.selectedFile),
        dataset: { action: 'select-diff-file', worker: worker.id, path: '', focus: `diff-file:${worker.id}:all` },
      }, h('span', { class: 'diff-file-path' }, t('diffAllFiles', { count: data.files.length }))) : null,
      data.files.map((file) => h('button', {
        type: 'button', class: 'diff-file-btn', role: 'option', 'aria-selected': String(entry.selectedFile === file.path),
        dataset: { action: 'select-diff-file', worker: worker.id, path: file.path, focus: `diff-file:${worker.id}:${file.path}` },
      },
      h('span', { class: `diff-file-status status-${file.status}` }, file.status),
      h('span', { class: 'diff-file-path', title: file.oldPath ? `${file.oldPath} → ${file.path}` : file.path }, file.oldPath ? `${file.oldPath} → ${file.path}` : file.path),
      file.binary ? null : h('span', null, h('span', { class: 'git-stat-add' }, `+${file.insertions}`), ' ', h('span', { class: 'git-stat-del' }, `−${file.deletions}`))))) : null,
    data.filesTruncated ? h('p', { class: 'diff-note' }, t('diffFilesTruncated')) : null,
    patchView);
}

function archiveConfirmSection() {
  const { threadId, unmergedWorkers = [] } = state.dialog;
  const busy = state.archivingThreads.has(threadId);
  return h('div', { class: 'archive-confirm' },
    h('p', { class: 'dialog-copy' }, t('archiveConfirmBody')),
    h('ul', { class: 'archive-worker-list' }, unmergedWorkers.map((item) => {
      const meta = [];
      if (item.ahead > 0) meta.push(t('gitAhead', { count: item.ahead }));
      if (item.dirty > 0) meta.push(t('gitDirty', { count: item.dirty }));
      if (item.cleanupBlocked) meta.push(t('archiveWorkerBlocked'));
      return h('li', { class: 'archive-worker-item' }, h('code', null, item.branch || item.workerId), meta.length ? h('span', { class: 'muted-copy' }, meta.join(' · ')) : null);
    })),
    h('div', { class: 'dialog-actions' },
      h('button', { type: 'button', class: 'button primary', disabled: busy, dataset: { action: 'archive-confirm-keep', thread: threadId, focus: 'archive-keep' } }, t('archiveKeepAction')),
      h('button', { type: 'button', class: 'button danger', disabled: busy, dataset: { action: 'archive-confirm-force', thread: threadId, focus: 'archive-force' } }, t('archiveForceAction')),
      h('button', { type: 'button', class: 'button', disabled: busy, dataset: { action: 'close-dialog', focus: 'archive-cancel' } }, t('actionCancel'))));
}

function workerNode(thread, worker) {
  const active = isActiveWorker(worker);
  const progress = worker.progress ? [worker.progress.phase, worker.progress.tool, worker.progress.target].filter(Boolean).join(' ') : '';
  const facts = [];
  if (worker.git) {
    const parts = [];
    if (worker.git.ahead > 0) parts.push(t('gitAhead', { count: worker.git.ahead }));
    parts.push(t(worker.git.pushed ? 'gitPushed' : 'gitLocal'));
    if (worker.git.dirty > 0) parts.push(t('gitDirty', { count: worker.git.dirty }));
    if (worker.git.filesChanged > 0 || worker.git.insertions > 0 || worker.git.deletions > 0) {
      parts.push(t('gitDiffSummary', { files: worker.git.filesChanged ?? 0, ins: worker.git.insertions ?? 0, del: worker.git.deletions ?? 0 }));
    }
    facts.push(parts.join(' · '));
  }
  if (worker.contextPercent !== null && worker.contextPercent !== undefined) facts.push(t('context', { percent: worker.contextPercent }));
  const outcome = worker.outcome ? tOr(`outcome_${worker.outcome}`, worker.outcome) : '';
  const pr = worker.pr;
  const worktreeKey = WORKTREE_STATUS_KEYS[worker.worktreeStatus];
  const canDiff = canInspectWorkerDiff(worker);
  const diffOpen = Boolean(state.workerDiffs.get(worker.id)?.open);
  const hasSession = worker.sessionId !== null || active;
  const hasCheckpoint = Boolean(worker.sessionId || worker.outcome || worker.progress);
  return h('div', { class: 'worker-card' },
    h('div', { class: 'worker-title' },
      h('span', null, h('span', { class: 'agent-icon' }, worker.agent === 'pi' ? 'π' : worker.agent.startsWith('claude') ? '✳' : worker.agent === 'codex' ? '⌘' : worker.agent === 'antigravity' ? '✦' : worker.agent.slice(0, 1).toUpperCase()), agentName(worker.agent)),
      h('span', { class: 'worker-state' }, h('span', { class: `status-dot ${active ? 'green' : 'gray'}` }), tOr(`worker${cap(worker.state)}`, worker.state))),
    h('div', { class: 'worker-meta' }, [worker.machine, worker.unreachable ? t('unreachable') : null].filter(Boolean).join(' · ')),
    h('div', { class: 'worker-facts' }, t('agentModelRequested', { model: worker.requestedModel ?? t('agentModelFollow') })),
    h('div', { class: 'worker-facts' }, t('agentModelObserved', { model: worker.lastObservedModel?.id ?? t('agentModelUnknown') }),
      worker.lastObservedModel ? h('small', { title: new Date(worker.lastObservedModel.observedAt).toISOString() }, ` · ${worker.lastObservedModel.source} · ${ago(worker.lastObservedModel.observedAt)}`) : null),
    worker.launchObservedModel && worker.launchObservedModel.id !== worker.lastObservedModel?.id ? h('div', { class: 'worker-facts' }, t('agentModelLaunch', { model: worker.launchObservedModel.id })) : null,
    worker.branch || worktreeKey ? h('div', { class: 'thread-badge-row' },
      worker.branch ? h('code', null, worker.branch) : null,
      worktreeKey ? h('span', { class: `worktree-badge ${worker.worktreeStatus}` }, t(worktreeKey)) : null) : null,
    progress ? h('div', { class: 'worker-facts' }, t('progress', { what: progress })) : null,
    outcome ? h('div', { class: 'worker-facts' }, outcome) : null,
    facts.length ? h('div', { class: 'worker-facts' }, facts.join(' · ')) : null,
    pr?.url ? h('p', { class: 'worker-pr' }, `${t('prCreated')}: `, h('a', { href: pr.url, target: '_blank', rel: 'noopener noreferrer' }, pr.url))
      : pr?.failure ? h('p', { class: 'worker-pr failed' }, `${t('prFailed')}: ${pr.failure}`)
        : pr?.decision === 'approved' ? h('p', { class: 'worker-pr' }, t('prPending'))
          : pr?.decision === 'declined' ? h('p', { class: 'worker-pr' }, t('prDeclined')) : null,
    hasSession || canDiff || hasCheckpoint ? h('div', { class: 'worker-actions' },
      hasSession ? h('a', { href: urlFor(thread.id, worker.id), dataset: { nav: thread.id, worker: worker.id, focus: `session:${worker.id}` } }, t('rawHistory'), icon('chevron-right')) : null,
      canDiff ? h('button', { type: 'button', 'aria-expanded': String(diffOpen), dataset: { action: 'toggle-diff', worker: worker.id, focus: `diff:${worker.id}` } }, icon('diff'), t(diffOpen ? 'hideChanges' : 'viewChanges')) : null,
      hasCheckpoint ? h('button', { type: 'button', dataset: { action: 'open-checkpoint', worker: worker.id, thread: thread.id, focus: `checkpoint:${worker.id}` } }, icon('sparkle'), t('checkpointOpen')) : null) : null,
    diffOpen ? diffBodyNode(worker, false) : null);
}

function renderContext() {
  const snapshot = state.snapshot;
  const panel = $('#context-panel');
  const thread = state.selected ? threadById(state.selected) : null;
  const signature = [getLocale(), state.selected, state.diffRev, [...state.archivingThreads], thread ?? snapshot.threads.map((entry) => [entry.id, entry.title, entry.state, entry.machine, entry.workers.map((worker) => [worker.agent, worker.state])]),
    snapshot.attention, snapshot.activity, snapshot.messages.map((message) => message.id), [...state.busyCards], minuteBucket()];
  redraw('context', signature, () => {
    const top = panel.scrollTop;
    const close = h('button', { type: 'button', class: 'icon-button close-context', dataset: { action: 'close-details', focus: 'close-details' }, 'aria-label': t('closeDetails') }, icon('close'));
    const sections = [];
    if (!thread) {
      const running = snapshot.threads.filter((entry) => !entry.archived && entry.state === 'running');
      sections.push(
        h('header', { class: 'context-header' }, h('h2', null, t('workspace')), h('span', { class: 'overline' }, dayLabel(serverNow())), close),
        h('section', { class: 'context-section' },
          h('h3', { class: 'section-title' }, t('needsYou'), h('strong', { class: snapshot.attention.length ? '' : 'clear-count' }, t(snapshot.attention.length === 1 ? 'decisionCountOne' : 'decisionCount', { count: snapshot.attention.length }))),
          snapshot.attention.length ? snapshot.attention.map(attentionNode)
            : h('div', { class: 'empty-state compact' }, icon('check'), h('strong', null, t('allClear')), h('p', null, t('allClearHelp')))),
        h('section', { class: 'context-section' },
          h('h3', { class: 'section-title' }, t('running'), h('span', null, String(running.length))),
          running.length ? running.map((entry) => h('a', { class: 'running-item', href: `/app/threads/${entry.id}`, dataset: { nav: entry.id } },
            h('span', null, h('strong', null, entry.title), h('small', null, [...new Set(entry.workers.filter(isActiveWorker).map((worker) => worker.agent))].join(', '), entry.machine ? ` · ${entry.machine}` : '')),
            h('span', { class: 'status-dot green' }))) : h('p', { class: 'muted-copy' }, t('noRunning'))),
        h('section', { class: 'context-section' },
          h('h3', { class: 'section-title' }, t('recentActivity')),
          snapshot.activity.length ? snapshot.activity.slice(-5).reverse().map(activityItem) : h('p', { class: 'muted-copy' }, t('noActivity'))));
    } else {
      const waiting = attentionFor(snapshot, thread.id);
      const workers = [...thread.workers].reverse();
      const previousSummary = panel.querySelector('details[data-summary-thread]');
      const summaryOpen = previousSummary?.dataset.summaryThread === thread.id && previousSummary.open;
      const archiving = state.archivingThreads.has(thread.id);
      const hasActive = thread.state === 'running' || thread.workers.some(isActiveWorker);
      sections.push(
        h('header', { class: 'context-header' }, h('h2', null, t('threadDetails')), close),
        h('section', { class: 'context-section' },
          h('h2', { class: 'thread-detail-title' }, thread.title),
          h('div', { class: 'thread-badge-row' }, stateBadge(thread.state), thread.archived ? stateBadge('archived') : null),
          thread.goal && thread.goal !== thread.summary ? h('p', { class: 'detail-goal' }, `${t('goal')}: ${thread.goal}`) : null,
          thread.repos.length ? h('div', { class: 'repo-label' }, icon('folder'), thread.repos.join(', ')) : null,
          h('div', { class: 'thread-archive-actions' }, h('button', {
            type: 'button', class: 'button quiet',
            disabled: archiving || (!thread.archived && hasActive) ? true : null,
            title: !thread.archived && hasActive ? t('archiveActiveHint') : null,
            dataset: { action: thread.archived ? 'unarchive-thread' : 'archive-thread', thread: thread.id, focus: `archive:${thread.id}` },
          }, icon('archive'), t(thread.archived ? (archiving ? 'unarchivingThread' : 'unarchiveThread') : (archiving ? 'archivingThread' : 'archiveThread'))))),
        waiting.length ? h('section', { class: 'context-section' }, h('h3', { class: 'section-title' }, t('needsYou'), h('strong', null, t(waiting.length === 1 ? 'decisionCountOne' : 'decisionCount', { count: waiting.length }))), waiting.map(attentionNode)) : null,
        h('section', { class: 'context-section' },
          h('h3', { class: 'section-title' }, t(workers.length ? 'agent' : 'execution'), h('span', null, workers.length ? '' : t('noWorkers'))),
          workers.map((worker) => workerNode(thread, worker))),
        thread.summary ? h('details', { class: 'context-section thread-summary', dataset: { summaryThread: thread.id }, open: summaryOpen },
          h('summary', { dataset: { focus: `summary:${thread.id}` } }, t('threadSummary')),
          h('p', { class: 'detail-summary' }, thread.summary)) : null,
        h('section', { class: 'context-section' },
          h('h3', { class: 'section-title' }, t('timeline')),
          thread.timeline.length ? [...thread.timeline].reverse().map((entry) => activityItem({ ...entry, threadId: null })) : h('p', { class: 'muted-copy' }, t('noTimeline'))));
    }
    preservingFocus(panel, () => panel.replaceChildren(...sections.filter(Boolean)));
    panel.scrollTop = top;
    if (detailsOverlay && !$('#dialog').open && !panel.contains(document.activeElement)) focusDetails();
  });
}

// ---- dialogs -------------------------------------------------------------------------------------------

function directoryForm(machine) {
  const form = state.directoryForms.get(machine.id);
  if (!form) return !machine.repos.length && !machine.revoked
    ? h('p', { class: 'directory-help' }, t(machine.online ? 'directoryEmpty' : 'directoryOffline')) : null;
  if (form.state === 'done') return h('div', { class: 'directory-result', role: 'status' },
    h('p', null, t('directoryAdded')), h('code', null, form.repo.path));
  const busy = form.state === 'pending';
  const retry = form.state === 'retry';
  const inputId = `directory-path-${machine.id}`;
  const errorKey = {
    invalid_directory: 'directoryInvalid', unsupported: 'directoryUnsupported', unsupported_command: 'directoryUnsupported',
    machine_offline: 'directoryOffline', not_found: 'directoryUnavailable', outcome_unknown: 'directoryUnknown',
  }[form.code] ?? 'directoryFailed';
  if (state.dialog?.type !== 'directory' && (form.state === 'editing' || form.state === 'failed')) {
    return form.state === 'failed' ? h('p', { class: 'directory-error', role: 'alert' }, t(errorKey)) : null;
  }
  return h('form', { class: 'directory-form', dataset: { directoryMachine: machine.id }, 'aria-busy': busy ? 'true' : 'false' },
    h('label', { for: inputId }, t('directoryPath')),
    h('p', { id: `${inputId}-help`, class: 'directory-help' }, t('directoryHelp')),
    h('input', { id: inputId, name: 'path', type: 'text', value: form.path, required: true, maxlength: 4096,
      placeholder: '~/projects/my-repo', autocomplete: 'off', spellcheck: 'false', disabled: busy || retry,
      'aria-describedby': `${inputId}-help`, dataset: { directoryPath: machine.id, focus: `directory:${machine.id}` } }),
    busy ? h('p', { class: 'directory-message', role: 'status' }, t('directoryAdding')) : null,
    retry || form.state === 'failed' ? h('p', { class: 'directory-error', role: 'alert' }, t(retry ? 'directoryRetry' : errorKey)) : null,
    h('div', { class: 'dialog-actions' },
      h('button', { type: 'submit', class: 'button primary', disabled: busy || !machine.online }, t(retry ? 'directoryRetryAction' : 'addDirectory')),
      !busy ? h('button', { type: 'button', class: 'button', dataset: { action: 'directory-close', machine: machine.id } }, t('actionCancel')) : null));
}

function directoryCrumbs(path, home) {
  const separator = path.startsWith('/') ? '/' : '\\';
  const root = separator === '\\' ? path.match(/^(?:[A-Za-z]:\\|\\\\[^\\]+\\[^\\]+\\?)/)?.[0] ?? '\\' : '/';
  const underHome = path === home || path.startsWith(`${home.replace(/[\\/]$/, '')}${separator}`);
  const start = underHome ? home : root;
  const crumbs = [{ name: underHome ? '~' : root, path: start }];
  let current = start;
  for (const name of path.slice(start.length).split(separator).filter(Boolean)) {
    current = `${current.replace(/[\\/]$/, '')}${separator}${name}`;
    crumbs.push({ name, path: current });
  }
  return { root, crumbs };
}

function directoryPicker() {
  const dialog = state.dialog;
  const machine = state.snapshot.machines.find((entry) => entry.id === dialog.deviceId);
  const form = state.directoryForms.get(dialog.deviceId);
  const browse = dialog.browse;
  const listing = browse.listing;
  const available = machine?.online && !machine.revoked;
  const registering = form?.state === 'pending' || form?.state === 'retry';
  const locked = !available || registering;
  const loading = browse.state === 'loading';
  const { root, crumbs } = listing ? directoryCrumbs(listing.path, listing.home) : { root: '/', crumbs: [] };
  const navButton = (label, path, symbol, disabled = false, focus = path) => h('button', {
    type: 'button', class: 'button', disabled: locked || disabled,
    dataset: { action: 'directory-navigate', path, focus: `folder:${focus}` },
  }, symbol ? icon(symbol) : null, label);
  const errorKey = {
    unsupported: 'directoryBrowseUnsupported', machine_offline: 'directoryOffline',
    not_found: 'directoryBrowseMissing', forbidden: 'directoryBrowseForbidden',
    invalid_directory: 'directoryBrowseInvalid', browse_timeout: 'directoryBrowseTimeout',
  }[browse.code] ?? 'directoryBrowseFailed';
  const registrationError = {
    invalid_directory: 'directoryInvalid', unsupported: 'directoryUnsupported', unsupported_command: 'directoryUnsupported',
    machine_offline: 'directoryOffline', not_found: 'directoryUnavailable', outcome_unknown: 'directoryUnknown',
  }[form?.code] ?? 'directoryFailed';
  const closeLabel = form?.state === 'done' ? 'directoryDone' : 'actionCancel';
  return h('section', { class: 'directory-picker', 'aria-label': t('directoryPickerTitle') },
    h('p', { class: 'directory-machine' }, icon('laptop'), machine?.name ?? t('directoryUnavailable')),
    !available ? h('p', { class: 'directory-error', role: 'alert' }, t(machine?.revoked || !machine ? 'directoryUnavailable' : 'directoryOffline')) : null,
    h('div', { class: 'directory-toolbar' },
      navButton(t('directoryHome'), '~', 'folder', false, 'home'),
      navButton(t('directoryRoot'), root, 'monitor', !listing, 'root'),
      navButton(t('directoryUp'), listing?.parent ?? '', 'arrow-up', !listing?.parent, 'up'),
      h('button', { type: 'button', class: 'button quiet', disabled: locked, dataset: { action: 'directory-manual', focus: 'folder:manual' }, 'aria-expanded': String(dialog.manual) }, t(dialog.manual ? 'directoryBrowse' : 'directoryManual'))),
    dialog.manual ? directoryForm(machine ?? { id: dialog.deviceId, online: false }) : [
      h('nav', { class: 'directory-crumbs', 'aria-label': t('directoryLocation') },
        crumbs.length ? crumbs.map((crumb, index) => [index ? icon('chevron-right') : null,
          h('button', { type: 'button', disabled: locked, 'aria-current': index === crumbs.length - 1 ? 'location' : null,
            dataset: { action: 'directory-navigate', path: crumb.path, focus: `crumb:${crumb.path}` } }, crumb.name)]) : h('span', null, t('directoryHome'))),
      h('form', { class: 'directory-path-form', id: 'directory-browse-form' },
        h('label', { for: 'directory-browse-path', class: 'sr-only' }, t('directoryGoPath')),
        h('input', { id: 'directory-browse-path', type: 'text', value: dialog.pathDraft, placeholder: t('directoryGoPath'), maxlength: 4096,
          autocomplete: 'off', spellcheck: 'false', disabled: locked, dataset: { focus: 'folder:path' } }),
        h('button', { type: 'submit', class: 'button', disabled: locked }, t('directoryGo'))),
      browse.state === 'failed' ? h('div', { class: 'directory-browse-error', role: 'alert' },
        h('p', null, t(errorKey)),
        h('button', { type: 'button', class: 'button', disabled: locked, dataset: { action: 'directory-navigate', path: browse.path, focus: 'folder:retry' } }, t('directoryRetryAction'))) : null,
      h('div', { class: 'directory-list', 'aria-busy': String(loading), 'aria-label': t('directoryFolders') },
        loading ? h('p', { class: 'directory-empty', role: 'status' }, t('directoryLoading')) : listing?.directories.length
          ? listing.directories.map((entry) => h('button', { type: 'button', class: 'directory-entry', disabled: locked,
            dataset: { action: 'directory-navigate', path: entry.path, focus: `entry:${entry.path}` } },
            icon('folder'), h('span', null, entry.name), icon('chevron-right')))
          : h('p', { class: 'directory-empty', role: 'status' }, t(listing ? 'directoryNoFolders' : 'directoryBrowsePrompt'))),
      listing?.truncated && !loading ? h('p', { class: 'directory-help' }, t('directoryTruncated')) : null,
      h('label', { class: 'directory-hidden' }, h('input', { type: 'checkbox', checked: dialog.showHidden, disabled: locked,
        dataset: { focus: 'folder:hidden' }, onchange: (event) => {
          dialog.showHidden = event.target.checked;
          void browseDirectory(listing?.path ?? browse.path);
        } }), t('directoryShowHidden')),
      h('div', { class: 'directory-selection' }, h('span', null, t('directorySelected')), h('code', null, listing?.path ?? '~')),
      h('p', { class: 'directory-help' }, t('directoryGitHelp')),
      form?.state === 'failed' ? h('p', { class: 'directory-error', role: 'alert' }, t(registrationError)) : null,
      form?.state === 'retry' ? h('p', { class: 'directory-error', role: 'alert' }, t('directoryRetry')) : null,
      form?.state === 'pending' ? h('p', { class: 'directory-message', role: 'status' }, t('directoryAdding')) : null,
      form?.state === 'done' ? h('div', { class: 'directory-result', role: 'status' }, h('p', null, t('directoryAdded')), h('code', null, form.repo.path)) : null,
      h('div', { class: 'directory-footer' },
        h('button', { type: 'button', class: 'button', dataset: { action: 'close-dialog', focus: 'folder:cancel' } }, t(closeLabel)),
        form?.state !== 'done' ? h('button', { type: 'button', class: 'button primary',
          disabled: !available || form?.state === 'pending' || (form?.state !== 'retry' && (browse.state !== 'ready' || !listing)),
          dataset: { action: 'directory-add-current', focus: 'folder:add' } }, t(form?.state === 'retry' ? 'directoryRetryAction' : 'directoryAddCurrent')) : null),
    ]);
}

function openDirectoryPicker(deviceId) {
  const machine = state.snapshot.machines.find((entry) => entry.id === deviceId);
  if (!machine?.online || machine.revoked) return;
  state.directoryForms.set(deviceId, { state: 'editing', path: '' });
  state.dialog = { type: 'directory', deviceId, rev: 0, returnTo: 'machines', returnFocus: `directory-open:${deviceId}`,
    browse: { state: 'loading', path: '~', listing: null }, pathDraft: '', showHidden: false, manual: false };
  drawn.delete('dialog');
  bumpDialog();
  void browseDirectory('~');
  document.querySelector('[data-focus="folder:home"]')?.focus();
}

async function browseDirectory(path) {
  const dialog = state.dialog;
  if (dialog?.type !== 'directory') return;
  const form = state.directoryForms.get(dialog.deviceId);
  const machine = state.snapshot.machines.find((entry) => entry.id === dialog.deviceId);
  if (!machine?.online || machine.revoked || form?.state === 'pending' || form?.state === 'retry') return;
  const browse = { state: 'loading', path: path || '~', listing: dialog.browse.listing };
  dialog.browse = browse;
  if (form?.state === 'failed' || form?.state === 'done') state.directoryForms.set(dialog.deviceId, { state: 'editing', path: '' });
  bumpDialog();
  let response;
  try {
    response = await request('/app/api/machines/directories/browse', { deviceId: dialog.deviceId, path: browse.path, showHidden: dialog.showHidden });
  } catch {
    response = { status: 0, data: { error: 'browse_failed' } };
  }
  if (state.dialog !== dialog || dialog.browse !== browse) return;
  const { status, data } = response;
  if (status === 200 && data && Array.isArray(data.directories)) {
    dialog.browse = { state: 'ready', path: data.path, listing: data };
    dialog.pathDraft = data.path;
  } else {
    dialog.browse = { ...browse, state: 'failed', code: data?.error ?? 'browse_failed' };
  }
  bumpDialog();
  if (document.activeElement === document.body || document.activeElement === $('#dialog')) {
    document.querySelector('[data-focus="folder:home"]')?.focus();
  }
}

function machineCard(machine) {
  const work = workOn(state.snapshot, machine);
  const status = machine.revoked ? t('revoked') : machine.online ? t('online') : t('offline');
  const detail = machine.revoked ? '' : machine.online ? t('slots', { used: machine.slots?.running ?? 0, total: machine.slots?.max ?? 0 })
    : machine.lastSeen ? t('lastSeen', { time: ago(machine.lastSeen) }) : t('neverConnected');
  const confirming = state.dialog?.confirm === machine.id;
  return h('section', { class: `machine-card${machine.revoked ? ' revoked' : ''}` },
    h('h3', null, icon('laptop'), h('span', null, machine.name), h('span', { class: 'machine-availability' }, h('span', { class: `status-dot ${machine.online ? 'green' : 'gray'}` }), status)),
    detail ? h('p', null, detail) : null,
    h('dl', null,
      h('div', null, h('dt', null, t('agents')), h('dd', null, machine.agents.join(', ') || t('noneListed'))),
      h('div', null, h('dt', null, t('repositories')), h('dd', null, machine.repos.join(', ') || t('noneListed'))),
      work.length ? h('div', null, h('dt', null, t('running')), h('dd', null, work.map((entry) => entry.title).join(' · '))) : null),
    machine.revoked ? null : agentModelSection(machine.id),
    machine.revoked ? null : directoryForm(machine),
    machine.revoked ? null : confirming
      ? h('div', { class: 'revoke-confirm' },
        h('p', null, t('revokeConfirm', { name: machine.name })),
        h('div', { class: 'dialog-actions' },
          h('button', { type: 'button', class: 'button danger', dataset: { action: 'revoke-yes', machine: machine.id, focus: `revoke-yes:${machine.id}` } }, t('revokeConfirmAction')),
          h('button', { type: 'button', class: 'button', dataset: { action: 'revoke-no', focus: `revoke-no:${machine.id}` } }, t('actionCancel'))))
      : h('div', { class: 'dialog-actions' },
        !['pending', 'retry'].includes(state.directoryForms.get(machine.id)?.state)
          ? h('button', { type: 'button', class: 'button primary', disabled: !machine.online, dataset: { action: 'directory-open', machine: machine.id, focus: `directory-open:${machine.id}` } }, icon('plus'), t('addDirectory')) : null,
        machine.repos.length > 0
          ? h('button', { type: 'button', class: 'button', dataset: { action: 'machine-skills', machine: machine.id, focus: `machine-skills:${machine.id}` } }, icon('sparkle'), t('machineRepoSkills')) : null,
        h('button', { type: 'button', class: 'button danger', dataset: { action: 'revoke', machine: machine.id, focus: `revoke:${machine.id}` } }, t('revokeMachine'))));
}

function pairingSection() {
  const pairing = state.dialog.pairing;
  const ready = pairing && typeof pairing === 'object';
  return h('section', { class: 'pairing' },
    h('h3', null, t('addMachine')),
    h('p', { class: 'dialog-copy' }, t('pairingHelp')),
    ready ? [
      h('code', { class: 'pairing-command', tabindex: '0' }, pairing.command),
      h('div', { class: 'dialog-actions' },
        h('button', { type: 'button', class: 'button primary', dataset: { action: 'copy-pairing' } }, icon('check'), t('pairingCopy')),
        h('span', { class: 'dialog-hint' }, t('pairingExpires', { time: formatClock(pairing.expiresAt) }))),
    ] : null,
    pairing === 'failed' ? h('p', { class: 'dialog-error' }, t('pairingFailed')) : null,
    h('div', { class: 'dialog-actions' },
      h('button', { type: 'button', class: 'button', dataset: { action: 'create-pairing', focus: 'create-pairing' }, disabled: pairing === 'creating' ? true : null }, t('pairingCreate'))));
}

/** One row in the Security section. Mirrors machineCard()'s confirm-then-commit shape. */
function passkeyRow(passkey) {
  const confirming = securityState().confirm === passkey.credentialId;
  return h('div', { class: 'passkey-row' },
    h('div', null, h('strong', null, passkey.label),
      h('p', { class: 'dialog-hint' }, t('passkeyMeta', {
        created: ago(passkey.createdAt),
        lastUsed: passkey.lastUsedAt ? ago(passkey.lastUsedAt) : t('passkeyNeverUsed'),
      }))),
    confirming
      ? h('div', { class: 'revoke-confirm' },
        h('p', null, t('passkeyRemoveConfirm', { name: passkey.label })),
        h('div', { class: 'dialog-actions' },
          h('button', { type: 'button', class: 'button danger', dataset: { action: 'passkey-remove-yes', passkey: passkey.credentialId } }, t('passkeyRemoveConfirmAction')),
          h('button', { type: 'button', class: 'button', dataset: { action: 'passkey-remove-no' } }, t('actionCancel'))))
      : h('div', { class: 'dialog-actions' },
        h('button', { type: 'button', class: 'button danger', dataset: { action: 'passkey-remove', passkey: passkey.credentialId } }, t('passkeyRemove'))));
}

const securityState = () => state.onboarding ?? state.dialog;

function securitySection() {
  const passkeys = state.settings?.passkeys ?? [];
  const security = securityState();
  return h('section', { class: 'security-settings settings-section' },
    h('div', { class: 'section-heading' }, icon('shield'),
      h('div', null, h('h3', null, t('securityTitle')), h('p', { class: 'dialog-copy' }, t('securityHelp')))),
    passkeys.map(passkeyRow),
    security.passkeyAdd === 'unsupported' ? h('p', { class: 'dialog-error', role: 'alert' }, t('passkeyUnsupported')) : null,
    security.passkeyAdd === 'failed' ? h('p', { class: 'dialog-error', role: 'alert' }, t('passkeyAddFailed')) : null,
    h('form', { id: 'passkey-form', class: 'passkey-form model-form' },
      h('label', { for: 'passkey-label' }, t('passkeyLabelLabel')),
      h('div', { class: 'passkey-input-row' },
        h('input', { id: 'passkey-label', maxlength: '80', autocomplete: 'off', placeholder: t('passkeyLabelPlaceholder'), value: state.passkeyLabelDraft, dataset: { focus: 'passkey-label' } }),
        h('button', { type: 'submit', class: 'button primary', disabled: security.passkeyAdd === 'creating' },
          security.passkeyAdd === 'creating' ? t('passkeyAdding') : t('passkeyAdd')))));
}

function providerGrid() {
  const { model, providers = [], keyedProviders = [] } = state.settings;
  const groups = new Map();
  for (const provider of providers) {
    const family = provider.info?.family ?? provider.id;
    if (!groups.has(family)) groups.set(family, []);
    groups.get(family).push(provider);
  }
  const entries = [...groups.entries()].map(([family, variants]) => {
    const entry = variants.find((p) => p.id === model?.provider) ?? variants.find((p) => keyedProviders.includes(p.id)) ?? variants[0];
    return { ...entry, family, name: entry.info?.familyName ?? entry.name, variants };
  });
  if (model && !entries.some((entry) => entry.id === model.provider)) entries.unshift({ id: model.provider, name: model.provider });
  const common = ['anthropic', 'openai', 'google', 'deepseek', 'xai', 'moonshotai', 'zai', 'minimax', 'openrouter', 'xiaomi', 'qwen-token-plan'];
  const verifiedProviders = new Set((state.settings.verifiedModels ?? []).map((entry) => entry.provider));
  const featured = entries.filter((entry) => entry.id === model?.provider || (entry.variants ?? [entry]).some((variant) => verifiedProviders.has(variant.id)) || (!model?.apiKey && !verifiedProviders.size && common.includes(entry.family)));
  featured.sort((a, b) => (common.indexOf(a.family) < 0 ? 99 : common.indexOf(a.family)) - (common.indexOf(b.family) < 0 ? 99 : common.indexOf(b.family)));
  const others = entries.filter((entry) => !featured.includes(entry));
  const tile = (provider) => {
    const active = model?.apiKey && model.provider === provider.id;
    const saved = (provider.variants ?? [provider]).some((entry) => keyedProviders.includes(entry.id));
    const verified = (provider.variants ?? [provider]).some((entry) => (state.settings.verifiedModels ?? []).some((model) => model.provider === entry.id));
    const status = active ? (verified ? 'providerActive' : 'providerUnverified') : verified ? 'providerVerified' : 'providerSaved';
    return h('button', { type: 'button', class: `provider-tile${active ? ' is-active' : ''}`, 'aria-label': active || saved ? `${provider.name} · ${t(status)}` : provider.name, dataset: { action: 'provider', provider: provider.id, focus: `provider:${provider.family ?? provider.id}` } },
      h('span', { class: 'provider-mark', 'aria-hidden': 'true' }, providerIcon(provider.id)),
      h('span', { class: 'provider-name' }, provider.name,
        active || saved ? h('span', { class: 'provider-saved-dot', title: t(status), 'aria-label': t(status) }) : null));
  };
  return h('div', null, h('div', { class: 'provider-grid' }, featured.map(tile)),
    h('details', { class: 'more-providers' },
      h('summary', null, t('providersMore', { count: others.length })),
      h('div', { class: 'provider-grid' }, others.map(tile))),
    h('button', { type: 'button', class: 'provider-tile provider-custom', dataset: { action: 'provider', provider: MODEL_CUSTOM, focus: 'provider:custom' } },
    h('span', { class: 'provider-mark' }, icon('plus')), h('span', { class: 'provider-name' }, t('modelCustomOption')), icon('chevron-right')));
}

function modelSection() {
  const model = state.settings.model;
  return h('section', { class: 'model-settings settings-section' },
    h('div', { class: 'section-heading' }, icon('sparkle'),
      h('div', null, h('h3', null, t('modelTitle')), h('p', { class: 'dialog-copy' }, t('providersHelp')))),
    model?.apiKey ? h('p', { class: 'active-model' }, h('span', { class: `status-dot${(state.settings.verifiedModels ?? []).some((entry) => entry.provider === model.provider && entry.modelId === model.modelId) ? ' green' : ''}` }), t((state.settings.verifiedModels ?? []).some((entry) => entry.provider === model.provider && entry.modelId === model.modelId) ? 'providerActive' : 'providerUnverified'), h('strong', null, model.modelId)) : null,
    state.modelDraftNotice ? h('p', { class: 'dialog-error', role: 'alert' }, t(state.modelDraftNotice)) : null,
    working() && (state.settings.modelDrafts ?? []).some(draft => draft.status === 'verified')
      ? h('p', { class: 'dialog-hint', role: 'status' }, t('modelDraftReplyBusy')) : null,
    providerGrid(),
    (state.settings.modelDrafts ?? []).filter(draft => draft.status !== 'activated').map(draft => h('div', { class: 'connection-test' },
      h('p', { role: 'status' }, `${draft.provider} / ${draft.modelId} · ${t(`modelDraft_${draft.status}`)}${draft.testError ? ` · ${t(modelRejectionKey(draft.testError))}` : ''}`),
      h('button', { type: 'button', class: 'button quiet', disabled: state.changingModel, dataset: { action: 'model-draft', id: draft.id, revision: String(draft.revision), operation: 'verify' } }, t('modelDraftRetry')),
      draft.status === 'verified' ? h('button', { type: 'button', class: 'button', disabled: state.changingModel || working(), dataset: { action: 'model-draft', id: draft.id, revision: String(draft.revision), operation: 'activate' } }, t('modelDraftActivate')) : null,
      h('button', { type: 'button', class: 'button quiet', disabled: state.changingModel, dataset: { action: 'model-draft', id: draft.id, revision: String(draft.revision), operation: 'delete' } }, t('modelDraftDiscard')))));
}

function pushSection() {
  const available = state.settings.push?.available;
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && isSecureContext;
  const enabled = !!state.pushSubscription;
  // Labels are read here so the i18n scan in ui-modules.test.ts sees keys, not action names.
  const toggleAction = enabled ? 'push-disable' : 'push-enable';
  const toggleLabel = state.pushAction === toggleAction ? 'pushWorking' : enabled ? 'pushDisable' : 'pushEnable';
  const testLabel = state.pushAction === 'push-test' ? 'pushTesting' : 'pushTest';
  return h('section', { class: 'settings-section' },
    h('div', { class: 'section-heading' }, icon('bell'),
      h('div', null, h('h3', null, t('pushTitle')), h('p', { class: 'dialog-copy' }, t('pushHelp')))),
    !available ? h('p', { class: 'dialog-hint' }, t('pushUnavailable')) :
      !supported ? h('p', { class: 'dialog-hint' }, t('pushNoSupport')) : [
        Notification.permission === 'denied' ? h('p', { class: 'dialog-hint' }, t('pushDenied')) : null,
        h('button', { type: 'button', class: 'button quiet', disabled: state.pushBusy || Notification.permission === 'denied',
          dataset: { action: toggleAction } }, t(toggleLabel)),
        enabled ? [
          h('button', { type: 'button', class: 'button quiet', disabled: state.pushBusy,
            dataset: { action: 'push-test' } }, t(testLabel)),
          h('button', { type: 'button', class: 'button quiet', disabled: state.pushBusy,
            dataset: { action: 'push-quiet' }, 'aria-pressed': String(state.pushQuiet) },
          `${state.pushQuiet ? '✓ ' : ''}${t('pushQuiet')}`),
        ] : null,
        // A toast paints under a modal dialog's backdrop, so the result belongs here too.
        state.pushNotice ? h('p', { class: 'dialog-hint', role: 'status' }, t(state.pushNotice)) : null,
      ]);
}

function agentModelSection(deviceId = null) {
  const entries = (state.settings?.localAgentModels ?? []).filter(entry => deviceId === null || entry.deviceId === deviceId);
  if (!entries.length) return null;
  return h('section', { class: 'settings-section agent-model-settings' },
    h('h3', null, t('agentModelsTitle')),
    h('p', { class: 'dialog-hint' }, t('agentModelsHelp')),
    state.agentModelNotice ? h('p', { class: 'dialog-hint', role: 'status' }, t(state.agentModelNotice)) : null,
    entries.map(entry => {
      const selectable = entry.catalog?.capabilities?.selection && entry.catalog.capabilities.selection !== 'none';
      const online = state.snapshot?.machines.find(machine => machine.id === entry.deviceId)?.online ?? entry.online;
      const localPi = entry.agent === 'pi';
      const freshLocal = online && entry.catalog?.status === 'ready';
      const enumerated = localPi || entry.catalog?.capabilities?.discovery === 'enumerated';
      const id = `agent-model-${encodeURIComponent(JSON.stringify([entry.deviceId, entry.agent]))}`;
      const models = localPi && entry.catalog?.source !== 'local-pi' ? [] : entry.catalog?.models ?? [];
      const disabled = state.savingAgentModel || state.refreshingAgentModels || !selectable;
      return h('form', { class: 'model-form', dataset: { agentModel: entry.agent, deviceId: entry.deviceId } },
        h('label', { for: id }, `${entry.machineName} / ${agentName(entry.agent)}`),
        h('p', { class: 'dialog-hint' }, t('agentModelCurrent', { model: entry.model ?? t('agentModelFollow') })),
        !online ? h('p', { class: 'dialog-hint' }, t('agentModelOffline'), entry.lastSeen ? ` · ${ago(entry.lastSeen)}` : '') : null,
        !selectable ? h('p', { class: 'dialog-hint' }, t('agentModelUpgrade')) : null,
        entry.catalog?.status === 'unavailable' ? h('p', { class: 'dialog-hint' }, t('agentModelDiscoveryUnavailable')) : null,
        localPi ? h('p', { class: 'dialog-hint' }, t(entry.catalog?.source === 'local-pi' ? 'agentModelLocalList' : 'agentModelLocalUpgrade')) : null,
        localPi && entry.catalog?.source === 'local-pi' ? h('p', { class: 'dialog-hint' },
          t('agentModelPiDefault', { model: entry.catalog.defaultModel ?? t('agentModelUnknown') }),
          entry.catalog.discoveredAt !== undefined ? ` · ${t(freshLocal ? 'agentModelUpdated' : 'agentModelCached', { time: new Date(entry.catalog.discoveredAt).toLocaleString() })}` : '',
          entry.catalog.truncated ? ` · ${t('agentModelTruncated')}` : '') : null,
        localPi ? h('button', { type: 'button', class: 'button', disabled: !online || !entry.catalog?.refreshable || state.refreshingAgentModels || state.savingAgentModel,
          dataset: { action: 'agent-model-refresh', deviceId: entry.deviceId, agent: entry.agent } }, t(state.refreshingAgentModels ? 'agentModelRefreshing' : 'agentModelRefresh')) : null,
        enumerated ? h('select', { id, name: 'model', disabled },
          h('option', { value: '', selected: !entry.model }, t('agentModelFollow')),
          entry.model && !models.some(model => model.id === entry.model) ? h('option', { value: entry.model, selected: true }, `${entry.model} · ${t('agentModelNotListed')}`) : null,
          models.map(model => h('option', { value: model.id, selected: model.id === entry.model }, localPi ? `${model.name} (${model.id})` : model.name)))
          : [h('input', { id, name: 'model', value: entry.model ?? '', maxlength: 256, autocomplete: 'off', placeholder: t('agentModelFollow'), list: `${id}-suggestions`, disabled: state.savingAgentModel || !selectable }),
            h('datalist', { id: `${id}-suggestions` }, models.map(model => h('option', { value: model.id }, model.name))),
            selectable ? h('p', { class: 'dialog-hint' }, t('agentModelSuggestions')) : null],
        localPi && selectable && entry.catalog?.capabilities.customModelInput ? h('details', { class: 'agent-model-advanced' },
          h('summary', null, t('agentModelAdvanced')),
          h('label', null, h('input', { type: 'checkbox', name: 'useCustomModel', disabled }), t('agentModelCustom')),
          h('input', { name: 'customModel', value: entry.model && !models.some(model => model.id === entry.model) ? entry.model : '', maxlength: 256, autocomplete: 'off', placeholder: 'provider/id', disabled }),
          h('p', { class: 'dialog-hint' }, t('agentModelSuggestions'))) : null,
        h('button', { type: 'submit', class: 'button', disabled: state.savingAgentModel || state.refreshingAgentModels }, t(selectable ? 'agentModelSave' : 'agentModelReset')));
    }));
}

async function refreshAgentModels(button) {
  if (state.refreshingAgentModels || state.savingAgentModel) return;
  state.refreshingAgentModels = true;
  state.agentModelNotice = null;
  bumpDialog();
  try {
    const { status, data } = await request('/app/api/settings/agent-model/refresh', { deviceId: button.dataset.deviceId, agent: button.dataset.agent });
    state.agentModelNotice = status === 200 && data?.ok ? 'agentModelRefreshed' : 'agentModelRefreshFailed';
    await loadSettings();
  } catch { state.agentModelNotice = 'agentModelRefreshFailed'; }
  finally { state.refreshingAgentModels = false; bumpDialog(); }
}

async function saveAgentModel(form) {
  if (state.savingAgentModel || state.refreshingAgentModels) return;
  const input = form.elements.namedItem('model');
  const custom = form.elements.namedItem('useCustomModel');
  const value = custom?.checked ? form.elements.namedItem('customModel').value : input.value;
  const body = { deviceId: form.dataset.deviceId, agent: form.dataset.agentModel, model: input.disabled ? null : value.trim() || null };
  state.savingAgentModel = true;
  state.agentModelNotice = null;
  bumpDialog();
  try {
    const { status } = await request('/app/api/settings/agent-model', body);
    state.agentModelNotice = status === 200 ? 'agentModelSaved' : 'agentModelSaveFailed';
    if (status === 200) await loadSettings();
  } catch { state.agentModelNotice = 'agentModelSaveFailed'; }
  finally { state.savingAgentModel = false; bumpDialog(); }
}

function accountSection() {
  if (!state.settings) return [h('p', { class: 'dialog-copy' }, t(state.settingsError ? 'settingsLoadFailed' : 'settingsLoading')),
    state.settingsError ? h('button', { class: 'button', dataset: { action: 'retry-settings' } }, t('settingsRetry')) : null];
  return [modelSection(), agentModelSection(), securitySection(), pushSection(),
    h('div', { class: 'settings-footer' }, h('p', { class: 'dialog-hint' }, t('accountBody')),
      h('button', { type: 'button', class: 'button quiet', dataset: { action: 'sign-out' } }, t('signOut')))];
}

function providerSection() {
  const draft = state.modelDraft;
  const provider = state.settings.providers.find((entry) => entry.id === draft.provider);
  const models = state.dialog.importedModels ?? provider?.models ?? [];
  const known = models.some((entry) => entry.id === draft.modelId);
  const keyed = state.settings.keyedProviders.includes(draft.provider);
  const variants = provider?.info ? state.settings.providers.filter((entry) => entry.info?.family === provider.info.family) : [];
  const selectedModel = models.find((entry) => entry.id === draft.modelId);
  const declared = parseDeclaredLevels(draft.thinkingJson ?? '');
  const measured = state.dialog.acceptedThinkingLevels ?? measuredThinkingLevels(draft.provider, draft.modelId);
  const described = declared?.length ? declared : measured ?? null;
  const thinkingLevels = draft.provider === 'openai-compatible' ? (described ? ['auto', ...described] : [...ALL_THINKING_LEVELS]) : (selectedModel?.thinkingLevels ?? ['off']);
  const busy = state.dialog.saving || state.dialog.testing;
  const draftStatusKey = `modelDraft_${state.dialog.saveError?.status ?? 'verification_failed'}`;
  const link = (url, label) => h('a', { class: 'provider-link', href: url, target: '_blank', rel: 'noopener noreferrer' }, label, icon('external'));
  const canMaskText = Boolean(globalThis.CSS?.supports?.('-webkit-text-security', 'disc'));
  const hideKey = !state.dialog.showKey;
  return h('form', { id: 'model-form', class: 'model-form provider-form', autocomplete: 'off' },
    h('div', { class: 'provider-intro' },
      h('p', { class: 'dialog-copy' }, t('providerConnectHelp')),
      provider?.info ? link(provider.info.consoleUrl, t('providerConsole')) : null),
    variants.length > 1 ? [
      h('span', { id: 'provider-variant-label', class: 'field-label' }, t('providerVariant')),
      h('div', { class: 'provider-variants', role: 'group', 'aria-labelledby': 'provider-variant-label' }, variants.map((entry) =>
        h('button', { type: 'button', class: 'provider-variant', 'aria-pressed': String(entry.id === draft.provider), disabled: busy, dataset: { action: 'provider-variant', provider: entry.id, focus: `variant:${entry.id}` } },
          [entry.info.plan ? t(`providerPlan_${entry.info.plan}`) : '', entry.info.region ? t(`providerRegion_${entry.info.region}`) : ''].filter(Boolean).join(' · '),
          state.settings.keyedProviders.includes(entry.id) ? h('span', { class: 'provider-saved-dot', title: t('providerSaved') }) : null))),
      h('p', { class: 'dialog-hint' }, t('providerVariantHelp')),
    ] : null,
    h('div', { class: 'provider-key-label' }, h('label', { for: 'model-key' }, t('modelKeyLabel')),
      provider?.info ? link(provider.info.keysUrl, t('providerGetKey')) : null),
    h('div', { class: 'key-input-row' },
      h('input', {
        id: 'model-key', name: 'provider-api-key',
        type: hideKey && !canMaskText ? 'password' : 'text',
        class: hideKey && canMaskText ? 'masked-secret' : null,
        autocomplete: canMaskText ? 'off' : 'new-password',
        autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false',
        'data-1p-ignore': 'true', 'data-lpignore': 'true', 'data-form-type': 'other',
        required: !keyed, placeholder: t(keyed ? 'modelKeyKeep' : 'modelKeyPlaceholder'), value: draft.apiKey, dataset: { focus: 'model-key' },
      }),
      h('button', { type: 'button', class: 'button quiet', dataset: { action: 'toggle-key' }, 'aria-pressed': String(Boolean(state.dialog.showKey)) }, t(state.dialog.showKey ? 'keyHide' : 'keyShow'))),
    h('p', { class: 'dialog-hint' }, t('modelHelp')),
    !provider?.id?.endsWith('-compatible') ? h('div', { class: 'provider-endpoint' }, h('span', null, t('providerEndpoint')),
      h('code', { id: 'provider-endpoint' }, draft.baseUrl.trim() || selectedModel?.baseUrl || t('providerEndpointUnknown'))) : null,
    h('label', { for: provider && !draft.customModel && (known || !draft.baseUrl) ? 'model-picker-trigger' : 'model-id-custom' }, t('modelIdLabel')),
    provider && !draft.customModel && (known || !draft.baseUrl) ? modelPicker([...models, { id: MODEL_CUSTOM, name: t('modelCustomOption') }], draft.modelId, (id) => {
      state.modelDraft.customModel = id === MODEL_CUSTOM;
      state.modelDraft.modelId = id === MODEL_CUSTOM ? '' : id;
      state.modelDraft.thinkingLevel = draft.provider === 'openai-compatible' ? 'auto' : thinkingAfterModelChange(models.find((entry) => entry.id === id), state.modelDraft.thinkingLevel);
      state.dialog.acceptedThinkingLevels = null;
      state.dialog.test = null;
      bumpDialog();
      $(id === MODEL_CUSTOM ? '#model-id-custom' : '#model-picker-trigger')?.focus();
    }) : [
      !provider ? [h('label', { for: 'model-provider-custom' }, t('modelProviderLabel')),
        h('input', { id: 'model-provider-custom', required: true, autocomplete: 'off', value: draft.provider })] : null,
      h('input', { id: 'model-id-custom', required: true, autocomplete: 'off', placeholder: t('modelIdLabel'), value: draft.modelId }),
      provider && !provider.id.endsWith('-compatible') ? h('button', { type: 'button', class: 'button quiet', dataset: { action: 'catalog-model' } }, t('setupBack')) : null,
    ],
    h('label', { for: 'model-base-url' }, t('modelBaseUrlLabel')),
    h('input', { id: 'model-base-url', type: 'url', autocomplete: 'url', required: draft.provider.endsWith('-compatible'), placeholder: t('modelBaseUrlPlaceholder'), value: draft.baseUrl }),
    draft.provider.endsWith('-compatible') ? [h('label', { for: 'model-api' }, t('modelApiLabel')),
      h('select', { id: 'model-api' }, [
        h('option', { value: 'openai-compatible', selected: draft.provider === 'openai-compatible' }, 'openai-completions'),
        h('option', { value: 'anthropic-compatible', selected: draft.provider === 'anthropic-compatible' }, 'anthropic-messages'),
      ])] : null,
    draft.provider.endsWith('-compatible') ? [h('label', { for: 'model-headers' }, t('modelHeadersLabel')),
      h('textarea', { id: 'model-headers', rows: 3, placeholder: '{"X-Custom-Header":"value"}' }, draft.headersJson ?? ''),
      h('p', { class: 'dialog-hint' }, t('modelHeadersHelp')),
      h('button', { type: 'button', class: 'button quiet', disabled: busy, dataset: { action: 'import-models' } }, state.dialog.importing ? t('modelImporting') : t('modelImport')),
      h('label', { for: 'model-levels-json' }, t('modelLevelsLabel')),
      h('textarea', { id: 'model-levels-json', rows: 3, spellcheck: 'false', placeholder: '{"thinkingLevels":["minimal","low","medium","high"]}' }, draft.thinkingJson ?? ''),
      declared === undefined ? h('p', { class: 'dialog-error' }, t('modelLevelsInvalid')) : h('p', { class: 'dialog-hint' }, t('modelLevelsHelp'))] : null,
    state.dialog.importError ? h('p', { class: 'dialog-error' }, t('modelImportFailed')) : null,
    provider && (selectedModel || draft.provider === 'openai-compatible') ? [h('label', { for: 'provider-thinking-picker-trigger' }, t('thinkingTitle')),
      modelPicker(thinkingLevels.map((level) => ({ id: level, name: t(`thinking_${level}`) })), thinkingLevels.includes(draft.thinkingLevel) ? draft.thinkingLevel : thinkingLevels[0], (level) => {
        state.modelDraft.thinkingLevel = level;
        state.dialog.test = null;
        bumpDialog();
        $('#provider-thinking-picker-trigger').focus();
      }, { name: 'provider-thinking', searchable: false, label: t('thinkingTitle'), disabled: busy || thinkingLevels.length < 2 }),
      draft.provider === 'openai-compatible' && !described ? h('p', { class: 'dialog-hint' }, t('thinkingUnverified')) : null,
      h('p', { class: 'dialog-hint' }, t('thinkingHelp')),
    ] : null,
    provider && !known && !draft.baseUrl && !draft.customModel ? h('p', { class: 'dialog-hint' }, t('modelChooseKnown')) : null,
    h('div', { class: 'connection-test' },
      h('button', { type: 'button', class: 'button', disabled: busy, dataset: { action: 'test-model' } }, t(state.dialog.testing ? 'modelTesting' : 'modelTest')),
      h('p', { class: 'dialog-hint' }, t(draft.provider === 'openai-compatible' ? 'modelTestProbeHelp' : 'modelTestHelp', { model: draft.modelId }))),
    h('label', { class: 'dialog-check' }, [
      h('input', { id: 'model-auto-test', type: 'checkbox', checked: state.dialog.autoTest !== false }),
      h('span', null, t('modelAutoTestLabel'))]),
    h('p', { id: 'model-test-result', class: `connection-result${state.dialog.test?.ok ? ' success' : ' dialog-error'}`, role: 'status', 'aria-live': 'polite' },
      state.dialog.test ? t(state.dialog.test.ok ? 'modelTestSuccess' : `modelTest_${state.dialog.test.error}`) : ''),
    state.dialog.saveError === true ? h('p', { class: 'dialog-error', role: 'alert' }, t('modelSaveFailed'))
      : state.dialog.saveError ? h('p', { class: 'dialog-error', role: 'alert' }, `${t(draftStatusKey)}${state.dialog.saveError.testError ? ` · ${t(modelRejectionKey(state.dialog.saveError.testError))}` : ''}`)
      : null,
    h('div', { class: 'provider-footer' },
      h('button', { type: 'button', class: 'button quiet', dataset: { action: 'close-dialog' } }, t('actionCancel')),
      h('button', { type: 'submit', class: 'button primary', disabled: busy }, t(state.dialog.saving ? 'modelSaving' : state.dialog.autoTest === false ? 'modelSaveDraft' : 'modelSave'))));
}

function selectProviderVariant(provider) {
  const current = state.settings.model;
  state.modelDraft = current?.provider === provider
    ? { provider, modelId: current.modelId, baseUrl: current.baseUrl ?? '', apiKey: '', thinkingJson: savedThinkingJson(provider, current.modelId) }
    : { provider, modelId: modelAfterProviderChange(state.settings.providers, provider, state.modelDraft.modelId) ?? '', baseUrl: '', apiKey: '', thinkingJson: '' };
  const selected = state.settings.providers.find((entry) => entry.id === provider)?.models.find((entry) => entry.id === state.modelDraft.modelId);
  state.modelDraft.customModel = provider.endsWith('-compatible') || Boolean(current?.provider === provider && !selected);
  state.modelDraft.thinkingLevel = provider === 'openai-compatible' ? (current?.provider === provider ? current.thinkingLevel : 'auto') : provider.endsWith('-compatible') ? 'off' : thinkingAfterModelChange(selected, current?.thinkingLevel);
  state.dialog.test = null;
  state.dialog.acceptedThinkingLevels = null;
  state.dialog.saveError = false;
  state.dialog.showKey = false;
  bumpDialog();
}

function draftHeaders() {
  const raw = state.modelDraft?.headersJson?.trim();
  if (!raw) return undefined;
  try {
    const headers = JSON.parse(raw);
    if (!headers || typeof headers !== 'object' || Array.isArray(headers)) throw new Error();
    return headers;
  } catch { toast(t('modelHeadersInvalid')); return null; }
}

async function importModels() {
  const dialog = state.dialog;
  const draft = state.modelDraft;
  if (!draft || dialog?.importing || !draft.baseUrl.trim()) return;
  const headers = draftHeaders();
  if (headers === null) return;
  dialog.importing = true;
  dialog.importError = false;
  bumpDialog();
  try {
    const { status, data } = await request('/app/api/settings/model/import', {
      provider: draft.provider, modelId: draft.modelId || 'import', baseUrl: draft.baseUrl.trim(),
      ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
      ...(headers ? { headers } : {}),
    });
    if (state.dialog !== dialog) return;
    if (status !== 200 || !Array.isArray(data?.models) || !data.models.length) throw new Error('import failed');
    dialog.importedModels = data.models;
    draft.modelId = data.models[0].id;
    draft.customModel = false;
    draft.thinkingLevel = draft.provider === 'openai-compatible' ? 'auto' : 'off';
    dialog.test = null;
  } catch { if (state.dialog === dialog) dialog.importError = true; }
  finally { dialog.importing = false; if (state.dialog === dialog) bumpDialog(); }
}

async function testModel() {
  const dialog = state.dialog;
  if (!state.modelDraft || dialog.testing || dialog.saving || !$('#model-form').reportValidity()) return;
  const headers = draftHeaders();
  if (headers === null) return;
  const draft = Object.fromEntries(Object.entries(state.modelDraft).filter(([key]) => key !== 'customModel' && key !== 'headersJson').map(([key, value]) => [key, value.trim()]));
  if (headers) draft.headers = headers;
  const signature = JSON.stringify(state.modelDraft);
  dialog.testing = true;
  dialog.test = null;
  bumpDialog();
  try {
    const { status, data } = await request('/app/api/settings/model/test', draft);
    if (state.dialog === dialog && JSON.stringify(state.modelDraft) === signature) {
      dialog.test = status === 200 ? data : { ok: false, error: 'provider_error' };
      if (dialog.test.ok) {
        dialog.acceptedThinkingLevels = data.acceptedThinkingLevels ?? null;
        if (draft.provider === 'openai-compatible' && !['auto', ...(data.acceptedThinkingLevels ?? [])].includes(draft.thinkingLevel)) draft.thinkingLevel = 'auto';
        await loadSettings();
      }
    }
  } catch {
    if (state.dialog === dialog && JSON.stringify(state.modelDraft) === signature) dialog.test = { ok: false, error: 'provider_error' };
  } finally {
    dialog.testing = false;
    if (state.dialog === dialog) bumpDialog();
  }
}

function openProvider(id) {
  const current = state.settings.model;
  const provider = id === MODEL_CUSTOM ? '' : id;
  state.modelDraft = current?.provider === provider
    ? { provider, modelId: current.modelId, baseUrl: current.baseUrl ?? '', apiKey: '', thinkingJson: savedThinkingJson(provider, current.modelId) }
    : { provider, modelId: modelAfterProviderChange(state.settings.providers, provider, '') ?? '', baseUrl: '', apiKey: '', thinkingJson: '' };
  state.dialog = { type: 'provider', rev: 0, returnTo: state.onboarding ? null : 'account', returnFocus: `provider:${id === MODEL_CUSTOM ? 'custom' : state.settings.providers.find((entry) => entry.id === id)?.info?.family ?? id}` };
  const selected = state.settings.providers.find((entry) => entry.id === provider)?.models.find((entry) => entry.id === state.modelDraft.modelId);
  state.modelDraft.customModel = provider.endsWith('-compatible') || Boolean(current?.provider === provider && !selected);
  state.modelDraft.thinkingLevel = provider === 'openai-compatible' ? (current?.provider === provider ? current.thinkingLevel : 'auto') : provider.endsWith('-compatible') ? 'off' : thinkingAfterModelChange(selected, current?.thinkingLevel);
  renderDialog();
  $('#model-key').focus();
}

function renderOnboarding() {
  const page = $('#onboarding');
  const active = !state.setupChecked || state.onboarding !== null;
  if (active) releaseDetailsOverlay({ restoreFocus: false });
  page.hidden = !active;
  const wasHidden = $('#workspace').hidden;
  $('#workspace').hidden = active;
  if (!active) {
    if (wasHidden && state.snapshot) {
      drawn.delete('feed');
      renderFeed(true);
      resizeInput();
    }
    return;
  }
  redraw('onboarding', [getLocale(), state.setupChecked, state.settingsError, state.onboarding, state.settings], () => {
    preservingFocus(page, () => {
      const security = state.onboarding?.step === 'security';
      page.replaceChildren(
        h('header', { class: 'onboarding-header' },
          h('div', { class: 'brand' }, h('img', { class: 'brand-mark', src: '/brand/otto.svg', width: 32, height: 32, alt: '' }), h('span', { class: 'brand-word' }, 'Otto')),
          h('div', { class: 'language-switch' }, ['en', 'zh'].map((locale) => h('button', { type: 'button', dataset: { locale }, 'aria-pressed': String(getLocale() === locale) }, locale === 'en' ? 'EN' : '中文')))),
        h('div', { class: 'onboarding-content' },
          !state.setupChecked ? [h('h1', null, t(state.settingsError ? 'settingsLoadFailed' : 'settingsLoading')),
            state.settingsError ? h('button', { class: 'button primary', dataset: { action: 'retry-settings' } }, t('settingsRetry')) : null] : [
            h('ol', { class: 'setup-steps', 'aria-label': t('setupSteps') },
              h('li', { class: security ? 'is-complete' : 'is-current', 'aria-current': security ? null : 'step' }, h('span', null, security ? icon('check') : '1'), t('setupStepModel')),
              h('li', { class: security ? 'is-current' : '', 'aria-current': security ? 'step' : null }, h('span', null, '2'), t('setupStepSecurity'))),
            h('h1', { id: 'setup-title', tabindex: '-1' }, t(security ? 'setupSecurityTitle' : 'setupWelcome')),
            h('p', { class: 'onboarding-intro' }, t(security ? 'setupSecurityBody' : 'setupWelcomeBody')),
            security ? securitySection() : modelSection(),
            h('footer', { class: 'onboarding-footer' },
              security ? h('button', { class: 'button quiet', disabled: state.onboarding.passkeyAdd === 'creating', dataset: { action: 'setup-back' } }, t('setupBack')) : h('p', { class: 'dialog-hint' }, t('setupKeyRequired')),
              security ? h('button', { class: `button${state.settings.passkeys.length ? ' primary' : ' quiet'}`, disabled: state.onboarding.passkeyAdd === 'creating', dataset: { action: 'setup-finish' } }, t(state.settings.passkeys.length ? 'setupFinish' : 'setupSkip'))
                : state.settings.model?.apiKey ? h('button', { class: 'button primary', dataset: { action: 'setup-next' } }, t('setupContinue')) : null)]));
    });
  });
}

function setSetupStep(step) {
  if (state.onboarding?.passkeyAdd === 'creating') return;
  state.onboarding = { step, passkeyAdd: null, confirm: null };
  renderOnboarding();
  $('#setup-title')?.focus();
}

function finishSetup() {
  if (!state.settings?.model?.apiKey || state.onboarding?.passkeyAdd === 'creating') return;
  try { localStorage.setItem('otto.setup.securitySkipped', 'true'); } catch { /* Storage may be unavailable. */ }
  state.onboarding = null;
  const type = state.initialDialog;
  state.initialDialog = null;
  renderAll();
  if (type) openDialog(type);
  else $('#message-input').focus();
}

function dialogContent() {
  const snapshot = state.snapshot;
  if (state.dialog.type === 'provider') {
    const provider = state.settings.providers.find((entry) => entry.id === state.modelDraft.provider);
    return { title: provider?.info?.familyName || provider?.name || state.modelDraft.provider || t('modelCustomOption'), body: providerSection() };
  }
  if (state.dialog.type === 'directory') return { title: t('directoryPickerTitle'), body: directoryPicker() };
  if (state.dialog.type === 'machines') {
    const summary = summarize(snapshot);
    return {
      title: t('machines'),
      body: [
        h('p', { class: 'dialog-copy' }, t('machineSummary', { online: summary.machinesOnline, total: summary.machinesTotal, running: summary.running })),
        snapshot.machines.map(machineCard),
        pairingSection(),
      ],
    };
  }
  if (state.dialog.type === 'scope') {
    return {
      title: t('scopeNotice'),
      body: [
        h('button', { type: 'button', class: `scope-option${state.selected ? '' : ' selected'}`, dataset: { select: 'all' } }, icon('route'), h('span', null, t('autoRoute'), h('small', null, t('routeHelp'))), state.selected ? null : icon('check')),
        snapshot.threads.map((entry) => h('button', { type: 'button', class: `scope-option${state.selected === entry.id ? ' selected' : ''}`, dataset: { select: entry.id } },
          icon('layers'), h('span', null, entry.title, h('small', null, `${entry.repos.join(', ')}${entry.repos.length ? ' · ' : ''}${stateLabel(entry.state)}`)), state.selected === entry.id ? icon('check') : null)),
      ],
    };
  }
  if (state.dialog.type === 'archive-confirm') return { title: t('archiveConfirmTitle'), body: archiveConfirmSection() };
  if (state.dialog.type === 'diff') {
    const worker = findWorker(state.dialog.workerId);
    return {
      title: t('diffDialogTitle', { branch: worker?.branch ?? state.dialog.workerId }),
      body: worker ? diffBodyNode(worker, true) : h('p', { class: 'diff-note' }, t('sessionMissing')),
    };
  }
  if (state.dialog.type === 'control-plane') {
    return { title: t('controlPlaneTitle'), body: controlPlane.render(snapshot?.controlPlaneSummary) };
  }
  if (state.dialog.type === 'checkpoint') {
    return { title: checkpointModal.title(), body: checkpointModal.render() };
  }
  return { title: t('accountTitle'), body: accountSection() };
}

const controlPlane = createControlPlane({
  request: (path, body) => request(path, body),
  uuid,
  toast,
  bump: () => bumpDialog(),
  refreshWorkspace: () => refresh(),
  openThread: (threadId) => { closeDialog(); select(threadId); },
  serverNow,
});

const checkpointModal = createCheckpointModal({
  request: (path, body) => request(path, body),
  uuid,
  toast,
  bump: () => bumpDialog(),
  refreshWorkspace: () => refresh(),
  openSkillCatalog: (deviceId, repoId) => {
    state.dialog = { type: 'control-plane', rev: 0, pairing: null, confirm: null, passkeyAdd: null };
    drawn.delete('dialog');
    controlPlane.open('skills', { deviceId, repoId });
    renderDialog();
  },
  fillContinuation: (threadId, promptText) => {
    closeDialog();
    select(threadId);
    const input = $('#message-input');
    input.value = promptText;
    state.drafts.set(scopeKey(), promptText);
    $('#send-button').disabled = !promptText.trim();
    resizeInput();
    input.focus();
  },
});

/** Rebuilds the open dialog only when what it shows changed, so a typed key or a selected command survives a refresh. */
function renderDialog() {
  if (!state.dialog) return;
  const { type, rev = 0, pairing = null, confirm = null } = state.dialog;
  const snapshot = state.snapshot;
  const signature = [type, rev, getLocale(), pairing, confirm,
    type === 'machines' ? [state.settings, state.savingAgentModel, state.refreshingAgentModels, state.agentModelNotice, snapshot.machines, snapshot.threads.map((entry) => [entry.id, entry.state, entry.workers.map((worker) => [worker.state, worker.machine])]), minuteBucket()] : null,
    type === 'directory' ? snapshot.machines : null,
    type === 'scope' ? [state.selected, snapshot.threads.map((entry) => [entry.id, entry.title, entry.state, entry.repos])] : null,
    type === 'diff' ? [state.diffRev, state.dialog.workerId] : null,
    type === 'control-plane' ? [controlPlane.signature(), snapshot?.controlPlaneSummary, minuteBucket()] : null,
    type === 'checkpoint' ? [checkpointModal.signature()] : null,
    type === 'archive-confirm' ? [state.dialog.threadId, state.dialog.unmergedWorkers, [...state.archivingThreads]] : null,
    type === 'account' ? [state.settings, state.dialog.passkeyAdd, state.changingModel, working(), state.modelDraftNotice, state.savingAgentModel, state.refreshingAgentModels, state.agentModelNotice, state.snapshot?.machines.map(machine => [machine.id, machine.online])] : null];
  redraw('dialog', signature, () => {
    const { title, body } = dialogContent();
    $('#dialog').classList.toggle('settings-dialog', type === 'account');
    $('#dialog').classList.toggle('directory-dialog', type === 'directory');
    $('#dialog').classList.toggle('diff-dialog', type === 'diff');
    $('#dialog').classList.toggle('control-dialog', type === 'control-plane' || type === 'checkpoint');
    $('#dialog-title').replaceChildren(...(type === 'provider' ? [providerIcon(state.modelDraft.provider), document.createTextNode(title)] : [document.createTextNode(title)]));
    preservingFocus($('#dialog-body'), () => $('#dialog-body').replaceChildren(...[body].flat(Infinity).filter(Boolean)));
  });
  if (!$('#dialog').open) $('#dialog').showModal();
}

/** A local change to the dialog's own state (a pairing command arrived, a confirmation opened). */
function bumpDialog() {
  renderOnboarding();
  if (!state.dialog) return;
  state.dialog.rev = (state.dialog.rev ?? 0) + 1;
  renderDialog();
}

function openDialog(type) {
  state.dialog = { type, rev: 0, pairing: null, confirm: null, passkeyAdd: null };
  state.modelDraftNotice = null;
  state.pushNotice = null; // a fresh visit shows the current state, not the last attempt's result
  drawn.delete('dialog');
  if (type === 'account' || type === 'machines') void loadSettings();
  if (type === 'control-plane') controlPlane.open();
  renderDialog();
  if (type === 'machines') for (const [deviceId, form] of state.directoryForms) {
    if (form.state === 'pending') void runDirectoryRegistration(deviceId, form);
  }
}

function closeDialog() {
  if (state.dialog?.saving || securityState()?.passkeyAdd === 'creating') return;
  if (state.dialog?.type === 'directory' && state.directoryForms.get(state.dialog.deviceId)?.state === 'editing') state.directoryForms.delete(state.dialog.deviceId);
  const returnTo = state.dialog?.returnTo;
  const returnFocus = state.dialog?.returnFocus;
  state.modelDraft = null;
  if (returnTo) {
    state.dialog = { type: returnTo, rev: 0, confirm: null, passkeyAdd: null };
    bumpDialog();
    const target = returnFocus ? document.querySelector(`[data-focus="${CSS.escape(returnFocus)}"]`) : null;
    const details = target?.closest('details');
    if (details) details.open = true;
    target?.focus();
    return;
  }
  state.dialog = null;
  drawn.delete('dialog');
  if ($('#dialog').open) $('#dialog').close();
}

// ---- full-screen states ------------------------------------------------------------------------------

function renderFatal() {
  const current = $('#fatal');
  if (!state.fatal) {
    current?.remove();
    return;
  }
  releaseDetailsOverlay({ restoreFocus: false });
  const [title, body] = FATAL_COPY[state.fatal];
  const next = h('div', { class: 'fatal', id: 'fatal', role: 'alertdialog', 'aria-labelledby': 'fatal-title' },
    h('div', { class: 'fatal-box' }, h('img', { src: '/brand/otto.svg', alt: '' }), h('h2', { id: 'fatal-title' }, t(title)), h('p', null, t(body))));
  if (current) current.replaceWith(next);
  else document.body.append(next);
}

// ---- rendering --------------------------------------------------------------------------------------------

function renderAll({ stick = false } = {}) {
  applyStatic();
  paintIcons();
  renderConnection();
  renderFatal();
  if (!state.snapshot) return;
  $('#workspace').dataset.ready = 'true';
  renderTop();
  renderSidebar();
  renderPane();
  renderTabs();
  renderSetup();
  renderFeed(stick);
  renderContext();
  renderComposer();
  renderDialog();
  syncDetailButton();
}

// ---- data ------------------------------------------------------------------------------------------------

async function request(path, body) {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    // A sign-in that is no longer valid is answered 401 by our own Worker; anything that
    // still manages to redirect is opaque, so treat it as "sign in again" either way.
    redirect: 'manual',
    headers: body === undefined ? {} : { 'content-type': 'application/json', 'x-csrf-token': state.csrf },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.type === 'opaqueredirect') {
    if (state.fatal !== 'logged_out' && !reloadForSignIn()) {
      state.fatal = 'signed_out';
      renderFatal();
    }
    return { status: 401, data: null };
  }
  let data = null;
  try {
    data = await response.json();
  } catch {
    // A proxy error page is not JSON; the status is what matters.
  }
  if (response.status === 401 && state.fatal !== 'logged_out') {
    state.fatal = 'signed_out';
    renderFatal();
  }
  return { status: response.status, data };
}

/**
 * Access wants a fresh sign-in. Reloading lets it re-issue the token silently when its own
 * session is still good (or shows its login page when not). Only with nothing to lose — no
 * draft, no message in flight — and at most once a minute, so a broken setup cannot loop.
 */
function reloadForSignIn() {
  if ($('#message-input').value.trim() || [...state.pending.values()].some((entry) => entry.status === 'sending')) return false;
  if ([...state.directoryForms.values()].some((form) => form.path || form.state === 'pending')) return false;
  try {
    if (Date.now() - Number(sessionStorage.getItem('pip.signin-reload') ?? 0) < 60_000) return false;
    sessionStorage.setItem('pip.signin-reload', String(Date.now()));
  } catch {
    return false; // no storage, no way to rate-limit: show the notice instead
  }
  location.reload();
  return true;
}

let refreshing = false;
let refreshAgain = false;
let retryDelay = 2000;

async function refresh() {
  if (refreshing) {
    refreshAgain = true;
    return;
  }
  refreshing = true;
  try {
    do {
      refreshAgain = false;
      const { status, data } = await request(state.showArchived ? '/app/api/workspace?includeArchived=1' : '/app/api/workspace');
      if (status === 401) return;
      if (status !== 200 || !data) throw new Error(`workspace ${status}`);
      if (state.fatal === 'unreachable') state.fatal = null;
      retryDelay = 2000;
      accept(data);
    } while (refreshAgain);
  } catch {
    // Unreachable: say so (once there is nothing else to show) and keep trying, gently.
    if (!state.snapshot && !state.fatal) state.fatal = 'unreachable';
    if (state.connection === 'live') state.connection = 'reconnecting';
    renderAll();
    setTimeout(refresh, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 20_000);
  } finally {
    refreshing = false;
  }
}

function accept(data) {
  const first = state.snapshot === null;
  state.csrf = data.csrf;
  state.snapshot = data;
  state.skew = data.now - Date.now();
  for (const message of data.messages) {
    if (message.id.startsWith('user:web:')) state.pending.delete(message.id.slice('user:web:'.length));
  }
  if (state.selected && !threadById(state.selected)) {
    state.selected = null; // archived or gone: fall back to the whole conversation
    state.session = null;
    history.replaceState(null, '', '/app');
  } else if (state.session && !threadById(state.selected)?.workers.some((worker) => worker.id === state.session)) {
    state.session = null; // that session is not part of this thread (any more)
    history.replaceState(null, '', urlFor(state.selected, null));
    toast(t('sessionMissing'));
  }
  const ids = new Set(data.attention.map((item) => item.id));
  if (!first && [...ids].some((id) => !state.knownAttention.has(id))) $('#announcer').textContent = t('newDecision');
  state.knownAttention = ids;
  // The words being written give way to the finished message the moment the snapshot has it.
  if (state.live && (state.live.ending || !data.busy)) state.live = null;
  renderAll({ stick: first });
  markSelectedRead();
  if (!socket) connect();
  subscribeThread();
  if (first) {
    void loadSettings(true);
    const dialog = { '/app/machines': 'machines', '/app/settings': 'account' }[location.pathname];
    if (dialog) {
      history.replaceState(null, '', '/app');
      state.initialDialog = dialog;
    }
  }
}

let reading = false;
function markSelectedRead() {
  const thread = state.selected ? threadById(state.selected) : null;
  if (!thread?.unread || reading) return;
  reading = true;
  request(`/app/api/threads/${thread.id}/read`, {}).then(() => refresh()).catch(() => {}).finally(() => { reading = false; });
}

// ---- live updates ----------------------------------------------------------------------------------------

let socket = null;
let attempts = 0;
let reconnectTimer = null;

function connect() {
  clearTimeout(reconnectTimer);
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const current = new WebSocket(`${scheme}//${location.host}/app/ws?view=workspace`);
  socket = current;
  current.addEventListener('open', () => {
    attempts = 0;
    state.connection = 'live';
    renderConnection();
    refresh(); // anything that changed while the socket was down
    if (state.setupChecked) void loadSettings();
  });
  current.addEventListener('message', (event) => {
    let frame;
    try {
      frame = JSON.parse(event.data);
    } catch {
      return; // not a frame of ours
    }
    if (frame.t === 'workspace_changed') scheduleRefresh();
    else if (frame.t === 'thread_events') showThreadRows(frame);
    else if (frame.t === 'thread_state') showThreadState(frame);
    else if (frame.t === 'model_changed') void loadSettings();
    else if (frame.t === 'stream') showLive(frame);
  });
  current.addEventListener('close', () => {
    if (socket !== current || state.fatal === 'signed_out' || state.fatal === 'logged_out') return;
    state.connection = attempts === 0 ? 'reconnecting' : 'disconnected';
    renderConnection();
    reconnectTimer = setTimeout(connect, Math.min(30_000, 1000 * 2 ** attempts) + Math.random() * 400);
    attempts += 1;
  });
  current.addEventListener('error', () => current.close());
}

// ---- the open Thread, live (issues #1 and #4) -------------------------------------------------
// One subscription for whichever Thread the page has open, resumed from the newest row already on
// screen: `sh_timeline.id` is the cursor, so a reconnect asks for the gap and never repeats a row.
// The connection holds the cursor (§6.9), which is why the id we ask from is the one we last drew.

const subscription = { threadId: null, lastId: undefined };

function sendFrame(frame) {
  if (socket?.readyState !== 1) return false;
  socket.send(JSON.stringify(frame));
  return true;
}

/** Follow the open Thread (or stop following, on the whole-conversation view). Called whenever the
 *  socket opens, the page is refetched, or the reader moves to another Thread. */
function subscribeThread() {
  const thread = state.selected ? threadById(state.selected) : null;
  if (!thread) {
    if (subscription.threadId !== null) sendFrame({ t: 'unsubscribe_thread' });
    subscription.threadId = null;
    subscription.lastId = undefined;
    return;
  }
  const after = lastTimelineId(thread.timeline);
  if (!sendFrame({ t: 'subscribe_thread', threadId: thread.id, ...(after === undefined ? {} : { after }) })) return;
  subscription.threadId = thread.id;
  subscription.lastId = after;
}

const patchThread = (threadId, change) => {
  state.snapshot.threads = state.snapshot.threads.map((entry) => (entry.id === threadId ? change(entry) : entry));
};

/** `thread_events`: rows of the open Thread, oldest first — appended, never refetched. */
function showThreadRows(frame) {
  const thread = state.selected ? threadById(state.selected) : null;
  if (!thread || frame.threadId !== thread.id) return;
  const timeline = mergeTimeline(thread.timeline, frame.events);
  patchThread(thread.id, (entry) => ({ ...entry, timeline }));
  subscription.lastId = lastTimelineId(timeline) ?? subscription.lastId;
  if (state.snapshot) {
    renderContext();
    renderSidebar();
  }
}

/** `thread_state`: the chip, the workers' states, the open-question count. */
function showThreadState(frame) {
  const thread = state.selected ? threadById(state.selected) : null;
  if (!thread || frame.threadId !== thread.id) return;
  const next = applyThreadState(thread, frame);
  patchThread(thread.id, () => next.thread);
  if (!state.snapshot) return;
  renderFeed(false); // the state chip in the heading
  renderContext();
  renderSidebar();
  // A worker this page has never seen arrives only with a snapshot (agent, branch, machine…).
  if (next.unknownWorkers) void refresh();
}

/** `workspace_changed` while a Thread is subscribed: the frames above have already shown what is
 *  new, so the refetch waits a beat and coalesces a burst into one request (it still reconciles
 *  everything the frames do not carry: cards, other Threads, settings). Without a subscription
 *  nothing else is coming, so it refetches at once, exactly as before. */
let refreshTimer = null;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => { refreshTimer = null; void refresh(); }, subscription.threadId ? 500 : 0);
}

let liveTimer;

/** A `stream` frame: the reply so far. An empty one means the run ended; the snapshot that carries the final message removes the words. */
function showLive(frame) {
  clearTimeout(liveTimer);
  if (frame.text) state.live = { text: frame.text, threadId: frame.threadId ?? null, ending: false };
  else if (state.live) {
    state.live.ending = true;
    liveTimer = setTimeout(() => { state.live = null; if (state.snapshot) renderFeed(false); }, 4000);
  }
  if (state.snapshot) renderFeed(false);
}

// ---- actions -----------------------------------------------------------------------------------------------

async function postMessage(entry) {
  entry.status = 'sending';
  renderFeed(true);
  renderComposer();
  try {
    const { status, data } = await request('/app/api/messages', { id: entry.id, text: entry.text, threadId: entry.threadId ?? undefined, replyTo: entry.replyTo ?? undefined });
    if (status === 202) {
      await refresh();
      return;
    }
    if (status === 429) toast(t('queueFull'));
    else if (status === 400 || status === 413) toast(t('tooLong'));
    else if (status !== 401) toast(t('sendFailed'));
    if (data?.error === 'id_conflict') state.pending.delete(entry.id);
  } catch {
    toast(t('sendFailed'));
  }
  entry.status = 'failed';
  renderFeed(true);
  renderComposer();
}

function send() {
  const input = $('#message-input');
  const text = input.value;
  if (!text.trim() || state.changingModel) return;
  const entry = { id: uuid(), text, threadId: state.selected, replyTo: state.replyTo, at: Date.now(), status: 'sending' };
  state.pending.set(entry.id, entry);
  input.value = '';
  state.drafts.delete(scopeKey());
  state.replyTo = null;
  $('#send-button').disabled = true;
  resizeInput();
  void postMessage(entry);
}

/**
 * ADR-0017: stop the turn that is running. The server answers what it stopped ('none' when the
 * turn had already finished), and the cancelled reply arrives through the ordinary feed — the
 * stop itself only has to clear the working row.
 */
async function stopTurn() {
  if (state.stopping) return;
  state.stopping = true;
  renderFeed(false);
  try {
    const { status, data } = await request('/app/api/turn/stop', { id: uuid() });
    const copy = data?.stopped === 'none' ? 'stopTurnNone' : 'stopTurnDone';
    if (status !== 200) toast(t('stopTurnFailed'));
    else toast(t(copy));
    await refresh();
  } catch {
    toast(t('stopTurnFailed'));
  } finally {
    state.stopping = false;
    renderFeed(false);
  }
}

async function act(cardId, action) {
  if (state.busyCards.has(cardId)) return;
  state.busyCards.add(cardId);
  renderFeed(false);
  renderContext();
  try {
    const { status } = await request('/app/api/actions', { id: uuid(), cardId, action });
    if (status === 409) toast(t('cardAlreadyHandled'));
    else if (status !== 202 && status !== 401) toast(t('actionFailed'));
    await refresh();
  } catch {
    toast(t('actionFailed'));
  } finally {
    state.busyCards.delete(cardId);
    renderFeed(false);
    renderContext();
  }
}

async function signOut() {
  // Find the browser's subscription even when Settings was never opened in this session.
  let subscription = state.pushSubscription;
  if (!subscription && 'serviceWorker' in navigator) {
    try { subscription = await withPushTimeout((await withPushTimeout(navigator.serviceWorker.getRegistration('/app/')))?.pushManager?.getSubscription()); }
    catch { /* sign-out must still work */ }
  }
  if (subscription) {
    try { localStorage.setItem('otto.push.disabled', 'true'); } catch { /* private mode */ }
    try { await withPushTimeout(request('/app/api/push/unsubscribe', { endpoint: subscription.endpoint })); } catch { /* local unsubscribe still revokes the endpoint */ }
    try { await withPushTimeout(subscription.unsubscribe()); } catch { /* sign-out must not wait forever for the push service */ }
  }
  state.fatal = 'logged_out'; // set first: the logout response must not read as an expired session
  try {
    await request('/app/api/logout', {});
  } catch {
    // The cookie is what matters; if the request failed the session simply expires on its own.
  }
  socket?.close();
  unmountViewer();
  closeDialog();
  renderFatal();
  location.assign('/app'); // back to the shared password/passkey sign-in page (ADR-0010)
}

// ---- settings, pairing, revoking ---------------------------------------------------------------------------

function pushKeyBytes(value) {
  const raw = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4));
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}

function pushKeyMatches(subscription, publicKey) {
  const existing = subscription.options?.applicationServerKey;
  if (!existing) return true; // older browsers do not expose subscription options
  const expected = pushKeyBytes(publicKey);
  const actual = new Uint8Array(existing);
  return actual.length === expected.length && actual.every((byte, index) => byte === expected[index]);
}

function pushDisabledLocally() {
  try { return localStorage.getItem('otto.push.disabled') === 'true'; } catch { return false; }
}

function withPushTimeout(promise, ms = 10000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('push_timeout')), ms);
  })]).finally(() => clearTimeout(timer));
}

async function refreshPushSubscription() {
  if (!state.settings?.push?.available || !('serviceWorker' in navigator)) return;
  try {
    const registration = await withPushTimeout(navigator.serviceWorker.getRegistration('/app/'));
    let subscription = await withPushTimeout(registration?.pushManager?.getSubscription());
    if (pushDisabledLocally()) {
      // A server-revoked endpoint is inert. Keep the browser subscription so a later
      // explicit opt-in can reuse it without waiting for FCM to unsubscribe first.
      // Never silently re-register a device the owner explicitly turned off.
      state.pushSubscription = null;
    } else {
      if (subscription && !pushKeyMatches(subscription, state.settings.push.publicKey)) {
        await withPushTimeout(request('/app/api/push/unsubscribe', { endpoint: subscription.endpoint }));
        await withPushTimeout(subscription.unsubscribe());
        subscription = null;
      }
      state.pushSubscription = subscription ?? null;
      if (subscription) await withPushTimeout(request('/app/api/push/subscribe', {
        subscription: subscription.toJSON(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', quiet: state.pushQuiet,
      }));
    }
  } catch { /* In-app inbox remains available without push. */ }
  if (state.dialog?.type === 'account') bumpDialog();
}

/** The result goes into the dialog (a toast paints under a modal backdrop) and out to the toast. */
function pushResult(key) {
  state.pushNotice = key;
  toast(t(key));
}

async function enablePush() {
  if (state.pushBusy || !state.settings?.push?.available || !isSecureContext) return;
  state.pushBusy = true;
  state.pushAction = 'push-enable';
  state.pushNotice = null;
  bumpDialog();
  try {
    // iOS requires permission in the direct tap gesture, before any async registration.
    if (await withPushTimeout(Notification.requestPermission(), 30000) !== 'granted') throw new Error('permission');
    const registration = await withPushTimeout(navigator.serviceWorker.register('/app/push-sw.js', { scope: '/app/' }));
    let subscription = await withPushTimeout(registration.pushManager.getSubscription());
    if (subscription && !pushKeyMatches(subscription, state.settings.push.publicKey)) {
      await withPushTimeout(request('/app/api/push/unsubscribe', { endpoint: subscription.endpoint }));
      await withPushTimeout(subscription.unsubscribe());
      subscription = null;
    }
    subscription ??= await withPushTimeout(registration.pushManager.subscribe({
      userVisibleOnly: true, applicationServerKey: pushKeyBytes(state.settings.push.publicKey),
    }));
    const { status } = await withPushTimeout(request('/app/api/push/subscribe', {
      subscription: subscription.toJSON(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', quiet: state.pushQuiet,
    }));
    if (status !== 200) {
      void subscription.unsubscribe().catch(() => {});
      throw new Error('subscribe');
    }
    state.pushSubscription = subscription;
    try { localStorage.removeItem('otto.push.disabled'); } catch { /* private mode */ }
    pushResult('pushReady');
  } catch {
    pushResult(Notification.permission === 'denied' ? 'pushDenied' : 'pushFailed');
  }
  finally { state.pushBusy = false; state.pushAction = null; bumpDialog(); }
}

async function disablePush() {
  if (state.pushBusy || !state.pushSubscription) return;
  state.pushBusy = true;
  state.pushAction = 'push-disable';
  state.pushNotice = null;
  bumpDialog();
  try {
    const subscription = state.pushSubscription;
    const { status } = await withPushTimeout(request('/app/api/push/unsubscribe', { endpoint: subscription.endpoint }));
    if (status !== 200) throw new Error('unsubscribe');
    try { localStorage.setItem('otto.push.disabled', 'true'); } catch { /* private mode */ }
    state.pushSubscription = null;
    // The server has revoked this endpoint and local opt-out blocks auto-renewal.
    // Chrome can stall indefinitely on unsubscribe(); do not start it at all.
    // Re-enabling can reuse the browser subscription without contacting FCM.
    pushResult('pushOff');
  } catch { pushResult('pushFailed'); }
  finally { state.pushBusy = false; state.pushAction = null; bumpDialog(); }
}

async function testPush() {
  if (state.pushBusy || !state.pushSubscription) return;
  state.pushBusy = true;
  state.pushAction = 'push-test';
  state.pushNotice = null;
  bumpDialog();
  try {
    const subscription = state.pushSubscription;
    const { status } = await withPushTimeout(request('/app/api/push/test', { endpoint: subscription.endpoint }));
    // "Queued" is all the server can promise: the phone shows it only once its own push
    // service hands the notification over, which may take a retry.
    pushResult(status === 200 ? 'pushTestSent' : 'pushFailed');
  } catch { pushResult('pushFailed'); }
  finally { state.pushBusy = false; state.pushAction = null; bumpDialog(); }
}

async function setPushQuiet(quiet) {
  if (state.pushBusy || !state.pushSubscription) return;
  state.pushBusy = true;
  state.pushAction = 'push-quiet';
  state.pushNotice = null;
  bumpDialog();
  try {
    const { status } = await withPushTimeout(request('/app/api/push/subscribe', {
      subscription: state.pushSubscription.toJSON(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', quiet,
    }));
    if (status !== 200) throw new Error('quiet');
    state.pushQuiet = quiet;
    try { localStorage.setItem('otto.push.quiet', String(quiet)); } catch { /* private mode */ }
    pushResult('pushQuietSaved');
  } catch { pushResult('pushFailed'); }
  finally { state.pushBusy = false; state.pushAction = null; bumpDialog(); }
}

try { state.pushQuiet = localStorage.getItem('otto.push.quiet') !== 'false'; } catch { /* private mode */ }

async function loadSettings(initial = false) {
  try {
    const { status, data } = await request('/app/api/settings');
    if (status === 401) return;
    if (status !== 200 || !data) throw new Error('settings_failed');
    state.settings = data;
    renderComposerModels();
    state.settingsError = false;
    if (initial || !state.setupChecked) {
      state.setupChecked = true;
      let skipped = false;
      try { skipped = localStorage.getItem('otto.setup.securitySkipped') === 'true'; } catch { /* Storage may be unavailable. */ }
      const step = initialSetupStep(data, state.snapshot.messages.length > 0, skipped);
      if (step) setSetupStep(step);
      else if (state.initialDialog) {
        const type = state.initialDialog;
        state.initialDialog = null;
        openDialog(type);
      }
    }
    renderSetup();
    if (state.dialog?.type === 'account' || state.dialog?.type === 'machines') bumpDialog();
    if (state.dialog?.type === 'account') void refreshPushSubscription();
    return true;
  } catch {
    state.settingsError = true;
    renderOnboarding();
    bumpDialog();
    return false;
  }
}

/** Issues #70/#74: provider + modelId (+ optional baseUrl) switched without a redeploy.
 *  The API key is optional once the provider has a sealed one — switching back to a keyed
 *  provider is the whole point — and a pasted key reseals it. */
async function saveModel() {
  const draft = state.modelDraft;
  if (!draft || state.dialog?.saving || state.dialog?.testing) return;
  const provider = draft.provider.trim();
  const modelId = draft.modelId.trim();
  const baseUrl = draft.baseUrl.trim();
  const apiKey = draft.apiKey.trim();
  const headers = draftHeaders();
  if (headers === null) return;
  if (!provider || !modelId) return;
  if (!$('#model-form').reportValidity()) return;
  const catalog = state.settings.providers.find((entry) => entry.id === provider);
  if (catalog && !catalog.models.some((entry) => entry.id === modelId) && !baseUrl) { toast(t('modelChooseKnown')); return; }
  if (!apiKey && !(state.settings?.keyedProviders ?? []).includes(provider)) {
    toast(t('modelKeyMissing'));
    return;
  }
  const dialog = state.dialog;
  dialog.saving = true;
  dialog.saveError = false;
  bumpDialog();
  try {
    const declared = parseDeclaredLevels(draft.thinkingJson ?? '');
    if (declared === undefined) { toast(t('modelLevelsInvalid')); return; }
    const autoTest = dialog.autoTest !== false;
    const { status, data } = await request('/app/api/settings/model', { provider, modelId, ...(apiKey ? { apiKey } : {}), ...(baseUrl ? { baseUrl } : {}), ...(headers ? { headers } : {}), thinkingJson: draft.thinkingJson ?? '', autoTest, ...(dialog.importedModels?.length ? { importedModelIds: dialog.importedModels.map((entry) => entry.id) } : {}), thinkingLevel: draft.thinkingLevel ?? 'off' });
    if (status === 200 && data?.activated === true) {
      draft.apiKey = '';
      if (data?.acceptedThinkingLevels?.length) toast(t('modelAutoTested', { levels: data.acceptedThinkingLevels.map((level) => t(`thinking_${level}`)).join(' / ') }));
      else toast(t('modelSaved'));
      const loaded = await loadSettings();
      dialog.saving = false;
      if (!loaded) { dialog.saveError = true; return bumpDialog(); }
      closeDialog();
      if (state.onboarding) setSetupStep('security');
      await refresh();
    } else if (status === 200) {
      // The check runs before the commit, so nothing was written: keep the dialog, the typed
      // values and the key (fixing and retrying is one click) and say why it did not switch.
      draft.apiKey = ''; // persisted sealed in the candidate, never echoed back
      await loadSettings();
      dialog.saveError = { testError: typeof data.testError === 'string' ? data.testError : null, status: data.status };
    } else if (status !== 401) dialog.saveError = true;
  } catch {
    dialog.saveError = true;
  } finally {
    dialog.saving = false;
    bumpDialog();
  }
}

async function modelDraftAction(dataset) {
  if (state.changingModel) return;
  state.changingModel = true;
  state.modelDraftNotice = null;
  bumpDialog();
  try {
    const { status, data } = await request('/app/api/settings/model/draft', { id: dataset.id, revision: Number(dataset.revision), action: dataset.operation });
    if (status === 200) {
      await loadSettings();
      if (data.status === 'conflict' || data.status === 'busy') state.modelDraftNotice = `modelDraft_${data.status}`;
      if (data.activated && state.onboarding) setSetupStep('security');
    } else if (status !== 401) state.modelDraftNotice = status === 409 ? 'modelDraft_conflict' : 'modelSaveFailed';
  } catch { state.modelDraftNotice = 'modelSaveFailed'; }
  finally { state.changingModel = false; bumpDialog(); renderSetup(); renderComposerModels(); }
}

async function createPairing() {
  if (state.dialog?.type !== 'machines') return;
  state.dialog.pairing = 'creating';
  bumpDialog();
  let pairing = 'failed';
  try {
    const { status, data } = await request('/app/api/pairing', { id: uuid() });
    if (status === 200 && typeof data?.command === 'string') pairing = { command: data.command, expiresAt: data.expiresAt };
  } catch {
    // shown as a failure below
  }
  if (state.dialog?.type !== 'machines') return;
  state.dialog.pairing = pairing;
  bumpDialog();
}

const directoryRequests = new Set();

async function submitDirectory(deviceId, element) {
  const form = state.directoryForms.get(deviceId);
  if (!form || form.state === 'pending' || (element && !element.reportValidity())) return;
  const requestBody = form.state === 'retry' ? form.request : { id: uuid(), deviceId, path: form.path };
  const pending = { state: 'pending', path: form.path, request: requestBody, startedAt: Date.now() };
  state.directoryForms.set(deviceId, pending);
  bumpDialog();
  await runDirectoryRegistration(deviceId, pending);
}

async function runDirectoryRegistration(deviceId, pending) {
  if (directoryRequests.has(deviceId)) return;
  directoryRequests.add(deviceId);
  try {
    while (state.directoryForms.get(deviceId) === pending && (state.dialog?.type === 'machines' || (state.dialog?.type === 'directory' && state.dialog.deviceId === deviceId)) && !state.fatal) {
      let response;
      try {
        response = await request('/app/api/machines/directories', pending.request);
      } catch {
        state.directoryForms.set(deviceId, { ...pending, state: 'retry' });
        break;
      }
      if (state.directoryForms.get(deviceId) !== pending) return;
      const { status, data } = response;
      if (status === 200 && data?.state === 'done' && typeof data.repo?.path === 'string') {
        state.directoryForms.set(deviceId, { state: 'done', path: pending.path, repo: data.repo });
        await refresh();
        break;
      }
      if (status === 200 && data?.state === 'failed') {
        state.directoryForms.set(deviceId, { state: 'failed', path: pending.path, code: data.code });
        break;
      }
      if (status !== 202 || data?.state !== 'pending') {
        state.directoryForms.set(deviceId, status >= 500
          ? { ...pending, state: 'retry' }
          : { state: 'failed', path: pending.path, code: data?.error });
        break;
      }
      if (Date.now() - pending.startedAt > 125_000) {
        state.directoryForms.set(deviceId, { state: 'failed', path: pending.path, code: 'outcome_unknown' });
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  } finally {
    directoryRequests.delete(deviceId);
    bumpDialog();
  }
}

async function copyPairing() {
  const pairing = state.dialog?.pairing;
  if (!pairing || typeof pairing !== 'object') return;
  try {
    await navigator.clipboard.writeText(pairing.command);
    toast(t('pairingCopied'));
  } catch {
    toast(t('pairingCopyFailed'));
  }
}

async function revokeMachine(deviceId) {
  try {
    const { status } = await request('/app/api/machines/revoke', { deviceId });
    if (status !== 200 && status !== 401) toast(t('revokeFailed'));
  } catch {
    toast(t('revokeFailed'));
  }
  if (state.dialog) state.dialog.confirm = null;
  await refresh();
  bumpDialog();
}

// ---- passkeys --------------------------------------------------------------------------------------------

function b64urlToBuffer(value) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function bufferToB64url(buffer) {
  let binary = '';
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A UA-sniffed fallback when the owner leaves the label field blank — a guess at the device's
 *  name, not interface copy, so it is not routed through t(). */
function defaultPasskeyLabel() {
  const ua = navigator.userAgent ?? '';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Android/.test(ua)) return 'Android';
  if (/Windows/.test(ua)) return 'Windows PC';
  return 'Passkey';
}

// WebAuthn's RP ID must be a "valid domain string", and an IP literal is not one
// (w3c/webauthn#1358): over https://<ip> the API exists but every ceremony throws SecurityError.
// Local to this file because the workspace page loads exactly one script.
function isIpLiteralHost() {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(location.hostname) || location.hostname.includes(':');
}

/** addPasskey(): see candidate-2 design §Usage 1 for the full call sequence. */
async function addPasskey() {
  const security = securityState();
  if (!security || security.passkeyAdd === 'creating') return;
  if (!window.PublicKeyCredential || isIpLiteralHost()) {
    security.passkeyAdd = 'unsupported';
    return bumpDialog();
  }
  const label = state.passkeyLabelDraft.trim() || defaultPasskeyLabel();
  security.passkeyAdd = 'creating';
  bumpDialog();
  try {
    const { status, data } = await request('/app/api/settings/webauthn/register/options', {});
    if (status === 403) {
      location.assign(`/?reauth=1&next=${encodeURIComponent(location.pathname)}`);
      return;
    }
    if (status !== 200 || !data) throw new Error('options_failed');
    let credential;
    try {
      credential = await navigator.credentials.create({
        publicKey: {
          challenge: b64urlToBuffer(data.challenge),
          rp: { id: data.rpId, name: 'Otto' },
          user: { id: b64urlToBuffer(data.userId), name: 'owner', displayName: 'Otto' },
          pubKeyCredParams: [{ alg: -7, type: 'public-key' }, { alg: -257, type: 'public-key' }],
          authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
          excludeCredentials: data.excludeCredentials.map((entry) => ({ id: b64urlToBuffer(entry.id), type: 'public-key', transports: entry.transports })),
          attestation: 'none',
        },
      });
    } catch {
      // The user cancelled the platform prompt, or no compatible authenticator answered —
      // not a failure worth a toast, just back to the idle add-a-passkey state.
      security.passkeyAdd = null;
      return bumpDialog();
    }
    const { status: verifyStatus } = await request('/app/api/settings/webauthn/register/verify', {
      challengeToken: data.challengeToken,
      clientDataJSON: bufferToB64url(credential.response.clientDataJSON),
      attestationObject: bufferToB64url(credential.response.attestationObject),
      label,
    });
    if (verifyStatus === 403) {
      location.assign(`/?reauth=1&next=${encodeURIComponent(location.pathname)}`);
      return;
    }
    if (verifyStatus !== 200) throw new Error('verify_failed');
    state.passkeyLabelDraft = '';
    security.passkeyAdd = null;
    toast(t('passkeyAdded'));
    await loadSettings();
  } catch {
    security.passkeyAdd = 'failed';
    bumpDialog();
  }
}

/** removePasskey(credentialId): see candidate-2 design §Usage 3. */
async function removePasskey(credentialId) {
  try {
    const { status } = await request('/app/api/settings/webauthn/remove', { credentialId });
    if (status === 403) {
      location.assign(`/?reauth=1&next=${encodeURIComponent(location.pathname)}`);
      return;
    }
    if (status !== 200 && status !== 401) toast(t('passkeyRemoveFailed'));
  } catch {
    toast(t('passkeyRemoveFailed'));
  }
  if (securityState()) securityState().confirm = null;
  await loadSettings();
  bumpDialog();
}

// ---- navigation ------------------------------------------------------------------------------------------

const scopeKey = () => state.selected ?? 'all';

/** Where the address says we are: a thread, and within it one worker's recorded session. */
const routeFromLocation = () => {
  const match = /^\/app\/threads\/([\w-]+)(?:\/workers\/([\w.-]+))?\/?$/.exec(location.pathname);
  return { thread: match?.[1] ?? null, worker: match?.[2] ?? null };
};

function go({ thread = null, worker = null } = {}, { push = true } = {}) {
  const next = thread && threadById(thread) ? thread : null;
  const nextWorker = next && worker && threadById(next).workers.some((entry) => entry.id === worker) ? worker : null;
  const input = $('#message-input');
  state.drafts.set(scopeKey(), input.value);
  const changed = next !== state.selected || nextWorker !== state.session;
  state.selected = next;
  state.session = nextWorker;
  input.value = state.drafts.get(scopeKey()) ?? '';
  $('#send-button').disabled = !input.value.trim();
  if (push && changed) history.pushState(null, '', urlFor(next, nextWorker));
  setMobile('chat');
  releaseDetailsOverlay({ restoreFocus: false });
  resizeInput();
  renderAll({ stick: true });
  markSelectedRead();
  subscribeThread();
}

const select = (threadId, options) => go({ thread: threadId }, options);

/** The session the thread's "Agent sessions" tab opens: the one working now, else the newest. */
function latestWorker(thread) {
  const newest = [...thread.workers].sort((a, b) => b.createdAt - a.createdAt);
  return newest.find(isActiveWorker) ?? newest[0] ?? null;
}

function setMobile(view) {
  $('#workspace').dataset.mobile = view;
  syncDetailButton();
  for (const button of document.querySelectorAll('[data-mobile-view]')) {
    const active = button.dataset.mobileView === view;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
}

function sidebarOpen() {
  return matchMedia('(max-width: 650px)').matches ? $('#workspace').dataset.mobile === 'threads' : !$('#workspace').classList.contains('sidebar-hidden');
}

function toggleSidebar() {
  if (matchMedia('(max-width: 650px)').matches) return setMobile(sidebarOpen() ? 'chat' : 'threads');
  $('#workspace').classList.toggle('sidebar-hidden');
  try { localStorage.setItem('otto.sidebar.hidden', String(!sidebarOpen())); } catch { /* Storage may be unavailable. */ }
  syncDetailButton();
  resizeInput();
}

function detailsOpen() {
  const workspace = $('#workspace');
  return detailsMedia.matches ? detailsOverlay !== null : !workspace.classList.contains('context-hidden');
}

function syncDetailButton() {
  for (const button of document.querySelectorAll('.sidebar-toggle')) button.setAttribute('aria-expanded', String(sidebarOpen()));
  for (const button of document.querySelectorAll('.detail-toggle')) button.setAttribute('aria-expanded', String(detailsOpen()));
}

function detailControls() {
  return [...$('#context-panel').querySelectorAll('a[href], button, input, select, textarea, summary, [tabindex]')]
    .filter((element) => element.tabIndex >= 0 && !element.disabled && !element.closest('[hidden], [inert]') && element.getClientRects().length);
}

function focusDetails() {
  (detailControls()[0] ?? $('#context-panel')).focus({ preventScroll: true });
}

function releaseDetailsOverlay({ restoreFocus = true } = {}) {
  if (!detailsOverlay) return;
  const { returnFocus, background } = detailsOverlay;
  detailsOverlay = null;
  $('#workspace').classList.remove('context-overlay');
  const panel = $('#context-panel');
  panel.removeAttribute('role');
  panel.removeAttribute('aria-modal');
  for (const element of background) element.inert = false;
  syncDetailButton();
  if (restoreFocus && returnFocus?.isConnected && returnFocus.getClientRects().length && !returnFocus.closest('[inert]')) returnFocus.focus({ preventScroll: true });
}

function openDetails() {
  if (detailsMedia.matches) {
    if (detailsOverlay) return;
    const panel = $('#context-panel');
    for (const popover of document.querySelectorAll(':popover-open')) if (!panel.contains(popover)) popover.hidePopover();
    const background = [...$('#workspace').children].filter((element) => element !== panel && !element.classList.contains('panel-scrim') && !element.inert);
    detailsOverlay = { returnFocus: document.activeElement, background };
    $('#workspace').classList.add('context-overlay');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    for (const element of background) element.inert = true;
    focusDetails();
  } else {
    $('#workspace').classList.remove('context-hidden');
    try { localStorage.setItem('otto.context.hidden', 'false'); } catch { /* Storage may be unavailable. */ }
  }
  syncDetailButton();
}

function closeDetails() {
  releaseDetailsOverlay();
  if (!detailsMedia.matches) {
    $('#workspace').classList.add('context-hidden');
    try { localStorage.setItem('otto.context.hidden', 'true'); } catch { /* Storage may be unavailable. */ }
  }
  syncDetailButton();
}

function changeLanguage(locale) {
  if (!setLocale(locale)) return;
  renderAll();
  state.viewer?.handle.relabel();
  resizeInput();
}

function jumpTo(messageId) {
  const message = state.snapshot.messages.find((entry) => entry.id === messageId);
  if (!message) return;
  if (state.selected && message.threadId !== state.selected) select(message.threadId);
  setMobile('chat');
  releaseDetailsOverlay({ restoreFocus: false });
  const target = document.getElementById(messageId);
  if (!target) return;
  target.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
  target.classList.add('flash');
  setTimeout(() => target.classList.remove('flash'), 1600);
}

// ---- events -----------------------------------------------------------------------------------------------

$('#composer-form').addEventListener('submit', (event) => {
  event.preventDefault();
  send();
});
$('#message-input').addEventListener('input', () => {
  $('#send-button').disabled = state.changingModel || !$('#message-input').value.trim();
  resizeInput();
});
$('#message-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $('#composer-form').requestSubmit();
  }
});
$('#thread-search').addEventListener('input', (event) => {
  state.filter = event.target.value;
  if (state.snapshot) renderSidebar();
});
window.addEventListener('popstate', () => go(routeFromLocation(), { push: false }));
window.addEventListener('resize', () => {
  syncDetailButton();
  resizeInput();
});
detailsMedia.addEventListener('change', () => {
  releaseDetailsOverlay();
  syncDetailButton();
});
window.addEventListener('storage', (event) => {
  if (event.key === 'pip.locale') changeLanguage(event.newValue === 'zh' ? 'zh' : 'en');
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  void refresh();
  if (socket && socket.readyState > 1 && !state.fatal) connect();
});
$('#dialog').addEventListener('close', () => { if (!$('#dialog').open) { state.dialog = null; state.modelDraft = null; } });
$('#dialog').addEventListener('cancel', (event) => { event.preventDefault(); closeDialog(); });
$('#dialog').addEventListener('click', (event) => {
  if (event.target !== $('#dialog')) return;
  const rect = $('#dialog').getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeDialog();
});
document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k' && !$('#dialog').open && !state.onboarding) {
    event.preventDefault();
    releaseDetailsOverlay({ restoreFocus: false });
    if (!matchMedia('(max-width: 650px)').matches && !sidebarOpen()) toggleSidebar();
    setMobile('threads');
    $('#thread-search').focus();
  }
  if (!detailsOverlay || $('#dialog').open) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    closeDetails();
  } else if (event.key === 'Tab') {
    const controls = detailControls();
    const edge = event.shiftKey ? controls[0] : controls.at(-1);
    if (!controls.length || document.activeElement === edge || !$('#context-panel').contains(document.activeElement)) {
      event.preventDefault();
      ((event.shiftKey ? controls.at(-1) : controls[0]) ?? $('#context-panel')).focus();
    }
  }
});
document.addEventListener('focusin', (event) => {
  if (detailsOverlay && !$('#dialog').open && !$('#context-panel').contains(event.target)) focusDetails();
});

document.addEventListener('click', (event) => {
  const link = event.target.closest('a[data-nav]');
  if (link && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
    event.preventDefault();
    closeDialog();
    go(link.dataset.nav === 'all' ? {} : { thread: link.dataset.nav, worker: link.dataset.worker ?? null });
    return;
  }
  const button = event.target.closest('button');
  if (!button) return;
  const { dataset } = button;
  if (dataset.locale) return changeLanguage(dataset.locale);
  if (dataset.mobileView) return setMobile(dataset.mobileView);
  if (dataset.card && dataset.action) return void act(dataset.card, dataset.action);
  if (dataset.view) {
    const thread = state.selected ? threadById(state.selected) : null;
    if (!thread) return;
    if (dataset.view === 'conversation') return go({ thread: thread.id });
    const worker = latestWorker(thread);
    return worker ? go({ thread: thread.id, worker: worker.id }) : undefined;
  }
  if (dataset.reply) {
    releaseDetailsOverlay({ restoreFocus: false });
    setMobile('chat');
    state.replyTo = dataset.reply;
    renderComposer();
    $('#message-input').focus();
    return;
  }
  if (dataset.retry) {
    const entry = state.pending.get(dataset.retry);
    if (entry) void postMessage(entry);
    return;
  }
  if (dataset.select) {
    closeDialog();
    return select(dataset.select === 'all' ? null : dataset.select);
  }
  if (dataset.jump) return jumpTo(dataset.jump);
  switch (dataset.action) {
    case 'stop-turn': return void stopTurn();
    case 'provider': return openProvider(dataset.provider);
    case 'provider-variant': return selectProviderVariant(dataset.provider);
    case 'test-model': return void testModel();
    case 'model-draft': return void modelDraftAction(dataset);
    case 'toggle-key':
      state.dialog.showKey = !state.dialog.showKey;
      return bumpDialog();
    case 'retry-settings': return void loadSettings(!state.setupChecked);
    case 'setup-back': return setSetupStep('model');
    case 'setup-next': return setSetupStep('security');
    case 'setup-finish': return finishSetup();
    case 'all': return select(null);
    case 'new':
      select(null);
      $('#message-input').focus();
      return toast(t('newTaskHint'));
    case 'control-plane': return openDialog('control-plane');
    case 'repo-skills':
      state.dialog = { type: 'control-plane', rev: 0, pairing: null, confirm: null, passkeyAdd: null };
      drawn.delete('dialog');
      controlPlane.open('skills');
      return renderDialog();
    case 'machine-skills':
      state.dialog = { type: 'control-plane', rev: 0, pairing: null, confirm: null, passkeyAdd: null };
      drawn.delete('dialog');
      controlPlane.open('skills', { deviceId: dataset.machine });
      return renderDialog();
    case 'machines': return openDialog('machines');
    case 'account': return openDialog('account');
    case 'scope': return openDialog('scope');
    case 'close-dialog': return closeDialog();
    case 'sidebar': return toggleSidebar();
    case 'details': return detailsOpen() ? closeDetails() : openDetails();
    case 'attention':
      select(null);
      return openDetails();
    case 'close-details': return closeDetails();
    case 'clear-search':
      state.filter = '';
      $('#thread-search').value = '';
      renderSidebar();
      return $('#thread-search').focus();
    case 'clear-reply':
      state.replyTo = null;
      return renderComposer();
    case 'sign-out': return void signOut();
    case 'push-enable': return void enablePush();
    case 'push-disable': return void disablePush();
    case 'push-test': return void testPush();
    case 'push-quiet': return void setPushQuiet(!state.pushQuiet);
    case 'create-pairing': return void createPairing();
    case 'copy-pairing': return void copyPairing();
    case 'agent-model-refresh': return void refreshAgentModels(button);
    case 'directory-open': return openDirectoryPicker(dataset.machine);
    case 'directory-navigate': return void browseDirectory(dataset.path);
    case 'directory-manual': {
      const dialog = state.dialog;
      dialog.manual = !dialog.manual;
      const form = state.directoryForms.get(dialog.deviceId);
      if (form?.state === 'editing') form.path = dialog.browse.listing?.path ?? '';
      bumpDialog();
      if (dialog.manual) document.getElementById(`directory-path-${dialog.deviceId}`)?.focus();
      return;
    }
    case 'directory-add-current': {
      const dialog = state.dialog;
      const form = state.directoryForms.get(dialog.deviceId);
      if (form?.state !== 'retry') {
        if (dialog.browse.state !== 'ready') return;
        state.directoryForms.set(dialog.deviceId, { state: 'editing', path: dialog.browse.listing.path });
      }
      return void submitDirectory(dialog.deviceId);
    }
    case 'directory-close':
      if (state.dialog?.type === 'directory') return closeDialog();
      state.directoryForms.delete(dataset.machine);
      return bumpDialog();
    case 'revoke':
      state.dialog.confirm = dataset.machine;
      return bumpDialog();
    case 'import-models': return void importModels();
    case 'catalog-model': {
      const provider = state.settings.providers.find((entry) => entry.id === state.modelDraft?.provider);
      state.modelDraft.customModel = false;
      state.modelDraft.modelId = provider?.models[0]?.id ?? '';
      state.dialog.test = null;
      return bumpDialog();
    }
    case 'revoke-no':
      state.dialog.confirm = null;
      return bumpDialog();
    case 'revoke-yes': return void revokeMachine(dataset.machine);
    case 'passkey-remove':
      securityState().confirm = dataset.passkey;
      return bumpDialog();
    case 'passkey-remove-no':
      securityState().confirm = null;
      return bumpDialog();
    case 'passkey-remove-yes': return void removePasskey(dataset.passkey);
    case 'toggle-archived':
      state.showArchived = !state.showArchived;
      renderSidebar();
      return void refresh();
    case 'toggle-diff': return toggleWorkerDiff(dataset.worker);
    case 'refresh-diff': return void loadWorkerDiff(dataset.worker, true);
    case 'select-diff-file': return selectWorkerDiffFile(dataset.worker, dataset.path);
    case 'open-diff-dialog': return openDiffDialog(dataset.worker);
    case 'open-checkpoint':
      state.dialog = { type: 'checkpoint', rev: 0, pairing: null, confirm: null, passkeyAdd: null };
      drawn.delete('dialog');
      checkpointModal.open(dataset.worker, dataset.thread);
      return renderDialog();
    case 'archive-thread': return void archiveThread(dataset.thread, true, 'auto');
    case 'unarchive-thread': return void archiveThread(dataset.thread, false);
    case 'archive-confirm-keep': return void archiveThread(dataset.thread, true, 'keep');
    case 'archive-confirm-force': return void archiveThread(dataset.thread, true, 'force');
  }
});

// Draft values stay outside redraw signatures so refreshes preserve typing and focus.
const MODEL_CUSTOM = '__custom';
const ALL_THINKING_LEVELS = ['auto', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const DECLARABLE_THINKING_LEVELS = ALL_THINKING_LEVELS.filter((level) => level !== 'auto');

/** The owner's written-down level list for a gateway model: Pi reads this from its catalog,
 * a gateway has no catalog entry, so the JSON field takes its place. Returns null when empty,
 * undefined when unreadable (so the field can say so instead of quietly showing every level). */
function parseDeclaredLevels(text) {
  if (!text || !text.trim()) return null;
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  let listed;
  if (Array.isArray(raw)) listed = raw;
  else if (raw && typeof raw === 'object' && Array.isArray(raw.thinkingLevels)) listed = raw.thinkingLevels;
  else if (raw && typeof raw === 'object' && raw.thinkingLevelMap && typeof raw.thinkingLevelMap === 'object' && !Array.isArray(raw.thinkingLevelMap)) listed = Object.entries(raw.thinkingLevelMap).filter(([, value]) => value !== null).map(([name]) => name);
  else return undefined;
  if (!listed.length || listed.some((name) => !DECLARABLE_THINKING_LEVELS.includes(name))) return undefined;
  return DECLARABLE_THINKING_LEVELS.filter((name) => listed.includes(name));
}

function savedThinkingJson(provider, modelId) {
  return (state.settings?.savedModels ?? []).find((entry) => entry.provider === provider && entry.modelId === modelId)?.thinkingJson ?? '';
}

/** Measured (probe) levels for a saved gateway model; null when it was never successfully probed. */
function measuredThinkingLevels(provider, modelId) {
  return (state.settings?.thinkingProbes ?? []).find((entry) => entry.provider === provider && entry.modelId === modelId)?.acceptedLevels ?? null;
}

/** Compatible endpoints have no catalog entry, so the picker offers, in order: what a probe
 * measured, then the owner's own declaration, then every level (unverified) — never a dead stub. */
function compatibleThinkingLevels(provider, modelId) {
  const known = measuredThinkingLevels(provider, modelId)
    ?? (state.settings?.savedModels ?? []).find((entry) => entry.provider === provider && entry.modelId === modelId)?.thinkingLevels
    ?? null;
  return known?.length ? ['auto', ...known] : [...ALL_THINKING_LEVELS];
}

const MODEL_DRAFT_FIELDS = { 'model-provider-custom': 'provider', 'model-id-custom': 'modelId', 'model-base-url': 'baseUrl', 'model-headers': 'headersJson', 'model-levels-json': 'thinkingJson', 'model-key': 'apiKey' };
document.addEventListener('input', (event) => {
  if (event.target.id === 'directory-browse-path' && state.dialog?.type === 'directory') state.dialog.pathDraft = event.target.value;
  const directory = state.directoryForms.get(event.target.dataset?.directoryPath);
  if (directory && (directory.state === 'editing' || directory.state === 'failed')) directory.path = event.target.value;
  const field = MODEL_DRAFT_FIELDS[event.target.id];
  if (field && state.modelDraft) {
    state.dialog.test = null;
    state.dialog.saveError = false;
    $('#model-test-result')?.replaceChildren();
    const isSelect = event.target.tagName === 'SELECT';
    state.modelDraft[field] = isSelect && event.target.value === MODEL_CUSTOM ? '' : event.target.value;
    if (field === 'baseUrl' || field === 'apiKey' || field === 'headersJson') state.dialog.importedModels = null;
    if (field === 'modelId' || field === 'provider' || field === 'baseUrl' || field === 'apiKey' || field === 'headersJson') state.dialog.acceptedThinkingLevels = null;
    if (field === 'thinkingJson') {
      bumpDialog();
      return;
    }
    if (field === 'baseUrl') $('#provider-endpoint')?.replaceChildren(document.createTextNode(state.modelDraft.baseUrl.trim() || state.settings.providers.find((entry) => entry.id === state.modelDraft.provider)?.models.find((entry) => entry.id === state.modelDraft.modelId)?.baseUrl || t('providerEndpointUnknown')));
    if (isSelect) {
      bumpDialog();
      if (event.target.value === MODEL_CUSTOM) $('#model-id-custom')?.focus();
    }
  }
  if (event.target.id === 'passkey-label') state.passkeyLabelDraft = event.target.value;
});
document.addEventListener('change', (event) => {
  if (event.target.id === 'model-auto-test' && state.dialog) {
    state.dialog.autoTest = event.target.checked;
    return bumpDialog();
  }
  if (event.target.id !== 'model-api' || !state.modelDraft) return;
  state.modelDraft.provider = event.target.value;
  state.modelDraft.thinkingLevel = event.target.value === 'openai-compatible' ? 'auto' : 'off';
  state.dialog.importedModels = null;
  state.dialog.acceptedThinkingLevels = null;
  state.dialog.test = null;
  bumpDialog();
});
document.addEventListener('submit', (event) => {
  if (event.target.dataset.agentModel) {
    event.preventDefault();
    return void saveAgentModel(event.target);
  }
  if (event.target.id === 'directory-browse-form') {
    event.preventDefault();
    return void browseDirectory(state.dialog.pathDraft.trim());
  }
  if (event.target.dataset.directoryMachine) {
    event.preventDefault();
    return void submitDirectory(event.target.dataset.directoryMachine, event.target);
  }
  if (event.target.id === 'model-form') {
    event.preventDefault();
    return void saveModel();
  }
  if (event.target.id === 'passkey-form') {
    event.preventDefault();
    return void addPasskey();
  }
});

// ---- start ----------------------------------------------------------------------------------------------------

applyStatic();
paintIcons();
try {
  $('#workspace').classList.toggle('sidebar-hidden', localStorage.getItem('otto.sidebar.hidden') === 'true');
  $('#workspace').classList.toggle('context-hidden', localStorage.getItem('otto.context.hidden') === 'true');
} catch { /* Storage may be unavailable. */ }
{
  const route = routeFromLocation();
  state.selected = route.thread;
  state.session = route.worker;
}
resizeInput();
renderConnection();
void refresh();
setInterval(() => { if (state.snapshot && document.visibilityState === 'visible') void refresh(); }, 60_000);
setInterval(() => { if (state.snapshot && document.visibilityState === 'visible') { renderSidebar(); renderContext(); renderFeed(false); } }, 30_000);

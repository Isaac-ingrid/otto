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
import { applyThreadState, lastTimelineId, mergeTimeline } from './thread-frames.js';
import { mountSessionViewer } from './session.js';
import {
  ACTION_KEYS, FATAL_COPY, KNOWN_TITLES, attentionFor, canAnswerCard, formatContextWindow, groupByDay, groupThreads, isActiveWorker, isModelEnabled, messagesFor, modelAfterProviderChange, thinkingAfterModelChange, availableChatModels, initialSetupStep, previewOf, summarize, threadPlatformFilters, withPending, workOn,
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
  sidebarGroupBy: 'status',
  sidebarAgentFilter: 'all',
  sidebarMachineFilter: 'all',
  composerAgent: '',
  composerMachine: '',
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
  pendingModelSwitch: null, // queued { provider, modelId, thinkingLevel } while a reply is in flight
  togglingModel: null, // `${provider}:${modelId}` while toggling enabled state
  togglingProfile: null, // profileId while toggling enabled state
  deletingProfile: null, // profileId while deleting
  stopping: false, // a stop request is in flight (ADR-0017): the button stays put and disabled
  onboarding: null, // { step: 'model' | 'security', passkeyAdd, confirm }

};

// ---- small pieces ---------------------------------------------------------------------------------

const threadById = (id) => state.snapshot?.threads.find((thread) => thread.id === id) ?? null;
const serverNow = () => Date.now() + state.skew;
const dayLabel = (ts) => formatDay(ts, serverNow(), localeTag(), { today: t('today'), yesterday: t('yesterday') });
const ago = (ts) => formatRelative(ts, serverNow(), localeTag(), t('justNow'));
const stateLabel = (value) => t({ waiting_you: 'needsYou', running: 'running', idle: 'idle' }[value] ?? 'idle');
const stateColor = (value) => ({ waiting_you: 'amber', running: 'green', idle: 'gray' }[value] ?? 'gray');
const stateClass = (value) => ({ waiting_you: 'waiting', running: 'running', idle: 'idle' }[value] ?? 'idle');
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

function renderSidebarFilters(snapshot) {
  const container = $('#sidebar-filters');
  if (!container) return;
  const { agents, machines } = threadPlatformFilters(snapshot);
  if (state.sidebarAgentFilter !== 'all' && !agents.includes(state.sidebarAgentFilter)) state.sidebarAgentFilter = 'all';
  if (state.sidebarMachineFilter !== 'all' && !machines.some((m) => m.name === state.sidebarMachineFilter) && !snapshot.threads.some((tEntry) => tEntry.machine === state.sidebarMachineFilter)) state.sidebarMachineFilter = 'all';
  const machineNames = [...new Set([...machines.map((m) => m.name), ...snapshot.threads.map((tEntry) => tEntry.machine).filter(Boolean)])].sort();
  redraw('sidebar-filters', [getLocale(), state.sidebarGroupBy, state.sidebarAgentFilter, state.sidebarMachineFilter, agents, machineNames], () => preservingFocus(container, () => {
    const tabs = [
      { id: 'status', label: t('groupByStatus') },
      { id: 'agent', label: t('groupByPlatform') },
      { id: 'machine', label: t('groupByMachine') },
    ];
    container.replaceChildren(
      h('div', { class: 'sidebar-group-tabs', role: 'group', 'aria-label': t('threadNavigation') },
        tabs.map((tab) => h('button', {
          type: 'button',
          class: 'sidebar-group-tab',
          dataset: { groupBy: tab.id, focus: `group:${tab.id}` },
          'aria-pressed': String(state.sidebarGroupBy === tab.id),
        }, tab.label))),
      (agents.length > 0 || machineNames.length > 0) ? h('div', { class: 'sidebar-filter-selects' },
        h('select', { id: 'sidebar-agent-filter', class: 'sidebar-filter-select', 'aria-label': t('filterPlatformLabel'), dataset: { focus: 'filter:agent' } },
          h('option', { value: 'all', selected: state.sidebarAgentFilter === 'all' ? true : null }, t('filterAllPlatforms')),
          agents.map((agent) => h('option', { value: agent, selected: state.sidebarAgentFilter === agent ? true : null }, agentName(agent)))),
        h('select', { id: 'sidebar-machine-filter', class: 'sidebar-filter-select', 'aria-label': t('filterMachineLabel'), dataset: { focus: 'filter:machine' } },
          h('option', { value: 'all', selected: state.sidebarMachineFilter === 'all' ? true : null }, t('filterAllMachines')),
          machineNames.map((name) => h('option', { value: name, selected: state.sidebarMachineFilter === name ? true : null }, name)))) : null,
    );
  }));
}

function groupHeading(group) {
  if (state.sidebarGroupBy === 'agent') {
    return [icon('layers'), group.agent === 'unassigned' ? t('unassignedGroup') : agentName(group.agent)];
  }
  if (state.sidebarGroupBy === 'machine') {
    return [icon('laptop'), group.machine === 'unassigned' ? t('unassignedGroup') : group.machine];
  }
  return [h('span', { class: `status-dot ${stateColor(group.state)}` }), stateLabel(group.state)];
}

function renderSidebar() {
  const snapshot = state.snapshot;
  renderSidebarFilters(snapshot);
  const list = $('#thread-list');
  const rows = snapshot.threads.map((thread) => [thread.id, thread.title, thread.state, thread.unread, thread.lastActivityAt, thread.machine, thread.workers.map((worker) => worker.agent), previewOf(thread, snapshot.messages)]);
  redraw('threads', [getLocale(), state.filter, state.sidebarGroupBy, state.sidebarAgentFilter, state.sidebarMachineFilter, state.selected, rows, minuteBucket()], () => preservingFocus(list, () => {
    const groups = groupThreads(snapshot.threads, state.filter, {
      groupBy: state.sidebarGroupBy,
      agent: state.sidebarAgentFilter,
      machine: state.sidebarMachineFilter,
    });
    if (groups.length === 0) {
      const searching = state.filter.trim() !== '';
      const filtering = state.sidebarAgentFilter !== 'all' || state.sidebarMachineFilter !== 'all';
      list.replaceChildren(h('div', { class: 'empty-state' }, icon(searching || filtering ? 'search' : 'layers'),
        h('strong', null, t(searching || filtering ? 'noResults' : 'noThreads')), h('p', null, t(searching || filtering ? 'searchHint' : 'noThreadsHelp')),
        filtering ? h('button', { type: 'button', class: 'button', dataset: { action: 'clear-filters' } }, t('clearFilters'))
          : searching ? h('button', { type: 'button', class: 'button', dataset: { action: 'clear-search' } }, t('clearSearch')) : null));
      return;
    }
    list.replaceChildren(...groups.map((group) => h('section', { class: 'thread-group' },
      h('h2', { class: 'group-label' }, ...groupHeading(group), h('span', { class: 'group-count' }, t(group.threads.length === 1 ? 'threadCountOne' : 'threadCount', { count: group.threads.length }))),
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
      }))));
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
  const titles = snapshot.threads.map((entry) => [entry.id, entry.title, entry.state]);
  const live = state.live && (!state.selected || state.live.threadId === state.selected) ? state.live : null;
  redraw('feed', [getLocale(), state.selected, snapshot.messages, snapshot.busy, state.stopping, [...state.pending.values()], [...state.busyCards], titles, dayKey(serverNow()), live?.text], () => {
    const nearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 40;
    const oldTop = feed.scrollTop;

    $('#conversation-title').textContent = thread ? thread.title : t('allMessages');
    $('#conversation-subtitle').textContent = thread
      ? [thread.repos.join(', '), [...new Set(thread.workers.map((worker) => worker.agent))].join(', '), thread.machine].filter(Boolean).join(' · ')
      : '';
    $('#conversation-subtitle').hidden = !$('#conversation-subtitle').textContent;
    document.querySelector('.heading-line .state-badge')?.remove();
    if (thread) $('.heading-line').append(stateBadge(thread.state));
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

const agentName = (agent) => ({ pi: 'pi', 'claude-code': 'Claude Code' }[agent] ?? agent);

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

function renderComposerDispatch() {
  const container = $('#composer-dispatch-controls');
  if (!container || !state.snapshot) return;
  const { agents, machines } = threadPlatformFilters(state.snapshot);
  if (state.composerAgent && !agents.includes(state.composerAgent)) state.composerAgent = '';
  if (state.composerMachine && !machines.some((m) => m.name === state.composerMachine)) state.composerMachine = '';
  redraw('composer-dispatch', [getLocale(), state.composerAgent, state.composerMachine, agents, machines.map((m) => [m.name, m.online])], () => preservingFocus(container, () => {
    if (agents.length === 0 && machines.length === 0) {
      container.replaceChildren();
      return;
    }
    container.replaceChildren(
      agents.length > 0 ? h('select', { id: 'composer-agent-select', class: 'composer-select', 'aria-label': t('dispatchAgentLabel'), dataset: { focus: 'dispatch:agent' } },
        h('option', { value: '', selected: state.composerAgent === '' ? true : null }, t('dispatchAgentAuto')),
        agents.map((agent) => h('option', { value: agent, selected: state.composerAgent === agent ? true : null }, agentName(agent)))) : null,
      machines.length > 0 ? h('select', { id: 'composer-machine-select', class: 'composer-select', 'aria-label': t('dispatchMachineLabel'), dataset: { focus: 'dispatch:machine' } },
        h('option', { value: '', selected: state.composerMachine === '' ? true : null }, t('dispatchMachineAuto')),
        machines.map((machine) => h('option', { value: machine.name, selected: state.composerMachine === machine.name ? true : null },
          machine.online ? machine.name : `${machine.name} (${t('offline')})`))) : null,
    );
  }));
}

function renderComposer() {
  renderComposerDispatch();
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

const profileFor = (id) => (state.settings?.profiles ?? []).find((entry) => entry.profileId === id) ?? null;
const dialectFor = (id) => profileFor(id)?.dialect || (state.settings?.model?.provider === id ? state.settings?.model?.dialect : null) || id;
const profileEnabled = (id) => { const p = profileFor(id); return p ? p.enabled !== false : true; };
const profileGroupName = (id) => {
  const p = profileFor(id);
  if (p?.name) return p.name;
  const catalog = (state.settings?.providers ?? []).find((entry) => entry.id === dialectFor(id));
  return catalog ? providerChoiceName(catalog) : id;
};

function renderComposerModels() {
  const node = $('#composer-model-controls');
  const globalModel = state.settings?.model;
  const thread = state.selected ? threadById(state.selected) : null;
  const override = thread?.modelOverride ?? null;
  const model = globalModel && override
    ? { ...globalModel, provider: override.provider, modelId: override.modelId, thinkingLevel: override.thinkingLevel ?? 'off' }
    : globalModel;
  const busy = state.changingModel;
  redraw('composer-model', [getLocale(), state.settings, state.selected, override, busy, state.pendingModelSwitch], () => {
    if (!model?.apiKey) { node.replaceChildren(); return; }
    const verified = (provider, modelId) => (state.settings.verifiedModels ?? []).some((entry) => entry.provider === provider && entry.modelId === modelId);
    const savedModels = state.settings.savedModels ?? [];
    const entries = availableChatModels(state.settings).filter((provider) => profileEnabled(provider.id)).flatMap((provider) => provider.models.filter((entry) => verified(provider.id, entry.id) && isModelEnabled(savedModels, provider.id, entry.id)).map((entry) => ({
      ...entry, id: JSON.stringify([provider.id, entry.id]), modelId: entry.id, provider: provider.id, group: profileGroupName(provider.id),
    })));
    for (const profile of (state.settings.profiles ?? [])) {
      if (profile.enabled === false || profile.profileId === profile.dialect) continue;
      const catalog = (state.settings.providers ?? []).find((entry) => entry.id === profile.dialect);
      if (!catalog) continue;
      for (const entry of catalog.models) {
        if (!verified(profile.profileId, entry.id) || !isModelEnabled(savedModels, profile.profileId, entry.id)) continue;
        if (entries.some((item) => item.provider === profile.profileId && item.modelId === entry.id)) continue;
        entries.push({ ...entry, id: JSON.stringify([profile.profileId, entry.id]), modelId: entry.id, provider: profile.profileId, group: profile.name || profile.profileId });
      }
    }
    for (const saved of savedModels) {
      if (saved.enabled === false || !profileEnabled(saved.provider) || !verified(saved.provider, saved.modelId) || entries.some((entry) => entry.provider === saved.provider && entry.modelId === saved.modelId)) continue;
      const dialect = dialectFor(saved.provider);
      entries.push({ id: JSON.stringify([saved.provider, saved.modelId]), modelId: saved.modelId, provider: saved.provider, name: saved.modelId, group: profileGroupName(saved.provider), thinkingLevels: dialect === 'openai-compatible' ? compatibleThinkingLevels(saved.provider, saved.modelId) : saved.provider === model.provider && saved.modelId === model.modelId ? model.thinkingLevels : ['off'] });
    }
    if (!entries.some((entry) => entry.provider === model.provider && entry.modelId === model.modelId)) {
      const catalogModel = (state.settings.providers ?? []).find((p) => p.id === dialectFor(model.provider))?.models?.find((m) => m.id === model.modelId);
      entries.unshift({ ...(catalogModel ?? {}), id: JSON.stringify([model.provider, model.modelId]), modelId: model.modelId, provider: model.provider, name: catalogModel?.name ?? model.modelId, group: profileGroupName(model.provider), thinkingLevels: model.thinkingLevels });
    }
    const selected = entries.find((entry) => entry.provider === model.provider && entry.modelId === model.modelId);
    const activeDialect = dialectFor(model.provider);
    const levels = activeDialect === 'openai-compatible' ? compatibleThinkingLevels(model.provider, model.modelId) : selected?.thinkingLevels ?? model.thinkingLevels;
    const ready = Boolean(levels?.includes(model.thinkingLevel));
    const activeProfileLabel = profileGroupName(model.provider);
    node.replaceChildren(...[
      modelPicker(entries, selected?.id ?? model.modelId, (id) => {
        const entry = entries.find((item) => item.id === id);
        if (entry) void changeComposerModel({ provider: entry.provider, modelId: entry.modelId, thinkingLevel: thinkingAfterModelChange(entry, model.thinkingLevel) });
      }, { name: 'chat-model', compact: true, disabled: busy || !ready, label: `${t('composerModel')}: ${activeProfileLabel} · ${selected?.name ?? model.modelId}`, minWidth: 320 }),
      ready ? modelPicker(levels.map((level) => ({ id: level, name: t(`thinking_${level}`) })), model.thinkingLevel, (level) => {
        void changeComposerModel({ provider: model.provider, modelId: model.modelId, thinkingLevel: level });
      }, { name: 'chat-thinking', compact: true, searchable: false, leadingIcon: 'memory', disabled: busy || levels.length < 2, label: `${t('thinkingTitle')}: ${t(`thinking_${model.thinkingLevel}`)}`, minWidth: 180 })
        : h('button', { type: 'button', class: 'model-picker-trigger model-choice-chip', disabled: busy, dataset: { action: 'retry-settings' } }, t('modelOptionsReload')),
      override ? h('button', { type: 'button', class: 'button quiet', disabled: busy, dataset: { action: 'clear-thread-model', focus: 'clear-thread-model' }, title: t('modelThreadOverride') }, t('modelFollowGlobal')) : null,
      state.changingModel ? h('span', { class: 'model-saving', role: 'status' }, t('modelSaving'))
        : state.pendingModelSwitch ? h('span', { class: 'model-saving', role: 'status' }, t('modelSwitchPending')) : null].filter(Boolean));
  });
}

async function changeComposerModel(input) {
  if (state.changingModel) return;
  const threadId = state.selected;
  if (!threadId && working()) {
    state.pendingModelSwitch = input;
    toast(t('modelSwitchQueued'));
    renderComposer();
    return;
  }
  state.changingModel = true;
  renderComposer();
  $('#send-button').disabled = true;
  try {
    if (threadId) {
      const { status, data } = await request(`/app/api/threads/${threadId}/model`, input);
      if (status === 200) {
        patchThread(threadId, (entry) => ({ ...entry, modelOverride: data?.modelOverride ?? null }));
      } else if (status !== 401) {
        const code = typeof data?.error === 'string' && data.error ? ` (${data.error})` : '';
        toast(`${t('modelChangeFailed')}${code}`);
      }
      return;
    }
    const { status, data } = await request('/app/api/settings/model/selection', input);
    if (status === 200 && data?.model) {
      const adjusted = state.settings.model.thinkingLevel !== data.model.thinkingLevel && state.settings.model.modelId !== data.model.modelId;
      state.settings = { ...state.settings, model: data.model };
      if (adjusted) toast(t('thinkingAdjusted', { level: t(`thinking_${data.model.thinkingLevel}`) }));
    } else if (status === 409) {
      state.pendingModelSwitch = input;
      toast(t('modelSwitchQueued'));
    } else if (status !== 401) {
      const code = typeof data?.error === 'string' && data.error ? ` (${data.error})` : '';
      toast(`${t('modelChangeFailed')}${code}`);
    }
  } catch { toast(t('modelChangeFailed')); }
  finally {
    state.changingModel = false;
    renderComposer();
    $('#send-button').disabled = state.changingModel || !$('#message-input').value.trim();
  }
}

async function clearThreadModel() {
  const threadId = state.selected;
  if (!threadId || state.changingModel) return;
  state.changingModel = true;
  renderComposer();
  try {
    const { status, data } = await request(`/app/api/threads/${threadId}/model`, { clear: true });
    if (status === 200) {
      patchThread(threadId, (entry) => ({ ...entry, modelOverride: null }));
      toast(t('modelThreadOverrideCleared'));
    } else if (status !== 401) {
      const code = typeof data?.error === 'string' && data.error ? ` (${data.error})` : '';
      toast(`${t('modelChangeFailed')}${code}`);
    }
  } catch { toast(t('modelChangeFailed')); }
  finally {
    state.changingModel = false;
    renderComposer();
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

function workerNode(thread, worker) {
  const active = isActiveWorker(worker);
  const progress = worker.progress ? [worker.progress.phase, worker.progress.tool, worker.progress.target].filter(Boolean).join(' ') : '';
  const facts = [];
  if (worker.git) {
    const parts = [];
    if (worker.git.ahead > 0) parts.push(t('gitAhead', { count: worker.git.ahead }));
    parts.push(t(worker.git.pushed ? 'gitPushed' : 'gitLocal'));
    if (worker.git.dirty > 0) parts.push(t('gitDirty', { count: worker.git.dirty }));
    facts.push(parts.join(' · '));
  }
  if (worker.contextPercent !== null && worker.contextPercent !== undefined) facts.push(t('context', { percent: worker.contextPercent }));
  const outcome = worker.outcome ? tOr(`outcome_${worker.outcome}`, worker.outcome) : '';
  const pr = worker.pr;
  return h('div', { class: 'worker-card' },
    h('div', { class: 'worker-title' },
      h('span', null, h('span', { class: 'agent-icon' }, worker.agent === 'pi' ? 'π' : worker.agent.startsWith('claude') ? '✳' : worker.agent.slice(0, 1).toUpperCase()), agentName(worker.agent)),
      h('span', { class: 'worker-state' }, h('span', { class: `status-dot ${active ? 'green' : 'gray'}` }), tOr(`worker${cap(worker.state)}`, worker.state))),
    h('div', { class: 'worker-meta' }, [worker.machine, worker.unreachable ? t('unreachable') : null].filter(Boolean).join(' · ')),
    worker.branch ? h('code', null, worker.branch) : null,
    progress ? h('div', { class: 'worker-facts' }, t('progress', { what: progress })) : null,
    outcome ? h('div', { class: 'worker-facts' }, outcome) : null,
    facts.length ? h('div', { class: 'worker-facts' }, facts.join(' · ')) : null,
    pr?.url ? h('p', { class: 'worker-pr' }, `${t('prCreated')}: `, h('a', { href: pr.url, target: '_blank', rel: 'noopener noreferrer' }, pr.url))
      : pr?.failure ? h('p', { class: 'worker-pr failed' }, `${t('prFailed')}: ${pr.failure}`)
        : pr?.decision === 'approved' ? h('p', { class: 'worker-pr' }, t('prPending'))
          : pr?.decision === 'declined' ? h('p', { class: 'worker-pr' }, t('prDeclined')) : null,
    worker.sessionId !== null || active
      ? h('div', { class: 'worker-actions' }, h('a', { href: urlFor(thread.id, worker.id), dataset: { nav: thread.id, worker: worker.id, focus: `session:${worker.id}` } }, t('rawHistory'), icon('chevron-right'))) : null);
}

function renderContext() {
  const snapshot = state.snapshot;
  const panel = $('#context-panel');
  const thread = state.selected ? threadById(state.selected) : null;
  const signature = [getLocale(), state.selected, thread ?? snapshot.threads.map((entry) => [entry.id, entry.title, entry.state, entry.machine, entry.workers.map((worker) => [worker.agent, worker.state])]),
    snapshot.attention, snapshot.activity, snapshot.messages.map((message) => message.id), [...state.busyCards], minuteBucket()];
  redraw('context', signature, () => {
    const top = panel.scrollTop;
    const close = h('button', { type: 'button', class: 'icon-button close-context', dataset: { action: 'close-details', focus: 'close-details' }, 'aria-label': t('closeDetails') }, icon('close'));
    const sections = [];
    if (!thread) {
      const running = snapshot.threads.filter((entry) => entry.state === 'running');
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
      sections.push(
        h('header', { class: 'context-header' }, h('h2', null, t('threadDetails')), close),
        h('section', { class: 'context-section' },
          h('h2', { class: 'thread-detail-title' }, thread.title), stateBadge(thread.state),
          thread.goal && thread.goal !== thread.summary ? h('p', { class: 'detail-goal' }, `${t('goal')}: ${thread.goal}`) : null,
          thread.repos.length ? h('div', { class: 'repo-label' }, icon('folder'), thread.repos.join(', ')) : null),
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

function savedModelBadges(providerId, modelId) {
  const dialect = dialectFor(providerId);
  const entry = (state.settings?.providers ?? []).find((p) => p.id === dialect)?.models?.find((m) => m.id === modelId);
  if (!entry) return null;
  const badges = [];
  if (entry.vision) badges.push(h('span', { class: 'model-badge' }, t('badgeVision')));
  if (entry.reasoning) badges.push(h('span', { class: 'model-badge' }, t('badgeReasoning')));
  const ctx = formatContextWindow(entry.contextWindow);
  if (ctx) badges.push(h('span', { class: 'model-badge' }, ctx));
  return badges.length ? h('span', { class: 'model-badges' }, badges) : null;
}

function savedModelsList() {
  const saved = state.settings?.savedModels ?? [];
  if (!saved.length) return null;
  return h('div', { class: 'saved-models' },
    h('h4', null, t('savedModelsTitle')),
    saved.map((entry) => {
      const enabled = entry.enabled !== false;
      const key = `${entry.provider}:${entry.modelId}`;
      return h('div', { class: 'saved-model-row' },
        h('div', { class: 'saved-model-meta' },
          h('strong', null, entry.modelId),
          h('small', null, profileFor(entry.provider)?.name ?? entry.provider),
          savedModelBadges(entry.provider, entry.modelId)),
        h('button', {
          type: 'button',
          class: `button quiet${enabled ? '' : ' muted'}`,
          disabled: state.togglingModel === key,
          'aria-pressed': String(enabled),
          dataset: { action: 'toggle-saved-model', provider: entry.provider, modelId: entry.modelId, enabled: String(!enabled) },
        }, t(enabled ? 'modelEnabled' : 'modelDisabled')));
    }));
}

function profilesList() {
  const profiles = state.settings?.profiles ?? [];
  const activeId = state.settings?.model?.provider;
  return h('div', { class: 'saved-models' },
    h('div', { class: 'profiles-header' },
      h('h4', null, t('profilesTitle')),
      h('button', { type: 'button', class: 'button quiet', dataset: { action: 'new-profile', focus: 'new-profile' } }, icon('plus'), t('profileAdd'))),
    profiles.map((profile) => {
      const enabled = profile.enabled !== false;
      const isActive = profile.profileId === activeId;
      return h('div', { class: 'saved-model-row' },
        h('div', { class: 'saved-model-meta' },
          h('strong', null, profile.name || profile.profileId),
          h('small', null, [profile.dialect, profile.baseUrl].filter(Boolean).join(' · '))),
        h('div', { class: 'profile-actions' },
          h('button', { type: 'button', class: 'button quiet', dataset: { action: 'edit-profile', profileId: profile.profileId, focus: `edit-profile:${profile.profileId}` } }, t('profileEdit')),
          h('button', {
            type: 'button',
            class: `button quiet${enabled ? '' : ' muted'}`,
            disabled: state.togglingProfile === profile.profileId,
            'aria-pressed': String(enabled),
            dataset: { action: 'toggle-profile', profileId: profile.profileId, enabled: String(!enabled) },
          }, t(enabled ? 'modelEnabled' : 'modelDisabled')),
          h('button', {
            type: 'button',
            class: 'button quiet muted',
            disabled: isActive || state.deletingProfile === profile.profileId,
            title: isActive ? t('profileDeleteActive') : null,
            dataset: { action: 'delete-profile', profileId: profile.profileId },
          }, t('profileDelete'))));
    }));
}

async function toggleProfile(profileId, enabled) {
  if (state.togglingProfile === profileId) return;
  state.togglingProfile = profileId;
  bumpDialog();
  try {
    const { status } = await request('/app/api/settings/model/profile/toggle', { profileId, enabled });
    if (status === 200) await loadSettings();
    else if (status !== 401) toast(t('profileToggleFailed'));
  } catch { toast(t('profileToggleFailed')); }
  finally { state.togglingProfile = null; bumpDialog(); }
}

async function deleteProfile(profileId) {
  if (state.deletingProfile === profileId) return;
  state.deletingProfile = profileId;
  bumpDialog();
  try {
    const { status, data } = await request('/app/api/settings/model/profile/delete', { profileId });
    if (status === 200) await loadSettings();
    else if (status === 409 && data?.error === 'active_profile') toast(t('profileDeleteActive'));
    else if (status !== 401) toast(t('profileDeleteFailed'));
  } catch { toast(t('profileDeleteFailed')); }
  finally { state.deletingProfile = null; bumpDialog(); }
}

async function toggleSavedModel(provider, modelId, enabled) {
  const key = `${provider}:${modelId}`;
  if (state.togglingModel === key) return;
  state.togglingModel = key;
  bumpDialog();
  try {
    const { status } = await request('/app/api/settings/model/toggle', { provider, modelId, enabled });
    if (status === 200) await loadSettings();
    else if (status !== 401) toast(t('modelToggleFailed'));
  } catch { toast(t('modelToggleFailed')); }
  finally { state.togglingModel = null; bumpDialog(); }
}

function modelSection() {
  const model = state.settings.model;
  return h('section', { class: 'model-settings settings-section' },
    h('div', { class: 'section-heading' }, icon('sparkle'),
      h('div', null, h('h3', null, t('modelTitle')), h('p', { class: 'dialog-copy' }, t('providersHelp')))),
    model?.apiKey ? h('p', { class: 'active-model' }, h('span', { class: `status-dot${(state.settings.verifiedModels ?? []).some((entry) => entry.provider === model.provider && entry.modelId === model.modelId) ? ' green' : ''}` }), t((state.settings.verifiedModels ?? []).some((entry) => entry.provider === model.provider && entry.modelId === model.modelId) ? 'providerActive' : 'providerUnverified'), h('strong', null, model.modelId)) : null,
    providerGrid(),
    profilesList(),
    savedModelsList());
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

function accountSection() {
  if (!state.settings) return [h('p', { class: 'dialog-copy' }, t(state.settingsError ? 'settingsLoadFailed' : 'settingsLoading')),
    state.settingsError ? h('button', { class: 'button', dataset: { action: 'retry-settings' } }, t('settingsRetry')) : null];
  return [modelSection(), securitySection(), pushSection(),
    h('div', { class: 'settings-footer' }, h('p', { class: 'dialog-hint' }, t('accountBody')),
      h('button', { type: 'button', class: 'button quiet', dataset: { action: 'sign-out' } }, t('signOut')))];
}

function providerSection() {
  const draft = state.modelDraft;
  const dialect = draft.dialect || dialectFor(draft.provider);
  const provider = state.settings.providers.find((entry) => entry.id === dialect);
  const isCompat = dialect.endsWith('-compatible');
  const isOpenAICompat = dialect === 'openai-compatible';
  const models = state.dialog.importedModels ?? provider?.models ?? [];
  const known = models.some((entry) => entry.id === draft.modelId);
  const keyed = state.settings.keyedProviders.includes(draft.provider);
  const variants = !draft.isNewProfile && draft.provider === dialect && provider?.info ? state.settings.providers.filter((entry) => entry.info?.family === provider.info.family) : [];
  const selectedModel = models.find((entry) => entry.id === draft.modelId);
  const declared = parseDeclaredLevels(draft.thinkingJson ?? '');
  const measured = state.dialog.acceptedThinkingLevels ?? measuredThinkingLevels(draft.provider, draft.modelId);
  const described = declared?.length ? declared : measured ?? null;
  const thinkingLevels = isOpenAICompat ? (described ? ['auto', ...described] : [...ALL_THINKING_LEVELS]) : (selectedModel?.thinkingLevels ?? ['off']);
  const busy = state.dialog.saving || state.dialog.testing;
  const link = (url, label) => h('a', { class: 'provider-link', href: url, target: '_blank', rel: 'noopener noreferrer' }, label, icon('external'));
  return h('form', { id: 'model-form', class: 'model-form provider-form' },
    h('div', { class: 'provider-intro' },
      h('p', { class: 'dialog-copy' }, t('providerConnectHelp')),
      provider?.info ? link(provider.info.consoleUrl, t('providerConsole')) : null),
    draft.isNewProfile ? [
      h('label', { for: 'model-profile-dialect' }, t('profileProtocolLabel')),
      h('select', { id: 'model-profile-dialect' },
        state.settings.providers.map((entry) => h('option', { value: entry.id, selected: dialect === entry.id }, entry.name || entry.id))),
    ] : null,
    h('label', { for: 'model-profile-name' }, t('profileNameLabel')),
    h('input', { id: 'model-profile-name', maxlength: 128, autocomplete: 'off', placeholder: t('profileNamePlaceholder'), value: draft.profileName ?? '' }),
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
      h('input', { id: 'model-key', type: state.dialog.showKey ? 'text' : 'password', autocomplete: 'off', spellcheck: 'false', required: !keyed, placeholder: t(keyed ? 'modelKeyKeep' : 'modelKeyPlaceholder'), value: draft.apiKey, dataset: { focus: 'model-key' } }),
      h('button', { type: 'button', class: 'button quiet', dataset: { action: 'toggle-key' }, 'aria-pressed': String(Boolean(state.dialog.showKey)) }, t(state.dialog.showKey ? 'keyHide' : 'keyShow'))),
    h('p', { class: 'dialog-hint' }, t('modelHelp')),
    !isCompat ? h('div', { class: 'provider-endpoint' }, h('span', null, t('providerEndpoint')),
      h('code', { id: 'provider-endpoint' }, draft.baseUrl.trim() || selectedModel?.baseUrl || t('providerEndpointUnknown'))) : null,
    h('label', { for: provider && !draft.customModel && (known || !draft.baseUrl) ? 'model-picker-trigger' : 'model-id-custom' }, t('modelIdLabel')),
    provider && !draft.customModel && (known || !draft.baseUrl) ? modelPicker([...models, { id: MODEL_CUSTOM, name: t('modelCustomOption') }], draft.modelId, (id) => {
      state.modelDraft.customModel = id === MODEL_CUSTOM;
      state.modelDraft.modelId = id === MODEL_CUSTOM ? '' : id;
      state.modelDraft.thinkingLevel = isOpenAICompat ? 'auto' : thinkingAfterModelChange(models.find((entry) => entry.id === id), state.modelDraft.thinkingLevel);
      state.dialog.acceptedThinkingLevels = null;
      state.dialog.test = null;
      bumpDialog();
      $(id === MODEL_CUSTOM ? '#model-id-custom' : '#model-picker-trigger')?.focus();
    }) : [
      !provider ? [h('label', { for: 'model-provider-custom' }, t('modelProviderLabel')),
        h('input', { id: 'model-provider-custom', required: true, autocomplete: 'off', value: draft.provider })] : null,
      h('input', { id: 'model-id-custom', required: true, autocomplete: 'off', placeholder: t('modelIdLabel'), value: draft.modelId }),
      provider && !isCompat ? h('button', { type: 'button', class: 'button quiet', dataset: { action: 'catalog-model' } }, t('setupBack')) : null,
    ],
    h('label', { for: 'model-base-url' }, t('modelBaseUrlLabel')),
    h('input', { id: 'model-base-url', type: 'url', autocomplete: 'url', required: isCompat, placeholder: t('modelBaseUrlPlaceholder'), value: draft.baseUrl }),
    isCompat ? [h('label', { for: 'model-api' }, t('modelApiLabel')),
      h('select', { id: 'model-api' }, [
        h('option', { value: 'openai-compatible', selected: isOpenAICompat }, 'openai-completions'),
        h('option', { value: 'anthropic-compatible', selected: dialect === 'anthropic-compatible' }, 'anthropic-messages'),
      ])] : null,
    isCompat ? [h('label', { for: 'model-headers' }, t('modelHeadersLabel')),
      h('textarea', { id: 'model-headers', rows: 3, placeholder: '{"X-Custom-Header":"value"}' }, draft.headersJson ?? ''),
      h('p', { class: 'dialog-hint' }, t('modelHeadersHelp')),
      h('button', { type: 'button', class: 'button quiet', disabled: busy, dataset: { action: 'import-models' } }, state.dialog.importing ? t('modelImporting') : t('modelImport')),
      h('label', { for: 'model-levels-json' }, t('modelLevelsLabel')),
      h('textarea', { id: 'model-levels-json', rows: 3, spellcheck: 'false', placeholder: '{"thinkingLevels":["minimal","low","medium","high"]}' }, draft.thinkingJson ?? ''),
      declared === undefined ? h('p', { class: 'dialog-error' }, t('modelLevelsInvalid')) : h('p', { class: 'dialog-hint' }, t('modelLevelsHelp'))] : null,
    state.dialog.importError ? h('p', { class: 'dialog-error' }, t('modelImportFailed')) : null,
    provider && (selectedModel || isOpenAICompat) ? [h('label', { for: 'provider-thinking-picker-trigger' }, t('thinkingTitle')),
      modelPicker(thinkingLevels.map((level) => ({ id: level, name: t(`thinking_${level}`) })), thinkingLevels.includes(draft.thinkingLevel) ? draft.thinkingLevel : thinkingLevels[0], (level) => {
        state.modelDraft.thinkingLevel = level;
        state.dialog.test = null;
        bumpDialog();
        $('#provider-thinking-picker-trigger').focus();
      }, { name: 'provider-thinking', searchable: false, label: t('thinkingTitle'), disabled: busy || thinkingLevels.length < 2 }),
      isOpenAICompat && !described ? h('p', { class: 'dialog-hint' }, t('thinkingUnverified')) : null,
      h('p', { class: 'dialog-hint' }, t('thinkingHelp')),
    ] : null,
    provider && !known && !draft.baseUrl && !draft.customModel ? h('p', { class: 'dialog-hint' }, t('modelChooseKnown')) : null,
    h('div', { class: 'connection-test' },
      h('button', { type: 'button', class: 'button', disabled: busy, dataset: { action: 'test-model' } }, t(state.dialog.testing ? 'modelTesting' : 'modelTest')),
      h('p', { class: 'dialog-hint' }, t(isOpenAICompat ? 'modelTestProbeHelp' : 'modelTestHelp', { model: draft.modelId }))),
    isOpenAICompat ? h('label', { class: 'dialog-check' }, [
      h('input', { id: 'model-auto-test', type: 'checkbox', checked: state.dialog.autoTest !== false }),
      h('span', null, t('modelAutoTestLabel'))]) : null,
    h('p', { id: 'model-test-result', class: `connection-result${state.dialog.test?.ok ? ' success' : ' dialog-error'}`, role: 'status', 'aria-live': 'polite' },
      state.dialog.test ? t(state.dialog.test.ok ? 'modelTestSuccess' : `modelTest_${state.dialog.test.error}`) : ''),
    state.dialog.saveError ? h('p', { class: 'dialog-error', role: 'alert' }, t('modelSaveFailed')) : null,
    h('div', { class: 'provider-footer' },
      h('button', { type: 'button', class: 'button quiet', dataset: { action: 'close-dialog' } }, t('actionCancel')),
      h('button', { type: 'submit', class: 'button primary', disabled: busy }, t(state.dialog.saving ? 'modelSaving' : 'modelSave'))));
}

function selectProviderVariant(provider) {
  const current = state.settings.model;
  state.modelDraft = current?.provider === provider
    ? { provider, dialect: provider, profileName: profileFor(provider)?.name ?? '', modelId: current.modelId, baseUrl: current.baseUrl ?? '', apiKey: '', thinkingJson: savedThinkingJson(provider, current.modelId) }
    : { provider, dialect: provider, profileName: profileFor(provider)?.name ?? '', modelId: modelAfterProviderChange(state.settings.providers, provider, state.modelDraft.modelId) ?? '', baseUrl: profileFor(provider)?.baseUrl ?? '', apiKey: '', thinkingJson: '' };
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
    const dialect = draft.dialect || dialectFor(draft.provider);
    const { status, data } = await request('/app/api/settings/model/import', {
      provider: draft.provider, ...(dialect ? { dialect } : {}), modelId: draft.modelId || 'import', baseUrl: draft.baseUrl.trim(),
      ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
      ...(headers ? { headers } : {}),
    });
    if (state.dialog !== dialog) return;
    if (status !== 200 || !Array.isArray(data?.models) || !data.models.length) throw new Error('import failed');
    dialog.importedModels = data.models;
    draft.modelId = data.models[0].id;
    draft.customModel = false;
    draft.thinkingLevel = dialect === 'openai-compatible' ? 'auto' : 'off';
    dialog.test = null;
  } catch { if (state.dialog === dialog) dialog.importError = true; }
  finally { dialog.importing = false; if (state.dialog === dialog) bumpDialog(); }
}

async function testModel() {
  const dialog = state.dialog;
  if (!state.modelDraft || dialog.testing || dialog.saving || !$('#model-form').reportValidity()) return;
  const headers = draftHeaders();
  if (headers === null) return;
  const draft = Object.fromEntries(Object.entries(state.modelDraft).filter(([key, value]) => key !== 'customModel' && key !== 'headersJson' && key !== 'isNewProfile' && typeof value === 'string').map(([key, value]) => [key, value.trim()]));
  if (!draft.profileName) delete draft.profileName;
  if (!draft.dialect) delete draft.dialect;
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
        if ((draft.dialect || draft.provider) === 'openai-compatible' && !['auto', ...(data.acceptedThinkingLevels ?? [])].includes(draft.thinkingLevel)) draft.thinkingLevel = 'auto';
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
  const dialect = id === MODEL_CUSTOM ? '' : dialectFor(id);
  const existing = profileFor(provider);
  state.modelDraft = current?.provider === provider
    ? { provider, dialect, profileName: existing?.name ?? '', modelId: current.modelId, baseUrl: current.baseUrl ?? '', apiKey: '', thinkingJson: savedThinkingJson(provider, current.modelId) }
    : { provider, dialect, profileName: existing?.name ?? '', modelId: modelAfterProviderChange(state.settings.providers, dialect, '') ?? '', baseUrl: existing?.baseUrl ?? '', apiKey: '', thinkingJson: '' };
  state.dialog = { type: 'provider', rev: 0, returnTo: state.onboarding ? null : 'account', returnFocus: `provider:${id === MODEL_CUSTOM ? 'custom' : state.settings.providers.find((entry) => entry.id === dialect)?.info?.family ?? id}` };
  const selected = state.settings.providers.find((entry) => entry.id === dialect)?.models.find((entry) => entry.id === state.modelDraft.modelId);
  state.modelDraft.customModel = dialect.endsWith('-compatible') || Boolean(current?.provider === provider && !selected);
  state.modelDraft.thinkingLevel = dialect === 'openai-compatible' ? (current?.provider === provider ? current.thinkingLevel : 'auto') : dialect.endsWith('-compatible') ? 'off' : thinkingAfterModelChange(selected, current?.thinkingLevel);
  renderDialog();
  $('#model-key').focus();
}

function openNewProfile() {
  const id = `prof_${uuid().slice(0, 8)}`;
  const dialect = 'openai-compatible';
  state.modelDraft = { provider: id, dialect, profileName: '', modelId: '', baseUrl: '', apiKey: '', thinkingJson: '', customModel: true, thinkingLevel: 'auto', isNewProfile: true };
  state.dialog = { type: 'provider', rev: 0, returnTo: state.onboarding ? null : 'account', returnFocus: 'new-profile' };
  renderDialog();
  $('#model-profile-name').focus();
}

function editProfile(profileId) {
  const profile = profileFor(profileId);
  if (!profile) return openProvider(profileId);
  const current = state.settings.model;
  const dialect = profile.dialect || profileId;
  const savedForProfile = (state.settings?.savedModels ?? []).find((entry) => entry.provider === profileId);
  const modelId = current?.provider === profileId ? current.modelId : (savedForProfile?.modelId ?? modelAfterProviderChange(state.settings.providers, dialect, '') ?? '');
  state.modelDraft = {
    provider: profileId,
    dialect,
    profileName: profile.name ?? '',
    modelId,
    baseUrl: (current?.provider === profileId ? current.baseUrl : null) ?? profile.baseUrl ?? '',
    apiKey: '',
    thinkingJson: savedThinkingJson(profileId, modelId),
  };
  state.dialog = { type: 'provider', rev: 0, returnTo: state.onboarding ? null : 'account', returnFocus: `edit-profile:${profileId}` };
  const selected = state.settings.providers.find((entry) => entry.id === dialect)?.models.find((entry) => entry.id === modelId);
  state.modelDraft.customModel = dialect.endsWith('-compatible') || Boolean(modelId && !selected);
  state.modelDraft.thinkingLevel = dialect === 'openai-compatible' ? (current?.provider === profileId ? current.thinkingLevel : 'auto') : dialect.endsWith('-compatible') ? 'off' : thinkingAfterModelChange(selected, current?.thinkingLevel);
  renderDialog();
  $('#model-profile-name').focus();
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
    const dialect = state.modelDraft.dialect || dialectFor(state.modelDraft.provider);
    const provider = state.settings.providers.find((entry) => entry.id === dialect);
    return { title: state.modelDraft.profileName || provider?.info?.familyName || provider?.name || state.modelDraft.provider || t('modelCustomOption'), body: providerSection() };
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
  return { title: t('accountTitle'), body: accountSection() };
}

/** Rebuilds the open dialog only when what it shows changed, so a typed key or a selected command survives a refresh. */
function renderDialog() {
  if (!state.dialog) return;
  const { type, rev = 0, pairing = null, confirm = null } = state.dialog;
  const snapshot = state.snapshot;
  const signature = [type, rev, getLocale(), pairing, confirm,
    type === 'machines' ? [snapshot.machines, snapshot.threads.map((entry) => [entry.id, entry.state, entry.workers.map((worker) => [worker.state, worker.machine])]), minuteBucket()] : null,
    type === 'directory' ? snapshot.machines : null,
    type === 'scope' ? [state.selected, snapshot.threads.map((entry) => [entry.id, entry.title, entry.state, entry.repos])] : null,
    type === 'account' ? [state.settings, state.dialog.passkeyAdd] : null];
  redraw('dialog', signature, () => {
    const { title, body } = dialogContent();
    $('#dialog').classList.toggle('settings-dialog', type === 'account');
    $('#dialog').classList.toggle('directory-dialog', type === 'directory');
    $('#dialog-title').replaceChildren(...(type === 'provider' ? [providerIcon(state.modelDraft.dialect || dialectFor(state.modelDraft.provider)), document.createTextNode(title)] : [document.createTextNode(title)]));
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
  state.pushNotice = null; // a fresh visit shows the current state, not the last attempt's result
  drawn.delete('dialog');
  if (type === 'account') void loadSettings();
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
      const { status, data } = await request('/app/api/workspace');
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
  if (!working() && state.pendingModelSwitch && !state.changingModel) {
    const queued = state.pendingModelSwitch;
    state.pendingModelSwitch = null;
    void changeComposerModel(queued);
  }
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
    const { status, data } = await request('/app/api/messages', { id: entry.id, text: entry.text, threadId: entry.threadId ?? undefined, replyTo: entry.replyTo ?? undefined, agent: entry.agent ?? undefined, machineHint: entry.machineHint ?? undefined });
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
  const entry = { id: uuid(), text, threadId: state.selected, replyTo: state.replyTo, agent: state.composerAgent || undefined, machineHint: state.composerMachine || undefined, at: Date.now(), status: 'sending' };
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
    if (state.dialog?.type === 'account') {
      bumpDialog();
      void refreshPushSubscription();
    }
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
  const dialect = (draft.dialect || dialectFor(provider)).trim();
  const profileName = (draft.profileName ?? '').trim();
  const modelId = draft.modelId.trim();
  const baseUrl = draft.baseUrl.trim();
  const apiKey = draft.apiKey.trim();
  const headers = draftHeaders();
  if (headers === null) return;
  if (!provider || !modelId) return;
  if (!$('#model-form').reportValidity()) return;
  const catalog = state.settings.providers.find((entry) => entry.id === dialect);
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
    const { status, data } = await request('/app/api/settings/model', { provider, ...(dialect && dialect !== provider ? { dialect } : {}), ...(profileName ? { profileName } : {}), modelId, ...(apiKey ? { apiKey } : {}), ...(baseUrl ? { baseUrl } : {}), ...(headers ? { headers } : {}), thinkingJson: draft.thinkingJson ?? '', autoTest, ...(dialog.importedModels?.length ? { importedModelIds: dialog.importedModels.map((entry) => entry.id) } : {}), thinkingLevel: draft.thinkingLevel ?? 'off' });
    if (status === 200) {
      draft.apiKey = '';
      if (data?.acceptedThinkingLevels?.length) toast(t('modelAutoTested', { levels: data.acceptedThinkingLevels.map((level) => t(`thinking_${level}`)).join(' / ') }));
      else if (autoTest && data?.verified === false) toast(t('modelAutoTestFailed'));
      else toast(t('modelSaved'));
      const loaded = await loadSettings();
      dialog.saving = false;
      if (!loaded) { dialog.saveError = true; return bumpDialog(); }
      closeDialog();
      if (state.onboarding) setSetupStep('security');
      await refresh();
    } else if (status !== 401) dialog.saveError = true;
  } catch {
    dialog.saveError = true;
  } finally {
    dialog.saving = false;
    bumpDialog();
  }
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
  if (dataset.groupBy) {
    state.sidebarGroupBy = dataset.groupBy;
    if (state.snapshot) renderSidebar();
    return;
  }
  switch (dataset.action) {
    case 'stop-turn': return void stopTurn();
    case 'provider': return openProvider(dataset.provider);
    case 'new-profile': return openNewProfile();
    case 'edit-profile': return editProfile(dataset.profileId);
    case 'toggle-profile': return void toggleProfile(dataset.profileId, dataset.enabled === 'true');
    case 'delete-profile': return void deleteProfile(dataset.profileId);
    case 'provider-variant': return selectProviderVariant(dataset.provider);
    case 'test-model': return void testModel();
    case 'toggle-saved-model': return void toggleSavedModel(dataset.provider, dataset.modelId, dataset.enabled === 'true');
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
    case 'clear-filters':
      state.filter = '';
      state.sidebarAgentFilter = 'all';
      state.sidebarMachineFilter = 'all';
      $('#thread-search').value = '';
      renderSidebar();
      return $('#thread-search').focus();
    case 'clear-reply':
      state.replyTo = null;
      return renderComposer();
    case 'clear-thread-model': return void clearThreadModel();
    case 'sign-out': return void signOut();
    case 'push-enable': return void enablePush();
    case 'push-disable': return void disablePush();
    case 'push-test': return void testPush();
    case 'push-quiet': return void setPushQuiet(!state.pushQuiet);
    case 'create-pairing': return void createPairing();
    case 'copy-pairing': return void copyPairing();
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

const MODEL_DRAFT_FIELDS = { 'model-provider-custom': 'provider', 'model-profile-name': 'profileName', 'model-id-custom': 'modelId', 'model-base-url': 'baseUrl', 'model-headers': 'headersJson', 'model-levels-json': 'thinkingJson', 'model-key': 'apiKey' };
document.addEventListener('input', (event) => {
  if (event.target.id === 'directory-browse-path' && state.dialog?.type === 'directory') state.dialog.pathDraft = event.target.value;
  const directory = state.directoryForms.get(event.target.dataset?.directoryPath);
  if (directory && (directory.state === 'editing' || directory.state === 'failed')) directory.path = event.target.value;
  const field = MODEL_DRAFT_FIELDS[event.target.id];
  if (field && state.modelDraft) {
    state.dialog.test = null;
    $('#model-test-result')?.replaceChildren();
    const isSelect = event.target.tagName === 'SELECT';
    state.modelDraft[field] = isSelect && event.target.value === MODEL_CUSTOM ? '' : event.target.value;
    if (field === 'baseUrl' || field === 'apiKey' || field === 'headersJson') state.dialog.importedModels = null;
    if (field === 'modelId' || field === 'provider' || field === 'baseUrl' || field === 'apiKey' || field === 'headersJson') state.dialog.acceptedThinkingLevels = null;
    if (field === 'thinkingJson') {
      bumpDialog();
      return;
    }
    if (field === 'baseUrl') $('#provider-endpoint')?.replaceChildren(document.createTextNode(state.modelDraft.baseUrl.trim() || state.settings.providers.find((entry) => entry.id === (state.modelDraft.dialect || dialectFor(state.modelDraft.provider)))?.models.find((entry) => entry.id === state.modelDraft.modelId)?.baseUrl || t('providerEndpointUnknown')));
    if (isSelect) {
      bumpDialog();
      if (event.target.value === MODEL_CUSTOM) $('#model-id-custom')?.focus();
    }
  }
  if (event.target.id === 'passkey-label') state.passkeyLabelDraft = event.target.value;
});
document.addEventListener('change', (event) => {
  if (event.target.id === 'sidebar-agent-filter') {
    state.sidebarAgentFilter = event.target.value || 'all';
    if (state.snapshot) renderSidebar();
    return;
  }
  if (event.target.id === 'sidebar-machine-filter') {
    state.sidebarMachineFilter = event.target.value || 'all';
    if (state.snapshot) renderSidebar();
    return;
  }
  if (event.target.id === 'composer-agent-select') {
    state.composerAgent = event.target.value || '';
    renderComposerDispatch();
    return;
  }
  if (event.target.id === 'composer-machine-select') {
    state.composerMachine = event.target.value || '';
    renderComposerDispatch();
    return;
  }
  if (event.target.id === 'model-auto-test' && state.dialog) {
    state.dialog.autoTest = event.target.checked;
    return;
  }
  if (event.target.id === 'model-profile-dialect' && state.modelDraft) {
    const dialect = event.target.value;
    state.modelDraft.dialect = dialect;
    state.modelDraft.modelId = modelAfterProviderChange(state.settings.providers, dialect, state.modelDraft.modelId) ?? '';
    const selected = state.settings.providers.find((entry) => entry.id === dialect)?.models.find((entry) => entry.id === state.modelDraft.modelId);
    state.modelDraft.customModel = dialect.endsWith('-compatible') || !selected;
    state.modelDraft.thinkingLevel = dialect === 'openai-compatible' ? 'auto' : dialect.endsWith('-compatible') ? 'off' : thinkingAfterModelChange(selected, state.modelDraft.thinkingLevel);
    state.dialog.importedModels = null;
    state.dialog.acceptedThinkingLevels = null;
    state.dialog.test = null;
    bumpDialog();
    return;
  }
  if (event.target.id !== 'model-api' || !state.modelDraft) return;
  if (!state.modelDraft.isNewProfile && (!state.modelDraft.provider || state.modelDraft.provider.endsWith('-compatible'))) {
    state.modelDraft.provider = event.target.value;
  }
  state.modelDraft.dialect = event.target.value;
  state.modelDraft.thinkingLevel = event.target.value === 'openai-compatible' ? 'auto' : 'off';
  state.dialog.importedModels = null;
  state.dialog.acceptedThinkingLevels = null;
  state.dialog.test = null;
  bumpDialog();
});
document.addEventListener('submit', (event) => {
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

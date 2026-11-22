// Global Command-K workspace search palette: instant local suggestions, debounced AbortController
// search over /app/api/search, safe UTF-16 highlight slicing, and full keyboard navigation.
// Built strictly with h() text nodes from dom.js — zero HTML sinks, zero inline styles.
import { h, icon } from './dom.js';
import { formatClock, formatDay, formatRelative } from './format.js';
import { localeTag, t, tOr } from './i18n.js';

export const SEARCH_PALETTE_SCOPES = ['all', 'threads', 'messages', 'reports', 'pr', 'memory'];

export const SEARCH_PALETTE_I18N_KEYS = [
  'spScope_all', 'spScope_threads', 'spScope_messages', 'spScope_reports', 'spScope_pr', 'spScope_memory',
  'spKind_thread', 'spKind_message', 'spKind_report', 'spKind_pr_watch', 'spKind_memory',
  'spSuggest_waiting', 'spSuggest_running', 'spSuggest_recent',
];

const KIND_ICONS = {
  thread: 'layers',
  message: 'chat',
  report: 'sparkle',
  pr_watch: 'branch',
  memory: 'memory',
};

/** Validates and merges [start, end] UTF-16 code-unit highlight intervals into non-overlapping slices. */
export function normalizeHighlightRanges(textLength, ranges) {
  if (!Number.isInteger(textLength) || textLength <= 0 || !Array.isArray(ranges) || ranges.length === 0) {
    return [];
  }
  const valid = [];
  for (const pair of ranges) {
    if (!Array.isArray(pair) || pair.length < 2) continue;
    const rawStart = pair[0];
    const rawEnd = pair[1];
    if (!Number.isInteger(rawStart) || !Number.isInteger(rawEnd)) continue;
    const start = Math.max(0, Math.min(textLength, rawStart));
    const end = Math.max(0, Math.min(textLength, rawEnd));
    if (end > start) valid.push([start, end]);
  }
  if (valid.length === 0) return [];
  valid.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged = [valid[0]];
  for (let i = 1; i < valid.length; i += 1) {
    const prev = merged[merged.length - 1];
    const curr = valid[i];
    if (curr[0] <= prev[1]) {
      if (curr[1] > prev[1]) prev[1] = curr[1];
    } else {
      merged.push([curr[0], curr[1]]);
    }
  }
  return merged;
}

/** Pure DOM-free splitter returning alternating plain and matched text segments. */
export function highlightSegments(text, ranges) {
  const str = typeof text === 'string' ? text : '';
  if (!str) return [];
  const clean = normalizeHighlightRanges(str.length, ranges);
  if (clean.length === 0) return [{ text: str, match: false }];
  const out = [];
  let cursor = 0;
  for (const [start, end] of clean) {
    if (start > cursor) out.push({ text: str.slice(cursor, start), match: false });
    out.push({ text: str.slice(start, end), match: true });
    cursor = end;
  }
  if (cursor < str.length) out.push({ text: str.slice(cursor), match: false });
  return out;
}

/** Renders text with safe <mark class="search-mark"> nodes without parsing HTML. */
export function highlightText(text, ranges) {
  const segments = highlightSegments(text, ranges);
  if (segments.length === 0) return '';
  return segments.map((seg) => (seg.match ? h('mark', { class: 'search-mark' }, seg.text) : seg.text));
}

function findLocalRange(text, needle) {
  if (!text || !needle) return [];
  const lower = text.toLowerCase();
  const target = needle.toLowerCase();
  const idx = lower.indexOf(target);
  return idx >= 0 ? [[idx, idx + target.length]] : [];
}

/** Builds zero-network instant suggestions from the loaded workspace snapshot when query < 2 chars. */
export function buildLocalSuggestions(snapshot, query = '', limit = 8) {
  const threads = Array.isArray(snapshot?.threads) ? snapshot.threads : [];
  if (threads.length === 0) return [];
  const needle = typeof query === 'string' ? query.trim().toLowerCase() : '';
  const activePool = threads.filter((entry) => !entry.archived);
  const pool = activePool.length > 0 || !needle ? activePool : threads;
  const filtered = needle
    ? threads.filter((entry) => {
      const hay = [
        entry.title,
        entry.goal,
        entry.summary,
        entry.machine,
        ...(entry.repos ?? []),
        ...(entry.workers ?? []).map((w) => w.branch),
      ].filter(Boolean).join('\n').toLowerCase();
      return hay.includes(needle);
    })
    : pool;

  const rank = (entry) => (entry.archived ? 3 : entry.state === 'waiting_you' ? 0 : entry.state === 'running' ? 1 : 2);
  const sorted = [...filtered].sort((a, b) => rank(a) - rank(b) || (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));

  return sorted.slice(0, Math.max(1, limit)).map((thread) => {
    const suggestGroup = thread.state === 'waiting_you' ? 'waiting' : thread.state === 'running' ? 'running' : 'recent';
    const subtitle = [(thread.repos ?? []).join(', '), thread.machine].filter(Boolean).join(' · ') || null;
    const rawSnippet = (thread.summary || thread.goal || '').replace(/\s+/g, ' ').trim().slice(0, 140);
    return {
      id: `suggest:thread:${thread.id}`,
      kind: 'thread',
      suggestGroup,
      title: thread.title,
      subtitle,
      snippet: rawSnippet,
      highlights: needle ? findLocalRange(rawSnippet, needle) : [],
      titleHighlights: needle ? findLocalRange(thread.title, needle) : [],
      threadId: thread.id,
      threadTitle: thread.title,
      threadArchived: Boolean(thread.archived),
      at: thread.lastActivityAt ?? 0,
      anchor: { type: 'thread', threadId: thread.id },
    };
  });
}

export function createSearchPalette(deps) {
  const { fetchSearch, getSnapshot, getSelectedThread, bump, activateHit, close, serverNow } = deps;

  const sp = {
    q: '',
    scope: 'all',
    currentThreadOnly: false,
    status: 'idle',
    items: [],
    truncated: false,
    activeIndex: 0,
    rev: 0,
  };

  let debounceTimer = null;
  let inflight = null;
  let inputEl = null;
  let clearBtnEl = null;
  let spinnerEl = null;
  let scopesBarEl = null;
  let resultsEl = null;
  let footerEl = null;
  let rootEl = null;

  const codePointLen = (value) => [...value.trim()].length;

  function abortPending() {
    clearTimeout(debounceTimer);
    debounceTimer = null;
    if (inflight) {
      inflight.abort();
      inflight = null;
    }
  }

  function visibleList() {
    if (codePointLen(sp.q) < 2) {
      return buildLocalSuggestions(getSnapshot(), sp.q, 8);
    }
    return sp.items;
  }

  function formatStamp(ts) {
    if (!ts || !Number.isFinite(ts)) return '';
    const now = serverNow();
    if (Math.abs(now - ts) < 86_400_000 * 2) {
      return formatRelative(ts, now, localeTag(), t('justNow'));
    }
    return `${formatDay(ts, now, localeTag(), { today: t('today'), yesterday: t('yesterday') })} ${formatClock(ts)}`;
  }

  function syncActiveDescendant(list) {
    if (!inputEl) return;
    if (list.length > 0 && sp.activeIndex >= 0 && sp.activeIndex < list.length) {
      inputEl.setAttribute('aria-activedescendant', `sp-option-${sp.activeIndex}`);
    } else {
      inputEl.removeAttribute('aria-activedescendant');
    }
  }

  function scrollActiveIntoView() {
    if (!resultsEl) return;
    const activeNode = resultsEl.querySelector(`#sp-option-${sp.activeIndex}`);
    activeNode?.scrollIntoView({ block: 'nearest' });
  }

  async function runSearch() {
    const trimmed = sp.q.trim();
    if (codePointLen(trimmed) < 2) {
      abortPending();
      sp.status = 'idle';
      sp.items = [];
      sp.truncated = false;
      sp.activeIndex = 0;
      paint();
      return;
    }
    abortPending();
    const controller = new AbortController();
    inflight = controller;
    sp.status = 'loading';
    paint();

    const params = new URLSearchParams();
    params.set('q', trimmed.slice(0, 160));
    params.set('scope', sp.scope);
    params.set('limit', '30');
    const selectedThread = sp.currentThreadOnly ? getSelectedThread() : null;
    if (selectedThread?.id) params.set('threadId', selectedThread.id);

    const res = await fetchSearch(`/app/api/search?${params.toString()}`, controller.signal);
    if (inflight !== controller || res.aborted) return;
    inflight = null;

    if (res.status === 200 && res.data && Array.isArray(res.data.items)) {
      sp.items = res.data.items;
      sp.truncated = Boolean(res.data.truncated);
      sp.status = 'ready';
      sp.activeIndex = 0;
    } else if (res.status !== 401) {
      sp.status = 'error';
    }
    paint();
    bump();
  }

  function scheduleSearch(immediate = false) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
    if (codePointLen(sp.q) < 2) {
      if (inflight) {
        inflight.abort();
        inflight = null;
      }
      sp.status = 'idle';
      sp.items = [];
      sp.truncated = false;
      sp.activeIndex = 0;
      paint();
      return;
    }
    if (immediate) {
      void runSearch();
      return;
    }
    sp.status = 'loading';
    paint();
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void runSearch();
    }, 160);
  }

  function selectItem(hit) {
    if (!hit) return;
    const enriched = { ...hit, query: sp.q.trim() };
    void activateHit(enriched);
  }

  function renderHitOption(hit, index) {
    const active = index === sp.activeIndex;
    const isSuggestion = Boolean(hit.suggestGroup);
    const badgeKey = isSuggestion
      ? `spSuggest_${hit.suggestGroup}`
      : `spKind_${hit.kind}`;
    const badgeTone = hit.suggestGroup === 'waiting'
      ? ' warn'
      : hit.suggestGroup === 'running'
        ? ' accent'
        : '';

    return h('button', {
      type: 'button',
      id: `sp-option-${index}`,
      role: 'option',
      'aria-selected': String(active),
      class: `sp-item${active ? ' is-active' : ''}`,
      onmouseenter: () => {
        if (sp.activeIndex === index) return;
        sp.activeIndex = index;
        if (resultsEl) {
          for (const node of resultsEl.querySelectorAll('.sp-item')) {
            const isTarget = node.id === `sp-option-${index}`;
            node.classList.toggle('is-active', isTarget);
            node.setAttribute('aria-selected', String(isTarget));
          }
        }
        syncActiveDescendant(visibleList());
      },
      onclick: () => selectItem(hit),
    },
    h('div', { class: 'sp-item-head' },
      h('span', { class: 'sp-item-icon' }, icon(KIND_ICONS[hit.kind] ?? 'search')),
      h('span', { class: `cp-badge sp-kind-badge${badgeTone}` }, tOr(badgeKey, hit.kind)),
      hit.threadArchived ? h('span', { class: 'cp-badge' }, t('spArchivedTag')) : null,
      h('strong', { class: 'sp-item-title' }, highlightText(hit.title, hit.titleHighlights)),
      hit.at ? h('time', { class: 'sp-item-time' }, formatStamp(hit.at)) : null),
    hit.subtitle ? h('div', { class: 'sp-item-subtitle' }, hit.subtitle) : null,
    hit.snippet ? h('p', { class: 'sp-item-snippet' }, highlightText(hit.snippet, hit.highlights)) : null);
  }

  function ensureShell() {
    if (rootEl) return rootEl;
    inputEl = h('input', {
      id: 'search-palette-input',
      type: 'search',
      class: 'sp-input',
      maxlength: 160,
      autocomplete: 'off',
      autocapitalize: 'off',
      spellcheck: 'false',
      role: 'combobox',
      'aria-expanded': 'true',
      'aria-controls': 'search-palette-results',
      'aria-autocomplete': 'list',
      dataset: { focus: 'search-palette-input' },
      oninput: (e) => {
        sp.q = e.target.value;
        if (e.isComposing) {
          if (clearBtnEl) clearBtnEl.hidden = !sp.q;
          return;
        }
        scheduleSearch(false);
      },
      oncompositionend: (e) => {
        sp.q = e.target.value;
        scheduleSearch(false);
      },
      onkeydown: (e) => {
        if (e.isComposing) return;
        const list = visibleList();
        if (e.key === 'ArrowDown' || (e.ctrlKey && e.key.toLowerCase() === 'n')) {
          e.preventDefault();
          if (list.length > 0) {
            sp.activeIndex = (sp.activeIndex + 1) % list.length;
            paint();
            scrollActiveIntoView();
          }
          return;
        }
        if (e.key === 'ArrowUp' || (e.ctrlKey && e.key.toLowerCase() === 'p')) {
          e.preventDefault();
          if (list.length > 0) {
            sp.activeIndex = (sp.activeIndex - 1 + list.length) % list.length;
            paint();
            scrollActiveIntoView();
          }
          return;
        }
        if (e.key === 'Tab' && !e.metaKey && !e.ctrlKey && !e.altKey) {
          e.preventDefault();
          const idx = SEARCH_PALETTE_SCOPES.indexOf(sp.scope);
          const nextIdx = e.shiftKey
            ? (idx - 1 + SEARCH_PALETTE_SCOPES.length) % SEARCH_PALETTE_SCOPES.length
            : (idx + 1) % SEARCH_PALETTE_SCOPES.length;
          sp.scope = SEARCH_PALETTE_SCOPES[nextIdx];
          sp.activeIndex = 0;
          scheduleSearch(true);
          return;
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          if (list[sp.activeIndex]) selectItem(list[sp.activeIndex]);
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          close();
        }
      },
    });

    spinnerEl = h('span', { class: 'sp-loading-tag', hidden: true });
    clearBtnEl = h('button', {
      type: 'button',
      class: 'icon-button sp-clear-btn',
      hidden: true,
      onclick: () => {
        sp.q = '';
        if (inputEl) inputEl.value = '';
        scheduleSearch(true);
        inputEl?.focus();
      },
    }, icon('close'));

    scopesBarEl = h('div', { class: 'sp-filter-bar' });
    resultsEl = h('div', { id: 'search-palette-results', class: 'sp-results', role: 'listbox' });
    footerEl = h('footer', { class: 'sp-footer' });

    rootEl = h('div', { class: 'sp-root' },
      h('div', { class: 'sp-input-bar' },
        h('span', { class: 'sp-search-icon' }, icon('search')),
        inputEl,
        spinnerEl,
        clearBtnEl),
      scopesBarEl,
      resultsEl,
      footerEl);
    return rootEl;
  }

  function paint() {
    ensureShell();
    const selectedThread = getSelectedThread();
    if (!selectedThread && sp.currentThreadOnly) sp.currentThreadOnly = false;

    inputEl.placeholder = t('spInputPlaceholder');
    inputEl.setAttribute('aria-label', t('spDialogTitle'));
    if (document.activeElement !== inputEl && inputEl.value !== sp.q) {
      inputEl.value = sp.q;
    }
    clearBtnEl.hidden = !sp.q;
    clearBtnEl.setAttribute('aria-label', t('spClearQuery'));
    clearBtnEl.title = t('spClearQuery');

    spinnerEl.textContent = t('spLoading');
    spinnerEl.hidden = sp.status !== 'loading';

    scopesBarEl.replaceChildren(
      h('div', { class: 'cp-pills sp-scopes', role: 'tablist' },
        SEARCH_PALETTE_SCOPES.map((scope) => h('button', {
          type: 'button',
          role: 'tab',
          'aria-selected': String(sp.scope === scope),
          class: `cp-pill${sp.scope === scope ? ' active' : ''}`,
          onclick: () => {
            sp.scope = scope;
            sp.activeIndex = 0;
            scheduleSearch(true);
            inputEl?.focus();
          },
        }, t(`spScope_${scope}`)))),
      selectedThread
        ? h('button', {
          type: 'button',
          class: `cp-pill sp-thread-toggle${sp.currentThreadOnly ? ' active' : ''}`,
          'aria-pressed': String(sp.currentThreadOnly),
          title: selectedThread.title,
          onclick: () => {
            sp.currentThreadOnly = !sp.currentThreadOnly;
            sp.activeIndex = 0;
            scheduleSearch(true);
            inputEl?.focus();
          },
        }, icon('layers'), t('spCurrentThreadOnly'))
        : null);

    const len = codePointLen(sp.q);
    const list = visibleList();
    if (sp.activeIndex >= list.length) sp.activeIndex = 0;
    syncActiveDescendant(list);

    const bodyNodes = [];
    if (len === 1) {
      bodyNodes.push(h('p', { class: 'sp-section-hint' }, t('spShortQueryHint')));
    }
    if (len < 2) {
      if (list.length > 0) {
        bodyNodes.push(h('div', { class: 'sp-group-label' }, t('spSuggestHeading')));
        bodyNodes.push(...list.map((item, idx) => renderHitOption(item, idx)));
      } else {
        bodyNodes.push(h('div', { class: 'sp-empty' }, h('p', null, t('spEmptySuggestions'))));
      }
    } else if (sp.status === 'error') {
      bodyNodes.push(h('div', { class: 'sp-empty sp-error', role: 'alert' }, h('p', null, t('spError'))));
    } else if (list.length === 0 && sp.status === 'loading') {
      bodyNodes.push(h('div', { class: 'sp-empty', role: 'status' }, h('p', null, t('spLoading'))));
    } else if (list.length === 0) {
      bodyNodes.push(h('div', { class: 'sp-empty' },
        h('strong', null, t('spNoResults')),
        h('p', null, t('spNoResultsHelp'))));
    } else {
      bodyNodes.push(...list.map((item, idx) => renderHitOption(item, idx)));
      if (sp.truncated) {
        bodyNodes.push(h('p', { class: 'sp-truncated-note' }, t('spTruncatedNotice', { count: list.length })));
      }
    }
    resultsEl.replaceChildren(...bodyNodes);

    footerEl.replaceChildren(
      h('span', { class: 'sp-kbd-hint' }, h('kbd', null, '↑↓'), ' ', t('spNavHintMove')),
      h('span', { class: 'sp-kbd-hint' }, h('kbd', null, 'Tab'), ' ', t('spNavHintScope')),
      h('span', { class: 'sp-kbd-hint' }, h('kbd', null, '↵'), ' ', t('spNavHintOpen')),
      h('span', { class: 'sp-kbd-hint' }, h('kbd', null, 'Esc'), ' ', t('spNavHintClose')));
  }

  return {
    open() {
      abortPending();
      sp.activeIndex = 0;
      if (!getSelectedThread()) sp.currentThreadOnly = false;
      sp.rev += 1;
      ensureShell();
      if (inputEl) inputEl.value = sp.q;
      if (codePointLen(sp.q) >= 2) {
        void runSearch();
      } else {
        sp.status = 'idle';
        sp.items = [];
        sp.truncated = false;
        paint();
      }
    },
    abort() {
      abortPending();
    },
    focusInput() {
      if (!inputEl) return;
      inputEl.focus({ preventScroll: true });
      if (inputEl.value) inputEl.select();
    },
    signature() {
      return [sp.rev, sp.scope, sp.currentThreadOnly, sp.status, getSelectedThread()?.id ?? null];
    },
    title() {
      return t('spDialogTitle');
    },
    render() {
      paint();
      return rootEl;
    },
  };
}

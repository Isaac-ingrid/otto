// Read-only PR CI failure diagnosis dialog & composer prefill helper (Direction A).
// Built strictly with dom.js h() text nodes — never parses untrusted CI strings as HTML.
import { h, icon } from './dom.js';
import { safeUrl } from './format.js';
import { t } from './i18n.js';

const CATEGORY_KEYS = {
  test_failure: 'prDiagCat_test_failure',
  typecheck_or_build: 'prDiagCat_typecheck_or_build',
  lint_or_format: 'prDiagCat_lint_or_format',
  infra_or_timeout: 'prDiagCat_infra_or_timeout',
  config_or_permission: 'prDiagCat_config_or_permission',
  unknown: 'prDiagCat_unknown',
};

const SOURCE_KEYS = {
  actions_logs: 'prDiagSource_actions_logs',
  checks_annotations: 'prDiagSource_checks_annotations',
  checks_summary: 'prDiagSource_checks_summary',
  statuses_only: 'prDiagSource_statuses_only',
};

const SKIP_KEYS = {
  skipped_over_budget: 'prDiagSkip_over_budget',
  skipped_no_model: 'prDiagSkip_no_model',
  failed: 'prDiagSkip_failed',
};

const LOG_NOTE_KEYS = [
  'prDiagNote_auth_required',
  'prDiagNote_truncated',
  'prDiagNote_redirect_blocked',
  'prDiagNote_unavailable',
];

export const PR_DIAGNOSIS_I18N_KEYS = [
  ...Object.values(CATEGORY_KEYS),
  ...Object.values(SOURCE_KEYS),
  ...Object.values(SKIP_KEYS),
  ...LOG_NOTE_KEYS,
];

export function prDiagnosisCategoryKey(category) {
  return (category && CATEGORY_KEYS[category]) || 'prDiagCat_unknown';
}

export function prDiagnosisSourceKey(logSource) {
  return (logSource && SOURCE_KEYS[logSource]) || 'prDiagSource_checks_summary';
}

export function prDiagnosisSkipKey(status) {
  return (status && SKIP_KEYS[status]) || null;
}

export function prDiagnosisLogNoteText(logNote) {
  if (!logNote || typeof logNote !== 'string') return null;
  if (/^actions_(?:logs|job)_http_(?:401|403|404)$/.test(logNote)) return t('prDiagNote_auth_required');
  if (logNote === 'actions_logs_truncated_256k') return t('prDiagNote_truncated');
  if (logNote === 'actions_logs_disallowed_redirect') return t('prDiagNote_redirect_blocked');
  if (logNote.startsWith('actions_')) return t('prDiagNote_unavailable');
  return logNote;
}

export function formatPrDiagnosisPlainText(data) {
  if (!data?.snapshot) return '';
  const snap = data.snapshot;
  const diag = data.effectiveDiagnosis;
  const lines = [];
  if (data.watch?.url) lines.push(`PR: ${data.watch.url}`);
  if (snap.head) lines.push(`Commit: ${snap.head}`);
  if (diag?.headline) lines.push(`Headline: ${diag.headline}`);
  for (const cause of diag?.rootCauses ?? []) lines.push(`- ${cause}`);
  for (const item of snap.items ?? []) {
    lines.push(`\n[${item.name}] (${item.conclusion})${item.failedStep ? ` — step: ${item.failedStep}` : ''}`);
    for (const ann of item.annotations ?? []) {
      lines.push(`  ${ann.path}:${ann.line} ${ann.title ? `[${ann.title}] ` : ''}${ann.message}`);
    }
    if (item.logExcerpt) lines.push(item.logExcerpt);
  }
  return lines.join('\n');
}

export function createPrDiagnosisModal(deps) {
  const { request, uuid, toast, bump, fillContinuation } = deps;

  const state = {
    rev: 0,
    watchId: null,
    head: null,
    threadId: null,
    prUrl: null,
    status: 'idle',
    errorCode: null,
    data: null,
    refreshing: false,
  };

  const touch = () => {
    state.rev += 1;
    bump();
  };

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast(t('ckCopied'));
    } catch {
      toast(t('ckCopyFailed'));
    }
  }

  async function fetchDiagnosis(watchId, head) {
    const body = {};
    if (head && /^[a-f0-9]{40}$/i.test(head)) body.head = head;
    return request(`/app/api/pr-watches/${encodeURIComponent(watchId)}/diagnosis`, body);
  }

  async function load(watchId, head) {
    state.status = 'loading';
    state.errorCode = null;
    touch();
    try {
      const { status, data } = await fetchDiagnosis(watchId, head);
      if (status === 200 && data?.ok) {
        state.data = data;
        state.status = 'ready';
      } else if (status === 404 && !data?.error) {
        state.status = 'error';
        state.errorCode = 'reload_required';
      } else if (status !== 401) {
        state.status = 'error';
        state.errorCode = data?.error || 'load_failed';
      }
    } catch {
      state.status = 'error';
      state.errorCode = 'load_failed';
    }
    touch();
  }

  async function regenerateSummary() {
    if (state.refreshing || !state.watchId) return;
    state.refreshing = true;
    touch();
    try {
      const targetHead = state.data?.head || state.head;
      const body = { id: uuid(), refreshDiagnosis: true };
      if (targetHead && /^[a-f0-9]{40}$/i.test(targetHead)) body.head = targetHead;
      const { status, data } = await request(
        `/app/api/pr-watches/${encodeURIComponent(state.watchId)}/diagnosis`,
        body,
      );
      if (status === 200 && data?.ok) {
        state.data = data;
        toast(t('prDiagRefreshedToast'));
      } else if (status === 409 && data?.error === 'over_budget') {
        if (state.data) state.data = { ...state.data, diagnosisStatus: 'skipped_over_budget' };
        toast(t('ckDistillOverLimit'));
      } else if (status === 404 && !data?.error) {
        toast(t('backendReloadRequired'));
      } else if (status !== 401) {
        toast(t('ckDistillFailed'));
      }
    } catch {
      toast(t('ckDistillFailed'));
    } finally {
      state.refreshing = false;
      touch();
    }
  }

  async function prefillQuickFix(watchId, opts = {}) {
    if (!watchId) return;
    try {
      const { status, data } = await fetchDiagnosis(watchId, opts.head);
      if (status === 200 && data?.repairPrompt) {
        const targetThread = data.watch?.threadId || opts.threadId;
        if (targetThread) {
          fillContinuation(targetThread, data.repairPrompt);
          toast(t('prDiagPrefilledToast'));
          return;
        }
      }
      if (status === 404 && !data?.error) {
        toast(t('backendReloadRequired'));
        return;
      }
      toast(t('prDiagEmptySnapshot'));
    } catch {
      toast(t('cpActionFailed'));
    }
  }

  function renderItemCard(item) {
    const itemHref = safeUrl(item.url);
    const annotations = Array.isArray(item.annotations) ? item.annotations : [];
    return h('article', { class: 'cp-card pr-diag-item' },
      h('div', { class: 'cp-card-head' },
        h('div', { class: 'cp-badges' },
          h('strong', { class: 'pr-diag-item-name' }, item.name),
          h('span', { class: 'cp-badge warn' }, item.conclusion)),
        itemHref
          ? h('a', { class: 'cp-ext-link', href: itemHref, target: '_blank', rel: 'noopener noreferrer' }, t('prDiagOpenGithubBtn'), icon('external'))
          : null),
      item.failedStep
        ? h('p', { class: 'pr-diag-step' }, icon('alert'), ' ', t('prDiagStepLabel', { step: item.failedStep }))
        : null,
      annotations.length > 0
        ? h('div', { class: 'pr-diag-block' },
          h('span', { class: 'cp-meta' }, t('prDiagAnnotationsTitle', { count: annotations.length })),
          h('ul', { class: 'pr-diag-annotations' },
            annotations.map((ann) => h('li', null,
              h('code', { class: 'cp-sha' }, `${ann.path}:${ann.line}`),
              ann.title ? h('strong', null, ` ${ann.title}: `) : ' ',
              ann.message))))
        : null,
      item.summaryText && !item.logExcerpt
        ? h('div', { class: 'pr-diag-block' },
          h('span', { class: 'cp-meta' }, t('prDiagCheckSummaryTitle')),
          h('pre', { class: 'pr-diag-log' }, item.summaryText))
        : null,
      item.logExcerpt
        ? h('div', { class: 'pr-diag-block' },
          h('div', { class: 'pr-diag-log-head' },
            h('span', { class: 'cp-meta' }, t('prDiagLogTailTitle')),
            h('button', {
              type: 'button',
              class: 'cp-mini-btn',
              onclick: () => void copyText(item.logExcerpt),
            }, t('prDiagCopyLogBtn'))),
          h('pre', { class: 'pr-diag-log' }, item.logExcerpt))
        : null);
  }

  function renderBody() {
    if (state.status === 'loading') {
      return h('div', { class: 'cp-pane' }, h('p', { class: 'cp-empty' }, t('cpLoading')));
    }
    if (state.status === 'error') {
      const msg = state.errorCode === 'reload_required' ? t('backendReloadRequired') : t('cpLoadFailed');
      return h('div', { class: 'cp-pane' }, h('p', { class: 'cp-error' }, msg));
    }

    const data = state.data;
    const snap = data?.snapshot;
    const watch = data?.watch;
    const prHref = safeUrl(watch?.url || state.prUrl);

    if (!snap) {
      return h('div', { class: 'cp-pane' },
        h('p', { class: 'cp-empty' }, t('prDiagEmptySnapshot')),
        prHref
          ? h('div', { class: 'cp-form-actions' },
            h('a', { class: 'cp-mini-btn cp-ext-link', href: prHref, target: '_blank', rel: 'noopener noreferrer' }, t('prDiagOpenGithubBtn'), icon('external')))
          : null);
    }

    const diag = data.effectiveDiagnosis;
    const diagStatus = data.diagnosisStatus;
    const skipKey = prDiagnosisSkipKey(diagStatus);
    const targetThread = watch?.threadId || state.threadId;
    const repairPrompt = data.repairPrompt;

    return h('div', { class: 'cp-pane pr-diag-pane' },
      h('div', { class: 'cp-tabs-bar pr-diag-meta' },
        h('div', { class: 'cp-badges' },
          snap.head ? h('code', { class: 'cp-sha' }, snap.head.slice(0, 12)) : null,
          h('span', { class: 'cp-badge accent' }, t(prDiagnosisSourceKey(snap.logSource))),
          diag ? h('span', { class: 'cp-badge warn' }, t(prDiagnosisCategoryKey(diag.category))) : null,
          h('span', { class: 'cp-badge' }, diagStatus === 'ready' ? t('prDiagAiBadge') : t('prDiagDetBadge'))),
        prHref
          ? h('a', { class: 'cp-ext-link', href: prHref, target: '_blank', rel: 'noopener noreferrer' }, watch?.url || state.prUrl, icon('external'))
          : null),
      snap.logNote ? h('p', { class: 'cp-meta pr-diag-note' }, prDiagnosisLogNoteText(snap.logNote)) : null,
      diag
        ? h('section', { class: 'cp-card pr-diag-summary' },
          h('p', { class: 'pr-diag-headline' }, diag.headline),
          Array.isArray(diag.rootCauses) && diag.rootCauses.length > 0
            ? h('ul', { class: 'pr-diag-causes' }, diag.rootCauses.map((cause) => h('li', null, cause)))
            : null,
          skipKey
            ? h('div', { class: 'pr-diag-skip-bar' },
              h('span', { class: 'cp-meta' }, t(skipKey)),
              h('button', {
                type: 'button',
                class: 'cp-mini-btn',
                disabled: state.refreshing ? true : null,
                onclick: () => void regenerateSummary(),
              }, icon('sparkle'), ' ', state.refreshing ? t('prDiagRegenerating') : t('prDiagRegenerateBtn')))
            : null)
        : null,
      h('section', { class: 'cp-section' },
        h('div', { class: 'cp-list' }, (snap.items ?? []).map(renderItemCard))),
      h('div', { class: 'pr-diag-footer' },
        h('div', { class: 'cp-form-actions' },
          repairPrompt && targetThread
            ? h('button', {
              type: 'button',
              class: 'cp-primary-btn',
              onclick: () => {
                fillContinuation(targetThread, repairPrompt);
                toast(t('prDiagPrefilledToast'));
              },
            }, icon('chat'), ' ', t('prDiagDispatchBtn'))
            : null,
          repairPrompt
            ? h('button', {
              type: 'button',
              class: 'cp-mini-btn',
              onclick: () => void copyText(repairPrompt),
            }, t('prDiagCopyPromptBtn'))
            : null,
          prHref
            ? h('a', { class: 'cp-mini-btn cp-ext-link', href: prHref, target: '_blank', rel: 'noopener noreferrer' }, t('prDiagOpenGithubBtn'), icon('external'))
            : null),
        h('p', { class: 'cp-meta pr-diag-footnote' }, t('prDiagReadOnlyFootnote'))));
  }

  return {
    signature: () => [
      state.rev,
      state.watchId,
      state.head,
      state.status,
      state.errorCode,
      state.refreshing,
      state.data?.head,
      state.data?.diagnosisStatus,
    ],
    title: () => t('prDiagTitle'),
    open(watchId, opts = {}) {
      state.watchId = watchId;
      state.head = opts.head || null;
      state.threadId = opts.threadId || null;
      state.prUrl = opts.url || null;
      state.data = null;
      state.refreshing = false;
      void load(watchId, state.head);
    },
    prefillQuickFix,
    render: renderBody,
  };
}

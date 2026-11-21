// Read-only PR CI failure, merge conflict & code review triage dialog (Directions A & B).
// Built strictly with dom.js h() text nodes — never parses untrusted CI or PR comments as HTML.
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

const REVIEW_DECISION_KEYS = {
  changes_requested: 'prRev_changes_requested',
  approved: 'prRev_approved',
  commented: 'prRev_commented',
};

const ACTION_BUTTON_KEYS = {
  fix_ci: 'prDiagDispatchBtn',
  resolve_conflict: 'prAct_resolve_conflict',
  address_review: 'prAct_address_review',
  combined: 'prAct_combined',
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
  ...Object.values(REVIEW_DECISION_KEYS),
  ...Object.values(ACTION_BUTTON_KEYS),
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

export function prReviewDecisionKey(decision) {
  return (decision && REVIEW_DECISION_KEYS[decision]) || null;
}

export function prActionButtonKey(actionKind) {
  return (actionKind && ACTION_BUTTON_KEYS[actionKind]) || 'prDiagDispatchBtn';
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
  const snap = data?.snapshot;
  const fb = data?.feedback;
  if (!snap && !fb) return '';
  const lines = [];
  if (data.watch?.url) lines.push(`PR: ${data.watch.url}`);
  const head = snap?.head || fb?.head || data.head;
  if (head) lines.push(`Commit: ${head}`);
  if (fb?.mergeState === 'conflicted') {
    lines.push(`Merge conflict: ${fb.headRef || 'head'} -> ${fb.baseRef || 'base'}`);
  }
  if (fb?.effectiveTriage?.headline && fb.reviewDecision !== 'none') {
    lines.push(`Review: ${fb.effectiveTriage.headline}`);
    for (const item of fb.effectiveTriage.actionItems ?? []) lines.push(`- ${item}`);
  }
  for (const thread of fb?.snapshot?.threads ?? []) {
    lines.push(`  @${thread.author} ${thread.path}:${thread.line} — ${thread.body}`);
  }
  const diag = data.effectiveDiagnosis;
  if (snap && diag?.headline) {
    lines.push(`Headline: ${diag.headline}`);
    for (const cause of diag.rootCauses ?? []) lines.push(`- ${cause}`);
  }
  for (const item of snap?.items ?? []) {
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
      const promptText = data?.actionPrompt || data?.repairPrompt;
      if (status === 200 && promptText) {
        const targetThread = data.watch?.threadId || opts.threadId;
        if (targetThread) {
          fillContinuation(targetThread, promptText);
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

  function renderConflictSection(fb) {
    if (fb?.mergeState !== 'conflicted') return null;
    const baseRef = fb.baseRef || 'main';
    const desc = fb.headRef
      ? t('prConflictBranches', { head: fb.headRef, base: baseRef })
      : t('prConflictBaseOnly', { base: baseRef });
    return h('section', { class: 'cp-card pr-diag-conflict' },
      h('div', { class: 'cp-card-head' },
        h('div', { class: 'cp-badges' },
          h('span', { class: 'cp-badge warn' }, t('prMergeConflictedBadge'))),
        fb.baseSha ? h('code', { class: 'cp-sha' }, `${baseRef}@${fb.baseSha.slice(0, 7)}`) : null),
      h('p', { class: 'pr-diag-headline' }, desc),
      h('p', { class: 'cp-meta pr-diag-note' }, t('prConflictWorktreeHint', { base: baseRef })));
  }

  function renderReviewThreadCard(thread) {
    const commentHref = safeUrl(thread.htmlUrl);
    return h('article', { class: 'cp-card pr-diag-item pr-diag-review-thread' },
      h('div', { class: 'cp-card-head' },
        h('div', { class: 'cp-badges' },
          h('strong', { class: 'pr-diag-item-name' }, `@${thread.author}`),
          h('span', { class: 'cp-badge' }, thread.isBot ? 'BOT' : thread.authorAssociation),
          h('code', { class: 'cp-sha' }, `${thread.path}:${thread.line}`)),
        commentHref
          ? h('a', { class: 'cp-ext-link', href: commentHref, target: '_blank', rel: 'noopener noreferrer' }, t('prDiagOpenGithubBtn'), icon('external'))
          : null),
      thread.diffHunkTail
        ? h('pre', { class: 'pr-diag-diff-hunk' }, thread.diffHunkTail)
        : null,
      h('p', { class: 'cp-note-text' }, thread.body),
      thread.replyCount > 0 && thread.latestReplyBody
        ? h('p', { class: 'cp-meta pr-diag-reply' },
          t('prReviewLatestReply', {
            count: thread.replyCount,
            author: thread.latestReplyAuthor || thread.author,
            text: thread.latestReplyBody,
          }))
        : null);
  }

  function renderReviewSection(fb, hasCiSnap) {
    if (!fb) return null;
    const snap = fb.snapshot;
    const threads = Array.isArray(snap?.threads) ? snap.threads : [];
    const reviewersWithNotes = (snap?.reviewers ?? []).filter(
      (r) => r.state === 'CHANGES_REQUESTED' || (r.state === 'COMMENTED' && r.body),
    );
    const staleList = snap?.staleChangesRequestedReviewers ?? [];
    const hasContent =
      fb.reviewDecision !== 'none' ||
      threads.length > 0 ||
      reviewersWithNotes.length > 0 ||
      staleList.length > 0;
    if (!hasContent && !(snap?.ignoredUntrustedCount > 0)) return null;

    const revKey = prReviewDecisionKey(fb.reviewDecision);
    const triage = fb.effectiveTriage;
    const skipKey = !hasCiSnap ? prDiagnosisSkipKey(fb.triageStatus) : null;

    return h('section', { class: 'cp-section pr-diag-reviews' },
      h('div', { class: 'cp-tabs-bar pr-diag-meta' },
        h('div', { class: 'cp-badges' },
          h('strong', { class: 'pr-diag-section-label' }, t('prReviewSectionTitle')),
          revKey
            ? h('span', { class: `cp-badge${fb.reviewDecision === 'changes_requested' ? ' warn' : fb.reviewDecision === 'approved' ? ' accent' : ''}` }, t(revKey))
            : null,
          fb.triageStatus !== 'none'
            ? h('span', { class: 'cp-badge' }, fb.triageStatus === 'ready' ? t('prDiagAiBadge') : t('prDiagDetBadge'))
            : null),
        snap?.ignoredUntrustedCount > 0
          ? h('span', { class: 'cp-meta' }, t('prReviewIgnoredUntrusted', { count: snap.ignoredUntrustedCount }))
          : null),
      staleList.length > 0
        ? h('p', { class: 'cp-meta pr-diag-note' }, t('prReviewAwaitingRereview', { reviewers: staleList.map((a) => `@${a}`).join(', ') }))
        : null,
      triage && (fb.reviewDecision === 'changes_requested' || fb.reviewDecision === 'commented')
        ? h('div', { class: 'cp-card pr-diag-summary' },
          h('p', { class: 'pr-diag-headline' }, triage.headline),
          Array.isArray(triage.actionItems) && triage.actionItems.length > 0
            ? h('ul', { class: 'pr-diag-causes' }, triage.actionItems.map((item) => h('li', null, item)))
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
      reviewersWithNotes.length > 0
        ? h('div', { class: 'cp-list' },
          reviewersWithNotes.map((rev) => {
            const revHref = safeUrl(rev.htmlUrl);
            return h('article', { class: 'cp-card pr-diag-item' },
              h('div', { class: 'cp-card-head' },
                h('div', { class: 'cp-badges' },
                  h('strong', { class: 'pr-diag-item-name' }, `@${rev.author}`),
                  h('span', { class: `cp-badge${rev.state === 'CHANGES_REQUESTED' ? ' warn' : ''}` }, rev.state),
                  !rev.onCurrentHead ? h('span', { class: 'cp-badge' }, t('prReviewPriorCommitBadge')) : null),
                revHref
                  ? h('a', { class: 'cp-ext-link', href: revHref, target: '_blank', rel: 'noopener noreferrer' }, t('prDiagOpenGithubBtn'), icon('external'))
                  : null),
              rev.body ? h('p', { class: 'cp-note-text' }, rev.body) : null);
          }))
        : null,
      threads.length > 0
        ? h('div', { class: 'cp-list' }, threads.map(renderReviewThreadCard))
        : null);
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
    const fb = data?.feedback;
    const watch = data?.watch;
    const prHref = safeUrl(watch?.url || state.prUrl);
    const conflictNode = renderConflictSection(fb);
    const reviewNode = renderReviewSection(fb, Boolean(snap));

    if (!snap && !conflictNode && !reviewNode) {
      return h('div', { class: 'cp-pane' },
        h('p', { class: 'cp-empty' }, t('prDiagEmptySnapshot')),
        prHref
          ? h('div', { class: 'cp-form-actions' },
            h('a', { class: 'cp-mini-btn cp-ext-link', href: prHref, target: '_blank', rel: 'noopener noreferrer' }, t('prDiagOpenGithubBtn'), icon('external')))
          : null);
    }

    const headSha = snap?.head || fb?.head || data?.head;
    const diag = data?.effectiveDiagnosis;
    const diagStatus = data?.diagnosisStatus;
    const skipKey = snap ? prDiagnosisSkipKey(diagStatus) : null;
    const targetThread = watch?.threadId || state.threadId;
    const actionPrompt = data?.actionPrompt || data?.repairPrompt;
    const dispatchLabelKey = prActionButtonKey(data?.actionKind);

    return h('div', { class: 'cp-pane pr-diag-pane' },
      h('div', { class: 'cp-tabs-bar pr-diag-meta' },
        h('div', { class: 'cp-badges' },
          headSha ? h('code', { class: 'cp-sha' }, headSha.slice(0, 12)) : null,
          watch?.watchGoal === 'merged' ? h('span', { class: 'cp-badge' }, t('prWatchGoalMerged')) : null,
          snap ? h('span', { class: 'cp-badge accent' }, t(prDiagnosisSourceKey(snap.logSource))) : null,
          snap && diag ? h('span', { class: 'cp-badge warn' }, t(prDiagnosisCategoryKey(diag.category))) : null,
          snap ? h('span', { class: 'cp-badge' }, diagStatus === 'ready' ? t('prDiagAiBadge') : t('prDiagDetBadge')) : null),
        prHref
          ? h('a', { class: 'cp-ext-link', href: prHref, target: '_blank', rel: 'noopener noreferrer' }, watch?.url || state.prUrl, icon('external'))
          : null),
      conflictNode,
      reviewNode,
      snap?.logNote ? h('p', { class: 'cp-meta pr-diag-note' }, prDiagnosisLogNoteText(snap.logNote)) : null,
      snap && diag
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
      snap
        ? h('section', { class: 'cp-section' },
          h('div', { class: 'cp-list' }, (snap.items ?? []).map(renderItemCard)))
        : null,
      h('div', { class: 'pr-diag-footer' },
        h('div', { class: 'cp-form-actions' },
          actionPrompt && targetThread
            ? h('button', {
              type: 'button',
              class: 'cp-primary-btn',
              onclick: () => {
                fillContinuation(targetThread, actionPrompt);
                toast(t('prDiagPrefilledToast'));
              },
            }, icon('chat'), ' ', t(dispatchLabelKey))
            : null,
          actionPrompt
            ? h('button', {
              type: 'button',
              class: 'cp-mini-btn',
              onclick: () => void copyText(actionPrompt),
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
      state.data?.feedback?.reviewCursor,
      state.data?.feedback?.mergeState,
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

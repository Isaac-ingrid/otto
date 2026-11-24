// Machine repository write policies, read-only Git worktree health audit, and two-tier
// owner-confirmed cleanup control plane (Direction E, Stage 3).
// Built strictly with h() and icon() from dom.js — zero HTML sinks, zero inline styles, zero auto-deletion.
import { h, icon } from './dom.js';
import { safeUrl } from './format.js';
import { t, tOr } from './i18n.js';
import { nextRovingItem } from './model.js';

export const WORKTREE_CATEGORIES = [
  'all',
  'orphaned',
  'stale_unmerged',
  'recent_unmerged',
  'idle_clean',
  'active',
];

export const WORKTREE_STALE_OPTIONS = [
  { days: 3, labelKey: 'wtStaleThreeDays' },
  { days: 7, labelKey: 'wtStaleWeek' },
  { days: 14, labelKey: 'wtStaleFortnight' },
  { days: 30, labelKey: 'wtStaleMonth' },
];

export const WORKTREE_ERROR_KEYS = {
  machine_offline: 'wtErr_machine_offline',
  unsupported: 'wtErr_unsupported',
  audit_timeout: 'wtErr_audit_timeout',
  cleanup_timeout: 'wtErr_cleanup_timeout',
  busy: 'wtErr_busy',
  worker_active: 'wtErr_worker_active',
  risk_confirmation_required: 'wtErr_risk_confirmation_required',
  invalid_stale_days: 'wtErr_failed',
};

export const WORKTREE_AUDIT_I18N_KEYS = [
  'wtCat_all',
  'wtCat_orphaned',
  'wtCat_stale_unmerged',
  'wtCat_recent_unmerged',
  'wtCat_idle_clean',
  'wtCat_active',
  'wtCat_external_unmanaged',
  'wtOrphan_untracked_dir',
  'wtOrphan_prunable_missing',
  'wtOrphan_thread_missing',
  'wtOrphan_thread_archived',
  'wtOutcome_blocked_dirty',
  'wtOutcome_blocked_unmerged',
  'wtOutcome_blocked_locked',
  'wtOutcome_worker_active',
  'wtOutcome_forbidden_path',
  'wtOutcome_branch_mismatch',
  'wtOutcome_not_registered_repo',
  'wtOutcome_hook_failed',
  'wtOutcome_failed',
  'wtStaleThreeDays',
  'wtStaleWeek',
  'wtStaleFortnight',
  'wtStaleMonth',
  ...Object.values(WORKTREE_ERROR_KEYS),
  'wtErr_failed',
];

export function worktreeErrorKey(code) {
  return (code && WORKTREE_ERROR_KEYS[code]) || 'wtErr_failed';
}

export function worktreeCategoryI18nKey(category) {
  if (
    category === 'orphaned' ||
    category === 'stale_unmerged' ||
    category === 'recent_unmerged' ||
    category === 'idle_clean' ||
    category === 'active' ||
    category === 'external_unmanaged'
  ) {
    return `wtCat_${category}`;
  }
  return 'wtCat_all';
}

/**
 * Formats byte counts into compact binary units (`0 B`, `12.4 KB`, `48.2 MB`, `1.35 GB`).
 * Prefixes `>= ` when `complete === false` so bounded directory scans never understate disk usage silently.
 */
export function formatDiskBytes(bytes, complete = true) {
  const n = typeof bytes === 'number' && Number.isFinite(bytes) && bytes > 0 ? Math.round(bytes) : 0;
  const prefix = complete === false && n > 0 ? '>= ' : '';
  if (n < 1024) return `${prefix}${n} B`;
  const kb = n / 1024;
  if (kb < 1024) {
    return `${prefix}${kb >= 100 ? Math.round(kb) : kb.toFixed(1).replace(/\.0$/, '')} KB`;
  }
  const mb = kb / 1024;
  if (mb < 1024) {
    return `${prefix}${mb >= 100 ? Math.round(mb) : mb.toFixed(1).replace(/\.0$/, '')} MB`;
  }
  const gb = mb / 1024;
  return `${prefix}${gb >= 10 ? gb.toFixed(1) : gb.toFixed(2).replace(/\.?0+$/, '')} GB`;
}

/**
 * Returns item keys eligible for 1-click safe selection: strictly `orphaned` or `idle_clean`
 * entries under Otto's managed worktree root with zero uncommitted edits and zero unmerged commits.
 */
export function selectSafeWorktreeKeys(items) {
  if (!Array.isArray(items)) return [];
  return items
    .filter((item) => Boolean(
      item &&
      item.selectable &&
      item.safeCleanable &&
      !item.highRisk &&
      !item.dirty &&
      !item.unmerged &&
      !item.requiresRiskConfirm,
    ))
    .map((item) => item.itemKey);
}

/**
 * Summarizes the owner's current checkbox selection and enforces the ADR-0022 safety gate:
 * if ANY selected worktree is `dirty` or `unmerged`, `canDirectBatchClean` is `false` and
 * `requiresRiskModal` is `true`.
 */
export function summarizeSelectedWorktrees(items, selectedKeys) {
  const list = Array.isArray(items) ? items : [];
  const selectedSet = selectedKeys instanceof Set ? selectedKeys : new Set(selectedKeys ?? []);
  const selectedItems = list.filter((item) => Boolean(item?.selectable && item?.cleanupTarget && selectedSet.has(item.itemKey)));
  const riskyItems = selectedItems.filter((item) => Boolean(
    item.highRisk || item.dirty || item.unmerged || item.requiresRiskConfirm,
  ));
  const safeItems = selectedItems.filter((item) => !riskyItems.includes(item));

  let totalBytes = 0;
  let diskComplete = true;
  const repoIdSet = new Set();
  for (const item of selectedItems) {
    totalBytes += typeof item.diskBytes === 'number' && item.diskBytes > 0 ? item.diskBytes : 0;
    if (item.diskComplete === false) diskComplete = false;
    if (item.repoId) repoIdSet.add(item.repoId);
  }

  const requiresRiskModal = riskyItems.length > 0;
  return {
    selectedItems,
    safeItems,
    riskyItems,
    totalCount: selectedItems.length,
    safeCount: safeItems.length,
    riskyCount: riskyItems.length,
    totalBytes,
    diskComplete,
    touchedRepoIds: [...repoIdSet],
    canDirectBatchClean: selectedItems.length > 0 && !requiresRiskModal,
    requiresRiskModal,
  };
}

/** Builds the POST `/worktrees/cleanup` JSON payload from a selection summary. */
export function buildWorktreeCleanupRequest(summary, confirmedRisks = false) {
  const targets = (summary?.selectedItems ?? []).map((item) => {
    const needsForce = Boolean(item.highRisk || item.dirty || item.unmerged || item.requiresRiskConfirm);
    return {
      ...item.cleanupTarget,
      ...(needsForce ? { force: true } : {}),
    };
  });
  const pruneRepoIds = summary?.touchedRepoIds ?? [];
  return {
    targets,
    ...(pruneRepoIds.length > 0 ? { pruneRepoIds } : {}),
    ...(confirmedRisks ? { confirmedRisks: true } : {}),
  };
}

export function createWorktreeAuditPane(deps) {
  const { request, uuid, toast, touch, refreshWorkspace, getMachines, openThread } = deps;

  const wt = {
    deviceId: '',
    staleDays: 7,
    category: 'all',
    repoId: '',
    status: 'idle',
    errorCode: null,
    data: null,
    selected: new Set(),
    riskModalOpen: false,
    riskAckChecked: false,
    busyKey: null,
    blockedOutcomes: [],
  };

  function availableMachines() {
    const raw = typeof getMachines === 'function' ? getMachines() : [];
    return Array.isArray(raw) ? raw.filter((m) => m && !m.revoked) : [];
  }

  function currentMachine() {
    const machines = availableMachines();
    if (!machines.length) return null;
    const hit = machines.find((m) => m.id === wt.deviceId);
    if (hit) return hit;
    const preferred = machines.find((m) => m.online) ?? machines[0];
    wt.deviceId = preferred ? preferred.id : '';
    return preferred ?? null;
  }

  function resetSelectionState() {
    wt.selected.clear();
    wt.riskModalOpen = false;
    wt.riskAckChecked = false;
  }

  async function loadAudit(targetDeviceId = wt.deviceId, staleDays = wt.staleDays) {
    wt.staleDays = staleDays;
    if (targetDeviceId) wt.deviceId = targetDeviceId;
    const machine = currentMachine();
    if (!machine) {
      wt.status = 'idle';
      wt.data = null;
      wt.errorCode = null;
      touch();
      return;
    }
    if (!machine.online) {
      wt.status = 'offline';
      wt.data = null;
      wt.errorCode = 'machine_offline';
      resetSelectionState();
      touch();
      return;
    }

    wt.status = 'loading';
    wt.errorCode = null;
    touch();
    try {
      const params = new URLSearchParams();
      params.set('staleDays', String(wt.staleDays));
      const { status, data } = await request(
        `/app/api/machines/${encodeURIComponent(machine.id)}/worktrees/audit?${params.toString()}`,
      );
      if (status === 200 && data && Array.isArray(data.items)) {
        wt.data = data;
        wt.status = 'ready';
        const validKeys = new Set(data.items.filter((i) => i.selectable).map((i) => i.itemKey));
        for (const key of [...wt.selected]) {
          if (!validKeys.has(key)) wt.selected.delete(key);
        }
        if (wt.repoId && !data.repos.some((r) => r.repoId === wt.repoId)) {
          wt.repoId = '';
        }
      } else if (status === 409 && data?.error === 'machine_offline') {
        wt.status = 'offline';
        wt.data = null;
        wt.errorCode = 'machine_offline';
        resetSelectionState();
      } else if (status !== 401) {
        wt.status = 'error';
        wt.errorCode = data?.error ?? 'io_failed';
      }
    } catch {
      wt.status = 'error';
      wt.errorCode = 'io_failed';
    }
    touch();
  }

  async function executeCleanup(payload, busyKey) {
    const machine = currentMachine();
    if (!machine || wt.busyKey) return;
    wt.busyKey = busyKey;
    wt.blockedOutcomes = [];
    touch();
    try {
      const { status, data } = await request(
        `/app/api/machines/${encodeURIComponent(machine.id)}/worktrees/cleanup`,
        { id: uuid(), ...payload },
      );
      if (status === 200 && data?.ok) {
        const outcomes = Array.isArray(data.items) ? data.items : [];
        const blocked = outcomes.filter((o) => o.status !== 'cleaned' && o.status !== 'already_gone');
        wt.blockedOutcomes = blocked;
        wt.riskModalOpen = false;
        wt.riskAckChecked = false;
        for (const o of outcomes) {
          if (o.status === 'cleaned' || o.status === 'already_gone') {
            if (o.workerId) wt.selected.delete(`worker:${o.workerId}`);
            wt.selected.delete(`wt:${o.repoId}:${o.worktreeKey}`);
          }
        }
        const freedLabel = formatDiskBytes(data.freedBytes ?? 0, true);
        if ((data.cleanedCount ?? 0) > 0) {
          toast(t('wtCleanSuccessToast', { count: data.cleanedCount, size: freedLabel }));
        } else if ((data.prunedRepoIds?.length ?? 0) > 0 && blocked.length === 0) {
          toast(t('wtPruneSuccessToast', { count: data.prunedRepoIds.length }));
        }
        await Promise.all([
          loadAudit(machine.id, wt.staleDays),
          typeof refreshWorkspace === 'function' ? refreshWorkspace() : Promise.resolve(),
        ]);
      } else if (status !== 401) {
        toast(t(worktreeErrorKey(data?.error)));
        if (data?.error === 'worker_active' || data?.error === 'machine_offline') {
          await loadAudit(machine.id, wt.staleDays);
        }
      }
    } catch {
      toast(t('wtErr_failed'));
    } finally {
      wt.busyKey = null;
      touch();
    }
  }

  function machineOptionLabel(m) {
    if (!m.online) return `${m.name} · ${t('offline')}`;
    const slotText = t('slots', { used: m.slots?.running ?? 0, total: m.slots?.max ?? 1 });
    return `${m.name} · ${slotText}`;
  }

  function renderToolbar(machines, machine) {
    const repos = wt.data?.repos ?? [];
    return h('div', { class: 'cp-toolbar wt-toolbar' },
      h('select', {
        class: 'cp-select',
        'aria-label': t('wtSelectMachine'),
        onchange: (e) => {
          wt.deviceId = e.target.value;
          wt.repoId = '';
          wt.blockedOutcomes = [];
          resetSelectionState();
          void loadAudit(wt.deviceId, wt.staleDays);
        },
      }, machines.map((m) =>
        h('option', { value: m.id, selected: m.id === machine?.id }, machineOptionLabel(m)))),
      h('div', {
        class: 'cp-pills',
        role: 'group',
        'aria-label': t('wtStaleThresholdLabel'),
        onkeydown: (e) => {
          if (!machine?.online || wt.busyKey) return;
          const nextDays = nextRovingItem(WORKTREE_STALE_OPTIONS.map((o) => o.days), wt.staleDays, e.key);
          if (nextDays == null) return;
          e.preventDefault();
          void loadAudit(machine?.id, nextDays);
          document.getElementById(`wt-stale-${nextDays}`)?.focus({ preventScroll: true });
        },
      },
        WORKTREE_STALE_OPTIONS.map((opt) =>
          h('button', {
            id: `wt-stale-${opt.days}`,
            type: 'button',
            dataset: { focus: `wt-stale:${opt.days}` },
            tabindex: wt.staleDays === opt.days ? '0' : '-1',
            'aria-pressed': String(wt.staleDays === opt.days),
            class: `cp-pill${wt.staleDays === opt.days ? ' active' : ''}`,
            disabled: !machine?.online || Boolean(wt.busyKey),
            onclick: () => {
              void loadAudit(machine?.id, opt.days);
              document.getElementById(`wt-stale-${opt.days}`)?.focus({ preventScroll: true });
            },
          }, t(opt.labelKey)))),
      repos.length > 1
        ? h('select', {
          class: 'cp-select',
          'aria-label': t('cpSkillsSelectRepo'),
          onchange: (e) => {
            wt.repoId = e.target.value;
            touch();
          },
        },
        h('option', { value: '', selected: wt.repoId === '' }, t('cpAllRepos')),
        repos.map((r) => h('option', { value: r.repoId, selected: wt.repoId === r.repoId }, r.name)))
        : null,
      h('button', {
        type: 'button',
        class: 'cp-mini-btn',
        disabled: !machine?.online || wt.status === 'loading' || Boolean(wt.busyKey),
        onclick: () => void loadAudit(machine?.id, wt.staleDays),
      }, t('wtRescanBtn')));
  }

  function renderRepoPolicyCard(repo, maxWorkers, online) {
    const isGit = repo.capabilityKind === 'git';
    const isolationKey = repo.writeIsolation === 'in-place' ? 'wtPolicyInPlace' : 'wtPolicyWorktree';
    const concurrencyText = repo.writeConcurrency === 'serial'
      ? t('wtPolicySerial')
      : t('wtPolicyParallel', { max: maxWorkers });
    const baseBranch = repo.defaultBranch || 'HEAD';
    const hasHooks = Boolean(repo.hasSetupHook || repo.hasArchiveHook);
    const hasLiveFootprint = typeof repo.managedWorktreeCount === 'number';
    const footprintLabel = hasLiveFootprint
      ? `${formatDiskBytes(repo.managedDiskBytes ?? 0, repo.diskComplete !== false)} · ${t('wtRepoWorktreeCount', { count: repo.managedWorktreeCount })}`
      : null;
    const prunableCount = repo.prunableCount ?? 0;
    const cliPath = repo.path || '<repo-path>';
    const cliHint = `otto repo-config ${cliPath} --isolation <worktree|in-place> --concurrency <parallel|serial>`;

    return h('article', { class: 'cp-card wt-repo-card' },
      h('div', { class: 'cp-card-head' },
        h('div', { class: 'cp-badges' },
          h('strong', { class: 'wt-repo-name' }, repo.name),
          isGit
            ? h('span', { class: 'cp-badge' }, t('wtPolicyBaseBranch', { branch: baseBranch }))
            : h('span', { class: 'cp-badge' }, t('cpSkillGit_plain')),
          isGit
            ? h('span', { class: `cp-badge${repo.writeIsolation === 'in-place' ? ' warn' : ' accent'}` }, t(isolationKey))
            : null,
          h('span', { class: 'cp-badge' }, concurrencyText),
          hasHooks
            ? h('span', { class: `cp-badge${repo.hooksApproved ? ' accent' : ' warn'}` },
              t(repo.hooksApproved ? 'wtPolicyHooksApproved' : 'wtPolicyHooksUnapproved'))
            : null,
          repo.projectApproved
            ? h('span', { class: 'cp-badge accent' }, t('wtPolicyPiApprovedBadge'))
            : null),
        footprintLabel ? h('span', { class: 'cp-meta' }, footprintLabel) : null),
      repo.path ? h('code', { class: 'wt-path-code' }, repo.path) : null,
      h('div', { class: 'wt-repo-foot' },
        h('span', { class: 'wt-cli-hint' }, t('wtPolicyCliHint'), ' ', h('code', null, cliHint)),
        online && prunableCount > 0
          ? h('button', {
            type: 'button',
            class: 'cp-mini-btn',
            disabled: Boolean(wt.busyKey),
            onclick: () => void executeCleanup({ targets: [], pruneRepoIds: [repo.repoId] }, `prune:${repo.repoId}`),
          }, t('wtPruneRepoBtn', { count: prunableCount }))
          : null));
  }

  function renderOfflineFallback(machine) {
    const cachedPolicies = Array.isArray(machine?.repoPolicies) ? machine.repoPolicies : [];
    const maxWorkers = machine?.slots?.max ?? 1;
    return [
      h('div', { class: 'cp-alert cp-pressure' },
        h('p', { class: 'cp-alert-title' }, icon('alert'), t('wtOfflineBanner'))),
      cachedPolicies.length > 0
        ? h('section', { class: 'cp-section' },
          h('h3', { class: 'cp-section-title' }, icon('folder'), t('wtRepoPoliciesHeading')),
          h('div', { class: 'wt-repo-grid' }, cachedPolicies.map((r) => renderRepoPolicyCard(r, maxWorkers, false))))
        : h('p', { class: 'cp-empty' }, t('wtNoReposOnMachine')),
    ];
  }

  function renderKpis(data) {
    const totals = data.totals;
    return h('div', { class: 'tm-kpi-grid wt-kpi-grid' },
      h('div', { class: 'cp-meter-card tm-kpi-card' },
        h('span', { class: 'tm-kpi-label' }, t('wtKpiFootprint')),
        h('strong', { class: 'tm-kpi-value' }, formatDiskBytes(totals.managedDiskBytes, totals.diskComplete)),
        h('small', { class: 'tm-kpi-sub' }, t('wtKpiManagedCount', { count: totals.managedCount }))),
      h('div', { class: 'cp-meter-card tm-kpi-card' },
        h('span', { class: 'tm-kpi-label' }, t('wtKpiSafeReclaim')),
        h('strong', { class: 'tm-kpi-value wt-tone-ok' }, formatDiskBytes(totals.safeReclaimableBytes, true)),
        h('small', { class: 'tm-kpi-sub' }, t('wtKpiSafeCount', { count: totals.safeReclaimableCount }))),
      h('div', { class: 'cp-meter-card tm-kpi-card' },
        h('span', { class: 'tm-kpi-label' }, t('wtKpiOrphaned')),
        h('strong', { class: `tm-kpi-value${totals.orphanedCount > 0 ? ' wt-tone-warn' : ''}` }, String(totals.orphanedCount)),
        h('small', { class: 'tm-kpi-sub' }, t('wtKpiPrunableSub', { count: totals.prunableCount }))),
      h('div', { class: 'cp-meter-card tm-kpi-card' },
        h('span', { class: 'tm-kpi-label' }, t('wtKpiUnmergedDirty')),
        h('strong', { class: `tm-kpi-value${(totals.staleUnmergedCount + totals.dirtyCount) > 0 ? ' wt-tone-warn' : ''}` },
          `${totals.staleUnmergedCount} / ${totals.dirtyCount}`),
        h('small', { class: 'tm-kpi-sub' }, t('wtKpiStaleDirtySub', { days: data.staleDays }))));
  }

  function renderBlockedBanner() {
    if (!wt.blockedOutcomes.length) return null;
    return h('div', { class: 'cp-alert wt-blocked-alert' },
      h('p', { class: 'cp-alert-title' }, icon('alert'), t('wtBlockedBannerTitle', { count: wt.blockedOutcomes.length })),
      h('ul', { class: 'wt-risk-list' }, wt.blockedOutcomes.map((o) => {
        const outcomeKey = `wtOutcome_${o.status}`;
        const label = o.branch || o.worktreeKey;
        return h('li', { class: 'wt-risk-row' },
          h('code', null, label),
          h('span', { class: 'cp-warn-text' }, tOr(outcomeKey, o.status)));
      })));
  }

  function renderRiskModal(summary) {
    if (!wt.riskModalOpen || !summary.requiresRiskModal) return null;
    const busy = Boolean(wt.busyKey);
    const totalSize = formatDiskBytes(summary.totalBytes, summary.diskComplete);

    return h('div', { class: 'cp-alert wt-risk-modal', role: 'alertdialog', 'aria-label': t('wtRiskModalTitle', { count: summary.riskyCount }) },
      h('p', { class: 'cp-alert-title wt-risk-title' },
        icon('alert'),
        t('wtRiskModalTitle', { count: summary.riskyCount })),
      h('p', { class: 'wt-risk-desc' }, t('wtRiskModalDesc')),
      h('ul', { class: 'wt-risk-list' }, summary.riskyItems.map((item) => {
        const branchLabel = item.branch || '(detached HEAD)';
        const baseLabel = item.baseBranch || 'HEAD';
        const statusParts = [];
        if (item.dirty) {
          statusParts.push(t('wtRiskItemDirty', {
            mod: item.modifiedCount ?? 0,
            untracked: item.untrackedCount ?? 0,
          }));
        }
        if (item.unmerged) {
          statusParts.push(t('wtRiskItemAhead', {
            ahead: item.ahead ?? 0,
            base: baseLabel,
          }));
        }
        return h('li', { class: 'wt-risk-item' },
          h('div', { class: 'wt-risk-item-top' },
            h('strong', null, `${item.repoName} · ${branchLabel}`),
            h('span', { class: 'cp-badges' },
              item.dirty ? h('span', { class: 'cp-badge danger' }, t('wtBadgeDirtyShort')) : null,
              item.unmerged ? h('span', { class: 'cp-badge warn' }, t('wtBadgeUnmergedShort', { count: item.ahead ?? 0 })) : null,
              h('span', { class: 'cp-badge' }, formatDiskBytes(item.diskBytes, item.diskComplete)))),
          h('code', { class: 'wt-path-code' }, item.path),
          statusParts.length > 0
            ? h('div', { class: 'wt-risk-item-meta' }, statusParts.join(' · '))
            : null);
      })),
      h('label', { class: 'cp-check-inline wt-risk-ack' },
        h('input', {
          type: 'checkbox',
          checked: wt.riskAckChecked,
          disabled: busy,
          onchange: (e) => {
            wt.riskAckChecked = e.target.checked;
            touch();
          },
        }),
        h('span', null, t('wtRiskAckLabel'))),
      h('div', { class: 'cp-form-actions' },
        h('button', {
          type: 'button',
          class: 'cp-action-btn danger wt-danger-solid',
          disabled: busy || !wt.riskAckChecked,
          onclick: () => void executeCleanup(buildWorktreeCleanupRequest(summary, true), 'cleanup'),
        }, busy ? t('worktreeCleaning') : t('wtConfirmForceCleanBtn', { count: summary.totalCount, size: totalSize })),
        h('button', {
          type: 'button',
          class: 'cp-mini-btn',
          disabled: busy,
          onclick: () => {
            wt.riskModalOpen = false;
            wt.riskAckChecked = false;
            touch();
          },
        }, t('cpCancelEdit'))));
  }

  function renderCategoryAndActionBar(data, filteredItems, summary) {
    const totals = data.totals;
    const managedTotal = data.items.filter((i) => i.category !== 'external_unmanaged').length;
    const catCounts = {
      all: managedTotal,
      orphaned: totals.orphanedCount,
      stale_unmerged: totals.staleUnmergedCount,
      recent_unmerged: totals.recentUnmergedCount,
      idle_clean: totals.idleCleanCount,
      active: totals.activeCount,
    };
    const safeKeys = selectSafeWorktreeKeys(filteredItems);
    const busy = Boolean(wt.busyKey);
    const selectedSizeLabel = formatDiskBytes(summary.totalBytes, summary.diskComplete);

    return h('div', { class: 'wt-controls-stack' },
      h('div', { class: 'cp-toolbar wt-filter-bar' },
        h('div', {
          class: 'cp-pills',
          role: 'group',
          onkeydown: (e) => {
            const cats = totals.externalCount > 0 ? [...WORKTREE_CATEGORIES, 'external_unmanaged'] : WORKTREE_CATEGORIES;
            const nextCat = nextRovingItem(cats, wt.category, e.key);
            if (!nextCat) return;
            e.preventDefault();
            wt.category = nextCat;
            touch();
            document.getElementById(`wt-cat-${nextCat}`)?.focus({ preventScroll: true });
          },
        },
          WORKTREE_CATEGORIES.map((cat) => {
            const label = `${t(worktreeCategoryI18nKey(cat))} (${catCounts[cat] ?? 0})`;
            return h('button', {
              id: `wt-cat-${cat}`,
              type: 'button',
              dataset: { focus: `wt-cat:${cat}` },
              tabindex: wt.category === cat ? '0' : '-1',
              'aria-pressed': String(wt.category === cat),
              class: `cp-pill${wt.category === cat ? ' active' : ''}`,
              onclick: () => {
                wt.category = cat;
                touch();
                document.getElementById(`wt-cat-${cat}`)?.focus({ preventScroll: true });
              },
            }, label);
          }),
          totals.externalCount > 0
            ? h('button', {
              id: 'wt-cat-external_unmanaged',
              type: 'button',
              dataset: { focus: 'wt-cat:external_unmanaged' },
              tabindex: wt.category === 'external_unmanaged' ? '0' : '-1',
              'aria-pressed': String(wt.category === 'external_unmanaged'),
              class: `cp-pill${wt.category === 'external_unmanaged' ? ' active' : ''}`,
              onclick: () => {
                wt.category = 'external_unmanaged';
                touch();
                document.getElementById('wt-cat-external_unmanaged')?.focus({ preventScroll: true });
              },
            }, `${t('wtCat_external_unmanaged')} (${totals.externalCount})`)
            : null)),
      h('div', { class: 'wt-action-bar' },
        h('div', { class: 'wt-select-btns' },
          h('button', {
            type: 'button',
            class: 'cp-mini-btn',
            disabled: busy || safeKeys.length === 0,
            onclick: () => {
              wt.selected = new Set(safeKeys);
              wt.riskModalOpen = false;
              wt.riskAckChecked = false;
              touch();
            },
          }, t('wtSelectSafeBtn', { count: safeKeys.length })),
          summary.totalCount > 0
            ? h('button', {
              type: 'button',
              class: 'cp-mini-btn',
              disabled: busy,
              onclick: () => {
                resetSelectionState();
                touch();
              },
            }, t('wtClearSelectionBtn', { count: summary.totalCount }))
            : null),
        h('div', { class: 'wt-clean-btns' },
          summary.requiresRiskModal
            ? [
              h('span', { class: 'wt-bulk-guard-note' }, icon('shield'), t('wtBulkBlockedHint')),
              h('button', {
                type: 'button',
                class: 'cp-action-btn danger wt-review-risk-btn',
                disabled: busy,
                onclick: () => {
                  wt.riskModalOpen = true;
                  wt.riskAckChecked = false;
                  touch();
                },
              }, t('wtOpenRiskModalBtn', { count: summary.riskyCount })),
            ]
            : h('button', {
              type: 'button',
              class: 'cp-primary-btn',
              disabled: busy || !summary.canDirectBatchClean,
              onclick: () => void executeCleanup(buildWorktreeCleanupRequest(summary, false), 'cleanup'),
            }, busy
              ? t('worktreeCleaning')
              : summary.totalCount > 0
                ? t('wtCleanSafeBtn', { count: summary.totalCount, size: selectedSizeLabel })
                : t('wtCleanNoneSelectedBtn')))));
  }

  function renderWorktreeItem(item) {
    const checked = wt.selected.has(item.itemKey);
    const busy = Boolean(wt.busyKey);
    const branchLabel = item.branch || '(detached HEAD)';
    const baseLabel = item.baseBranch || 'HEAD';
    const prHref = item.prUrl ? safeUrl(item.prUrl) : null;
    const threadLabel = item.threadTitle || item.threadId || '';

    let catTone = '';
    if (item.category === 'active' || item.category === 'idle_clean') catTone = ' accent';
    else if (item.category === 'orphaned' || item.category === 'stale_unmerged' || item.category === 'recent_unmerged') catTone = ' warn';

    const orphanReasonKey = item.orphanReason ? `wtOrphan_${item.orphanReason}` : null;

    return h('article', {
      class: `cp-card wt-item-card${checked ? ' is-selected' : ''}${!item.selectable ? ' muted' : ''}`,
    },
    h('div', { class: 'wt-item-top' },
      h('label', { class: 'wt-item-check' },
        h('input', {
          type: 'checkbox',
          checked,
          disabled: busy || !item.selectable,
          onchange: (e) => {
            if (e.target.checked) wt.selected.add(item.itemKey);
            else wt.selected.delete(item.itemKey);
            wt.riskModalOpen = false;
            wt.riskAckChecked = false;
            touch();
          },
        }),
        h('strong', { class: 'wt-item-branch' }, `${item.repoName} · ${branchLabel}`)),
      h('span', { class: 'cp-meta' },
        item.existsOnDisk
          ? formatDiskBytes(item.diskBytes, item.diskComplete)
          : t('wtMissingOnDisk'),
        item.ageDays !== null ? ` · ${t('wtAgeDays', { days: item.ageDays })}` : '')),
    h('div', { class: 'cp-badges wt-item-badges' },
      h('span', { class: `cp-badge${catTone}` }, t(worktreeCategoryI18nKey(item.category))),
      orphanReasonKey ? h('span', { class: 'cp-badge' }, tOr(orphanReasonKey, item.orphanReason)) : null,
      item.dirty
        ? h('span', { class: 'cp-badge danger' }, t('wtRiskItemDirty', {
          mod: item.modifiedCount ?? 0,
          untracked: item.untrackedCount ?? 0,
        }))
        : null,
      item.unmerged
        ? h('span', { class: 'cp-badge warn' }, t('wtRiskItemAhead', {
          ahead: item.ahead ?? 0,
          base: baseLabel,
        }))
        : item.mergedIntoBase && item.branch
          ? h('span', { class: 'cp-badge accent' }, t('wtBadgeMerged', { base: baseLabel }))
          : null,
      item.pushed ? h('span', { class: 'cp-badge' }, t('gitPushed')) : null,
      item.locked ? h('span', { class: 'cp-badge warn' }, t('wtBadgeLocked')) : null,
      item.category === 'active' ? h('span', { class: 'cp-badge accent' }, t('wtActiveProtectedBadge')) : null,
      !item.managedByOtto ? h('span', { class: 'cp-badge' }, t('wtExternalReadonlyBadge')) : null),
    h('code', { class: 'wt-path-code' }, item.path),
    (item.threadId || prHref)
      ? h('div', { class: 'cp-card-actions' },
        item.threadId && openThread
          ? h('button', {
            type: 'button',
            class: 'cp-thread-link',
            onclick: () => openThread(item.threadId, Boolean(item.threadArchived)),
          }, icon('layers'), t('cpOpenThread', { title: threadLabel }))
          : null,
        prHref
          ? h('a', {
            class: 'cp-ext-link',
            href: prHref,
            target: '_blank',
            rel: 'noopener noreferrer',
          }, item.prUrl, icon('external'))
          : null)
      : null);
  }

  return {
    open(target = null) {
      if (target?.deviceId) {
        wt.deviceId = target.deviceId;
        wt.repoId = target.repoId ?? '';
      }
      wt.blockedOutcomes = [];
      resetSelectionState();
      void loadAudit(wt.deviceId, wt.staleDays);
    },
    ensureLoaded() {
      if (wt.status === 'idle') void loadAudit(wt.deviceId, wt.staleDays);
    },
    reload() {
      void loadAudit(wt.deviceId, wt.staleDays);
    },
    render() {
      const machines = availableMachines();
      if (!machines.length) {
        return h('div', { class: 'cp-pane wt-pane' },
          h('p', { class: 'cp-empty' }, t('noMachines')));
      }
      const machine = currentMachine();
      const data = wt.data;

      let bodyNodes;
      if (!machine?.online || wt.status === 'offline') {
        bodyNodes = renderOfflineFallback(machine);
      } else if (wt.status === 'loading' && !data) {
        bodyNodes = h('p', { class: 'cp-empty' }, t('wtLoadingScan'));
      } else if (wt.status === 'error' && !data) {
        bodyNodes = [
          h('p', { class: 'cp-error' }, t(worktreeErrorKey(wt.errorCode))),
          renderOfflineFallback(machine)[1],
        ];
      } else if (!data) {
        bodyNodes = h('p', { class: 'cp-empty' }, t('wtLoadingScan'));
      } else {
        const filteredRepos = wt.repoId
          ? data.repos.filter((r) => r.repoId === wt.repoId)
          : data.repos;
        const filteredItems = data.items.filter((item) => {
          if (wt.repoId && item.repoId !== wt.repoId) return false;
          if (wt.category === 'all') return item.category !== 'external_unmanaged';
          return item.category === wt.category;
        });
        const summary = summarizeSelectedWorktrees(data.items, wt.selected);

        bodyNodes = [
          renderKpis(data),
          renderBlockedBanner(),
          filteredRepos.length > 0
            ? h('section', { class: 'cp-section' },
              h('h3', { class: 'cp-section-title' }, icon('folder'), t('wtRepoPoliciesHeading')),
              h('div', { class: 'wt-repo-grid' },
                filteredRepos.map((r) => renderRepoPolicyCard(r, data.maxWorkers, true))))
            : null,
          h('section', { class: 'cp-section' },
            h('h3', { class: 'cp-section-title' }, icon('branch'), t('wtWorktreeListHeading')),
            renderCategoryAndActionBar(data, filteredItems, summary),
            renderRiskModal(summary),
            filteredItems.length === 0
              ? h('p', { class: 'cp-empty' }, t('wtEmptyWorktrees'))
              : h('div', { class: 'cp-list' }, filteredItems.map(renderWorktreeItem)),
            data.truncated ? h('p', { class: 'cp-empty' }, t('wtTruncatedHint')) : null),
          h('p', { class: 'wt-safety-footnote' }, icon('shield'), t('wtSafetyFootnote')),
        ];
      }

      return h('div', { class: 'cp-pane wt-pane' },
        renderToolbar(machines, machine),
        bodyNodes);
    },
    isRiskModalOpen() {
      return Boolean(wt.riskModalOpen);
    },
    dismissRiskModal() {
      if (!wt.riskModalOpen || wt.busyKey) return false;
      wt.riskModalOpen = false;
      wt.riskAckChecked = false;
      touch();
      return true;
    },
  };
}

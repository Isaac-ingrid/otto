// Memory, Proactive Schedules, PR Watch & Controlled Repository Skills owner control plane (2A + 2B).
// Built strictly with h() text nodes from dom.js — zero HTML sinks, zero inline styles, zero LLM calls.
import { h, icon } from './dom.js';
import { formatClock, formatDay, formatUsd, safeUrl } from './format.js';
import { localeTag, t, tOr } from './i18n.js';
import { TELEMETRY_I18N_KEYS, createTelemetryPane, renderSchedulesBudgetCard } from './telemetry.js';
import { WORKTREE_AUDIT_I18N_KEYS, createWorktreeAuditPane } from './worktree-audit.js';

export const SKILL_ERROR_KEYS = {
  invalid_slug: 'skErr_invalid_slug',
  secret_detected: 'skErr_secret_detected',
  symlink_forbidden: 'skErr_symlink_forbidden',
  already_exists: 'skErr_already_exists',
  sha256_conflict: 'skErr_sha256_conflict',
  machine_offline: 'skErr_machine_offline',
  unsupported: 'skErr_unsupported',
  no_worktree: 'skErr_no_worktree',
  too_large: 'skErr_too_large',
  skill_timeout: 'skErr_skill_timeout',
  busy: 'skErr_busy',
};

export function skillErrorKey(code) {
  return (code && SKILL_ERROR_KEYS[code]) || 'skErr_failed';
}

export function skillTargetI18nKey(target) {
  if (target === 'claude-skill') return 'cpSkillTarget_claude_skill';
  if (target === 'claude-command') return 'cpSkillTarget_claude_command';
  return 'cpSkillTarget_agents_skill';
}

export const CONTROL_PLANE_I18N_KEYS = [
  'cpLayer_active', 'cpLayer_resident', 'cpLayer_project', 'cpLayer_archive', 'cpLayer_all',
  'cpNoteKind_preference', 'cpNoteKind_convention', 'cpNoteKind_environment', 'cpNoteKind_fact',
  'cpSource_user_said', 'cpSource_connector', 'cpSource_worker_reported', 'cpSource_inferred',
  'cpCreatedBy_user', 'cpCreatedBy_steward',
  'cpSchedStatus_active', 'cpSchedStatus_paused', 'cpSchedStatus_done', 'cpSchedStatus_cancelled',
  'cpSchedStatus_open', 'cpSchedStatus_fired',
  'cpWatchStatus_active', 'cpWatchStatus_completed', 'cpWatchStatus_cancelled', 'cpWatchStatus_expired',
  'cpSkillTarget_agents_skill', 'cpSkillTarget_claude_skill', 'cpSkillTarget_claude_command',
  'cpSkillGit_clean', 'cpSkillGit_modified', 'cpSkillGit_untracked', 'cpSkillGit_plain',
  ...Object.values(SKILL_ERROR_KEYS),
  'skErr_failed',
  ...TELEMETRY_I18N_KEYS,
  ...WORKTREE_AUDIT_I18N_KEYS,
];

const LAYERS = ['active', 'resident', 'project', 'archive'];
const NOTE_KINDS = ['preference', 'convention', 'environment', 'fact'];
const SKILL_TARGETS = ['agents-skill', 'claude-skill', 'claude-command'];

export function controlPlaneCounts(summary) {
  const s = summary ?? {};
  const activeAuto = (s.activeRoutines ?? 0) + (s.openFollowups ?? 0) + (s.activePrWatches ?? 0);
  const attentionCount = (s.unconfirmedNotes ?? 0) + (s.pressureCount ?? 0);
  return {
    activeAuto,
    attentionCount,
    residentUsed: s.residentUsedChars ?? 0,
    residentCap: s.residentCapChars ?? 2400,
  };
}

const repoCompositeKey = (r) => `${r.deviceId ?? ''}::${r.id}`;

export function createControlPlane(deps) {
  const { request, uuid, toast, bump, refreshWorkspace, getMachines, openThread, openPrDiagnosis, prefillPrFix, serverNow } = deps;
  let searchTimer = null;

  const cp = {
    tab: 'memory',
    rev: 0,
    memory: {
      status: 'idle',
      notes: [],
      usage: null,
      repos: [],
      layer: 'active',
      repoId: '',
      q: '',
      formOpen: false,
      draftLayer: 'resident',
      draftRepoId: '',
      draftKind: 'preference',
      draftText: '',
      draftPinned: false,
      eviction: null,
      busyKey: null,
      focusNoteId: null,
    },
    schedules: {
      status: 'idle',
      routines: [],
      followups: [],
      prWatches: [],
      budget: null,
      showHistory: false,
      busyKey: null,
    },
    skills: {
      repoKey: '',
      pendingTarget: null,
      status: 'idle',
      errorCode: null,
      items: [],
      truncated: false,
      projectApproved: null,
      createOpen: false,
      newSlug: '',
      newTarget: 'agents-skill',
      newMarkdown: '',
      newConfirmOverwrite: false,
      formError: null,
      editor: null,
      confirmDeleteKey: null,
      busyKey: null,
    },
  };
  const touch = () => {
    cp.rev += 1;
    bump();
  };
  const telemetryPane = createTelemetryPane({ request, touch, openThread });
  const worktreePane = createWorktreeAuditPane({ request, uuid, toast, touch, refreshWorkspace, getMachines, openThread });

  const formatStamp = (ts) => {
    if (!ts || !Number.isFinite(ts)) return '–';
    const day = formatDay(ts, serverNow(), localeTag(), { today: t('today'), yesterday: t('yesterday') });
    return `${day} ${formatClock(ts)}`;
  };

  function selectedSkillRepo() {
    const repos = cp.memory.repos;
    if (!repos.length) return null;
    return repos.find((r) => repoCompositeKey(r) === cp.skills.repoKey) ?? repos[0] ?? null;
  }

  function applyPendingSkillRepo() {
    const repos = cp.memory.repos;
    if (!repos.length) {
      cp.skills.repoKey = '';
      return;
    }
    const target = cp.skills.pendingTarget;
    if (target) {
      cp.skills.pendingTarget = null;
      const hit = repos.find((r) =>
        (target.deviceId && target.repoId && r.deviceId === target.deviceId && r.id === target.repoId) ||
        (target.deviceId && !target.repoId && r.deviceId === target.deviceId) ||
        (!target.deviceId && target.repoId && r.id === target.repoId));
      if (hit) {
        cp.skills.repoKey = repoCompositeKey(hit);
        return;
      }
    }
    if (!cp.skills.repoKey || !repos.some((r) => repoCompositeKey(r) === cp.skills.repoKey)) {
      const preferred = repos.find((r) => r.online) ?? repos[0];
      cp.skills.repoKey = preferred ? repoCompositeKey(preferred) : '';
    }
  }

  async function loadMemory() {
    cp.memory.status = 'loading';
    touch();
    try {
      const params = new URLSearchParams();
      params.set('layer', cp.memory.layer);
      if (cp.memory.repoId) params.set('repoId', cp.memory.repoId);
      if (cp.memory.q.trim()) params.set('q', cp.memory.q.trim());
      let { status, data } = await request(`/app/api/memory?${params.toString()}`);
      if (
        status === 200 &&
        data &&
        Array.isArray(data.notes) &&
        cp.memory.focusNoteId &&
        cp.memory.q.trim() &&
        !data.notes.some((n) => n.noteId === cp.memory.focusNoteId)
      ) {
        cp.memory.q = '';
        const fallback = new URLSearchParams();
        fallback.set('layer', cp.memory.layer);
        const retry = await request(`/app/api/memory?${fallback.toString()}`);
        if (retry.status === 200 && retry.data && Array.isArray(retry.data.notes)) {
          status = retry.status;
          data = retry.data;
        }
      }
      if (status === 200 && data && Array.isArray(data.notes)) {
        cp.memory.notes = data.notes;
        cp.memory.usage = data.usage ?? null;
        cp.memory.repos = Array.isArray(data.repos) ? data.repos : [];
        if (!cp.memory.draftRepoId && cp.memory.repos.length > 0) {
          cp.memory.draftRepoId = cp.memory.repos[0].id;
        }
        const prevRepoKey = cp.skills.repoKey;
        applyPendingSkillRepo();
        cp.memory.status = 'ready';
        if (cp.tab === 'skills' && (cp.skills.status === 'idle' || cp.skills.repoKey !== prevRepoKey)) {
          void loadRepoSkills();
        }
      } else if (status !== 401) {
        cp.memory.status = 'error';
      }
    } catch {
      cp.memory.status = 'error';
    }
    touch();
    if (cp.tab === 'memory' && cp.memory.focusNoteId && cp.memory.status === 'ready') {
      const targetNoteId = cp.memory.focusNoteId;
      cp.memory.focusNoteId = null;
      requestAnimationFrame(() => {
        const card = document.querySelector(`.cp-note-card[data-note-id="${CSS.escape(targetNoteId)}"]`);
        if (!card) return;
        card.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
        card.classList.remove('flash');
        void card.offsetWidth;
        card.classList.add('flash');
        setTimeout(() => card.classList.remove('flash'), 1800);
      });
    }
  }

  async function loadSchedules() {
    cp.schedules.status = 'loading';
    touch();
    try {
      const { status, data } = await request('/app/api/schedules');
      if (status === 200 && data) {
        cp.schedules.routines = Array.isArray(data.routines) ? data.routines : [];
        cp.schedules.followups = Array.isArray(data.followups) ? data.followups : [];
        cp.schedules.prWatches = Array.isArray(data.prWatches) ? data.prWatches : [];
        cp.schedules.budget = data.budget ?? null;
        cp.schedules.status = 'ready';
      } else if (status !== 401) {
        cp.schedules.status = 'error';
      }
    } catch {
      cp.schedules.status = 'error';
    }
    touch();
  }

  async function loadRepoSkills() {
    const repo = selectedSkillRepo();
    if (!repo || !repo.deviceId) {
      cp.skills.status = 'idle';
      cp.skills.items = [];
      touch();
      return;
    }
    cp.skills.repoKey = repoCompositeKey(repo);
    if (repo.online === false) {
      cp.skills.status = 'offline';
      cp.skills.items = [];
      cp.skills.errorCode = 'machine_offline';
      touch();
      return;
    }
    cp.skills.status = 'loading';
    cp.skills.errorCode = null;
    touch();
    try {
      const { status, data } = await request('/app/api/repos/skills/list', {
        deviceId: repo.deviceId,
        scope: { kind: 'repo', repoId: repo.id },
      });
      if (status === 200 && data && Array.isArray(data.skills)) {
        cp.skills.items = data.skills;
        cp.skills.truncated = Boolean(data.truncated);
        cp.skills.projectApproved = typeof data.projectApproved === 'boolean' ? data.projectApproved : null;
        cp.skills.status = 'ready';
      } else if (status === 409 && data?.error === 'machine_offline') {
        cp.skills.status = 'offline';
        cp.skills.errorCode = 'machine_offline';
      } else if (status !== 401) {
        cp.skills.status = 'error';
        cp.skills.errorCode = data?.error ?? 'io_failed';
      }
    } catch {
      cp.skills.status = 'error';
      cp.skills.errorCode = 'io_failed';
    }
    touch();
  }

  async function readRepoSkillContent(target, slug) {
    const repo = selectedSkillRepo();
    if (!repo?.deviceId) return null;
    const { status, data } = await request('/app/api/repos/skills/read', {
      deviceId: repo.deviceId,
      scope: { kind: 'repo', repoId: repo.id },
      target,
      slug,
    });
    if (status === 200 && data?.summary && typeof data.markdown === 'string') return data;
    if (status !== 401) toast(t(skillErrorKey(data?.error)));
    return null;
  }

  async function openSkillEditor(item) {
    if (cp.skills.busyKey) return;
    const key = `read:${item.target}:${item.slug}`;
    cp.skills.busyKey = key;
    cp.skills.confirmDeleteKey = null;
    touch();
    try {
      const detail = await readRepoSkillContent(item.target, item.slug);
      if (detail) {
        cp.skills.editor = {
          target: detail.summary.target,
          slug: detail.summary.slug,
          sha256: detail.summary.sha256,
          relativePath: detail.summary.relativePath,
          markdown: detail.markdown,
          conflict: false,
          errorCode: null,
        };
      }
    } finally {
      cp.skills.busyKey = null;
      touch();
    }
  }

  async function saveEditedSkill() {
    const ed = cp.skills.editor;
    const repo = selectedSkillRepo();
    if (!ed || !repo?.deviceId || cp.skills.busyKey) return;
    cp.skills.busyKey = `save:${ed.target}:${ed.slug}`;
    ed.errorCode = null;
    ed.conflict = false;
    touch();
    try {
      const { status, data } = await request('/app/api/repos/skills/write', {
        id: uuid(),
        deviceId: repo.deviceId,
        scope: { kind: 'repo', repoId: repo.id },
        target: ed.target,
        slug: ed.slug,
        markdown: ed.markdown,
        expectedSha256: ed.sha256,
      });
      if (status === 200 && data?.summary) {
        if (typeof data.projectApproved === 'boolean') cp.skills.projectApproved = data.projectApproved;
        cp.skills.editor = null;
        toast(t('cpSkillSavedToast', { path: data.summary.relativePath }));
        await loadRepoSkills();
      } else if (status === 409 && data?.error === 'sha256_conflict') {
        ed.conflict = true;
        ed.errorCode = 'sha256_conflict';
      } else if (status !== 401) {
        ed.errorCode = data?.error ?? 'io_failed';
      }
    } catch {
      ed.errorCode = 'io_failed';
    } finally {
      cp.skills.busyKey = null;
      touch();
    }
  }

  async function submitNewSkill() {
    const repo = selectedSkillRepo();
    if (!repo?.deviceId || cp.skills.busyKey) return;
    const slug = cp.skills.newSlug.trim().toLowerCase();
    const markdown = cp.skills.newMarkdown;
    if (!slug || !markdown.trim()) return;
    cp.skills.busyKey = 'create-skill';
    cp.skills.formError = null;
    touch();
    try {
      const { status, data } = await request('/app/api/repos/skills/write', {
        id: uuid(),
        deviceId: repo.deviceId,
        scope: { kind: 'repo', repoId: repo.id },
        target: cp.skills.newTarget,
        slug,
        markdown,
        ...(cp.skills.newConfirmOverwrite ? { overwrite: true } : {}),
      });
      if (status === 200 && data?.summary) {
        if (typeof data.projectApproved === 'boolean') cp.skills.projectApproved = data.projectApproved;
        cp.skills.createOpen = false;
        cp.skills.newSlug = '';
        cp.skills.newMarkdown = '';
        cp.skills.newConfirmOverwrite = false;
        cp.skills.formError = null;
        toast(t('cpSkillSavedToast', { path: data.summary.relativePath }));
        await loadRepoSkills();
      } else if (status === 409 && data?.error === 'already_exists') {
        cp.skills.newConfirmOverwrite = true;
        cp.skills.formError = 'already_exists';
      } else if (status !== 401) {
        cp.skills.formError = data?.error ?? 'io_failed';
      }
    } catch {
      cp.skills.formError = 'io_failed';
    } finally {
      cp.skills.busyKey = null;
      touch();
    }
  }

  async function deleteRepoSkill(item) {
    const repo = selectedSkillRepo();
    if (!repo?.deviceId || cp.skills.busyKey) return;
    cp.skills.busyKey = `del:${item.target}:${item.slug}`;
    touch();
    try {
      const { status, data } = await request('/app/api/repos/skills/delete', {
        id: uuid(),
        deviceId: repo.deviceId,
        scope: { kind: 'repo', repoId: repo.id },
        target: item.target,
        slug: item.slug,
        expectedSha256: item.sha256,
      });
      if (status === 200 && data?.deleted) {
        cp.skills.confirmDeleteKey = null;
        if (cp.skills.editor?.target === item.target && cp.skills.editor?.slug === item.slug) {
          cp.skills.editor = null;
        }
        toast(t('cpSkillDeletedToast', { path: data.relativePath || item.relativePath }));
        await loadRepoSkills();
      } else if (status !== 401) {
        toast(t(skillErrorKey(data?.error)));
        if (data?.error === 'sha256_conflict') await loadRepoSkills();
      }
    } catch {
      toast(t('skErr_failed'));
    } finally {
      cp.skills.busyKey = null;
      touch();
    }
  }

  async function copyOrDownloadSkill(item, mode) {
    if (cp.skills.busyKey) return;
    let markdown = cp.skills.editor?.target === item.target && cp.skills.editor?.slug === item.slug
      ? cp.skills.editor.markdown
      : null;
    if (markdown === null) {
      cp.skills.busyKey = `${mode}:${item.target}:${item.slug}`;
      touch();
      try {
        const detail = await readRepoSkillContent(item.target, item.slug);
        markdown = detail?.markdown ?? null;
      } finally {
        cp.skills.busyKey = null;
        touch();
      }
    }
    if (markdown === null) return;
    if (mode === 'copy') {
      try {
        await navigator.clipboard.writeText(markdown);
        toast(t('ckCopied'));
      } catch {
        toast(t('ckCopyFailed'));
      }
      return;
    }
    const filename = item.target === 'claude-command' ? `${item.slug}.md` : `${item.slug}-SKILL.md`;
    const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: filename });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function mutateMemory(payload, busyKey) {
    if (cp.memory.busyKey) return;
    cp.memory.busyKey = busyKey;
    touch();
    try {
      const { status, data } = await request('/app/api/memory', { id: uuid(), ...payload });
      if (status === 200) {
        cp.memory.eviction = null;
        if (payload.action === 'create') {
          cp.memory.draftText = '';
          cp.memory.draftPinned = false;
          cp.memory.formOpen = false;
        }
        await Promise.all([loadMemory(), refreshWorkspace()]);
      } else if (status === 409 && data?.error === 'capacity_exceeded') {
        const candidates = Array.isArray(data.needsEviction) ? data.needsEviction : [];
        const match = /(\d+)/.exec(String(data.message ?? ''));
        const needed = match ? Number(match[1]) : 1;
        cp.memory.eviction = {
          basePayload: { ...payload, evicts: undefined },
          needed,
          candidates,
          selected: new Set(candidates.map((c) => c.noteId)),
        };
      } else if (status !== 401) {
        toast(typeof data?.message === 'string' ? data.message : t('cpActionFailed'));
      }
    } catch {
      toast(t('cpActionFailed'));
    } finally {
      cp.memory.busyKey = null;
      touch();
    }
  }

  async function mutateSchedule(payload, busyKey) {
    if (cp.schedules.busyKey) return;
    cp.schedules.busyKey = busyKey;
    touch();
    try {
      const { status, data } = await request('/app/api/schedules', { id: uuid(), ...payload });
      if (status === 200) {
        await Promise.all([loadSchedules(), refreshWorkspace()]);
      } else if (status !== 401) {
        toast(typeof data?.message === 'string' ? data.message : t('cpActionFailed'));
      }
    } catch {
      toast(t('cpActionFailed'));
    } finally {
      cp.schedules.busyKey = null;
      touch();
    }
  }

  function repoLabel(repoId) {
    const found = cp.memory.repos.find((r) => r.id === repoId);
    return found ? (found.machine ? `${found.name} (${found.machine})` : found.name) : repoId;
  }

  function skillRepoOptionLabel(repo) {
    const base = repo.machine ? `${repo.name} (${repo.machine})` : repo.name;
    return repo.online === false ? `${base} · ${t('offline')}` : base;
  }

  function renderMeters() {
    const usage = cp.memory.usage;
    if (!usage) return null;
    const res = usage.resident;
    const items = [
      h('div', { class: 'cp-meter-card' },
        h('div', { class: 'cp-meter-head' },
          h('strong', null, t('cpResidentMeter')),
          h('span', null, t('cpMeterUsage', { used: res.usedChars, cap: res.capChars, pinned: res.pinnedCount }))),
        h('progress', { class: 'cp-meter', value: res.usedChars, max: res.capChars })),
      ...usage.projects.map((p) =>
        h('div', { class: 'cp-meter-card' },
          h('div', { class: 'cp-meter-head' },
            h('strong', null, t('cpProjectMeter', { repo: repoLabel(p.scopeRepoId) })),
            h('span', null, t('cpMeterUsage', { used: p.usedChars, cap: p.capChars, pinned: p.pinnedCount }))),
          h('progress', { class: 'cp-meter', value: p.usedChars, max: p.capChars }))),
    ];
    return h('div', { class: 'cp-meters' }, items);
  }

  function renderPressureBanner() {
    const list = cp.memory.usage?.pressure ?? [];
    if (!list.length) return null;
    return h('div', { class: 'cp-alert cp-pressure' },
      h('p', { class: 'cp-alert-title' }, icon('alert'), t('cpPressureBanner', { count: list.length })),
      h('ul', { class: 'cp-pressure-list' }, list.map((p) =>
        h('li', { class: 'cp-pressure-item' },
          h('span', { class: 'cp-pressure-text' }, p.text),
          h('button', {
            type: 'button',
            class: 'cp-mini-btn',
            disabled: Boolean(cp.memory.busyKey),
            onclick: () => void mutateMemory({ action: 'dismiss_pressure', pressureId: p.id }, `pressure:${p.id}`),
          }, t('cpDismiss'))))));
  }

  function renderEvictionPicker() {
    const ev = cp.memory.eviction;
    if (!ev) return null;
    const freed = ev.candidates.filter((c) => ev.selected.has(c.noteId)).reduce((s, c) => s + c.bytes, 0);
    return h('div', { class: 'cp-alert cp-evict-box' },
      h('p', { class: 'cp-alert-title' }, icon('alert'), t('cpEvictTitle', { freed, needed: ev.needed })),
      ev.candidates.length === 0
        ? h('p', { class: 'cp-empty' }, t('cpEvictNoCandidates'))
        : h('ul', { class: 'cp-evict-list' }, ev.candidates.map((c) =>
          h('li', null,
            h('label', { class: 'cp-check-row' },
              h('input', {
                type: 'checkbox',
                checked: ev.selected.has(c.noteId),
                onchange: (e) => {
                  if (e.target.checked) ev.selected.add(c.noteId);
                  else ev.selected.delete(c.noteId);
                  touch();
                },
              }),
              h('span', { class: 'cp-evict-text' }, c.text),
              h('code', null, t('cpCharsCount', { count: c.bytes })))))),
      h('div', { class: 'cp-form-actions' },
        ev.candidates.length > 0
          ? h('button', {
            type: 'button',
            class: 'cp-primary-btn',
            disabled: Boolean(cp.memory.busyKey) || freed < ev.needed,
            onclick: () => void mutateMemory({ ...ev.basePayload, evicts: [...ev.selected] }, 'evict-save'),
          }, t('cpEvictSubmit'))
          : null,
        h('button', {
          type: 'button',
          class: 'cp-mini-btn',
          onclick: () => { cp.memory.eviction = null; touch(); },
        }, t('cpCancelEdit'))));
  }

  function renderCreateForm() {
    if (!cp.memory.formOpen) return null;
    const isProject = cp.memory.draftLayer === 'project';
    const busy = Boolean(cp.memory.busyKey);
    return h('form', {
      class: 'cp-create-form',
      onsubmit: (e) => {
        e.preventDefault();
        const text = cp.memory.draftText.trim();
        if (!text) return;
        if (isProject && !cp.memory.draftRepoId) return;
        void mutateMemory({
          action: 'create',
          layer: cp.memory.draftLayer,
          ...(isProject ? { scopeRepoId: cp.memory.draftRepoId } : {}),
          kind: cp.memory.draftKind,
          text,
          pinned: cp.memory.draftPinned,
        }, 'create');
      },
    },
    h('div', { class: 'cp-form-grid' },
      h('select', {
        class: 'cp-select',
        onchange: (e) => {
          cp.memory.draftLayer = e.target.value;
          if (cp.memory.draftLayer === 'project' && !cp.memory.draftRepoId && cp.memory.repos[0]) {
            cp.memory.draftRepoId = cp.memory.repos[0].id;
          }
          touch();
        },
      }, ['resident', ...(cp.memory.repos.length ? ['project'] : [])].map((layer) =>
        h('option', { value: layer, selected: cp.memory.draftLayer === layer }, t(`cpLayer_${layer}`)))),
      isProject
        ? h('select', {
          class: 'cp-select',
          onchange: (e) => { cp.memory.draftRepoId = e.target.value; touch(); },
        }, cp.memory.repos.map((r) =>
          h('option', { value: r.id, selected: cp.memory.draftRepoId === r.id }, repoLabel(r.id))))
        : null,
      h('select', {
        class: 'cp-select',
        onchange: (e) => { cp.memory.draftKind = e.target.value; touch(); },
      }, NOTE_KINDS.map((k) =>
        h('option', { value: k, selected: cp.memory.draftKind === k }, t(`cpNoteKind_${k}`)))),
      h('label', { class: 'cp-check-inline' },
        h('input', {
          type: 'checkbox',
          checked: cp.memory.draftPinned,
          onchange: (e) => { cp.memory.draftPinned = e.target.checked; touch(); },
        }),
        h('span', null, t('cpPinOnCreate')))),
    h('textarea', {
      class: 'cp-textarea',
      rows: 3,
      maxlength: 2400,
      placeholder: t('cpNoteTextPlaceholder'),
      dataset: { focus: 'cp-note-text' },
      value: cp.memory.draftText,
      oninput: (e) => { cp.memory.draftText = e.target.value; },
    }, cp.memory.draftText),
    h('div', { class: 'cp-form-actions' },
      h('button', { type: 'submit', class: 'cp-primary-btn', disabled: busy }, busy && cp.memory.busyKey === 'create' ? t('cpSaving') : t('cpSaveNote')),
      h('button', { type: 'button', class: 'cp-mini-btn', onclick: () => { cp.memory.formOpen = false; cp.memory.eviction = null; touch(); } }, t('cpCancelEdit'))));
  }

  function noteCard(note) {
    const busy = Boolean(cp.memory.busyKey);
    const lowTrust = note.source === 'worker_reported' || note.source === 'inferred';
    const canConfirm = note.status === 'active' && lowTrust && !note.confirmed;
    const canPromote = note.status === 'active' && note.layer === 'project' && note.source !== 'connector';
    const canArchive = note.status === 'active' && (note.layer === 'resident' || note.layer === 'project') && !note.pinned;

    return h('article', { class: `cp-card cp-note-card${note.status === 'superseded' ? ' muted' : ''}`, dataset: { noteId: note.noteId } },
      h('div', { class: 'cp-card-head' },
        h('div', { class: 'cp-badges' },
          h('span', { class: `cp-badge layer-${note.layer}` },
            note.layer === 'project' && note.scopeRepoId ? `${t('cpLayer_project')} · ${repoLabel(note.scopeRepoId)}` : tOr(`cpLayer_${note.layer}`, note.layer)),
          h('span', { class: 'cp-badge' }, tOr(`cpNoteKind_${note.kind}`, note.kind)),
          h('span', { class: `cp-badge source-${note.source}` }, tOr(`cpSource_${note.source}`, note.source)),
          !note.confirmed && lowTrust ? h('span', { class: 'cp-badge warn' }, t('cpUnconfirmed')) : null,
          note.pinned ? h('span', { class: 'cp-badge accent' }, t('cpPinned')) : null,
          note.status === 'superseded' ? h('span', { class: 'cp-badge' }, t('cpSuperseded')) : null),
        h('span', { class: 'cp-meta' },
          note.useCount > 0 ? `${t('cpUseCount', { count: note.useCount })} · ` : '',
          t('cpCharsCount', { count: note.bytes }))),
      h('p', { class: 'cp-note-text' }, note.text),
      note.stale?.text ? h('p', { class: 'cp-stale-note' }, icon('alert'), note.stale.text) : null,
      h('div', { class: 'cp-card-actions' },
        canConfirm ? h('button', { type: 'button', class: 'cp-action-btn primary', disabled: busy, onclick: () => void mutateMemory({ action: 'confirm', noteId: note.noteId }, `confirm:${note.noteId}`) }, t('cpConfirm')) : null,
        note.status === 'active' ? h('button', { type: 'button', class: 'cp-action-btn', disabled: busy, onclick: () => void mutateMemory({ action: 'pin', noteId: note.noteId, pinned: !note.pinned }, `pin:${note.noteId}`) }, note.pinned ? t('cpUnpin') : t('cpPin')) : null,
        canPromote ? h('button', { type: 'button', class: 'cp-action-btn', disabled: busy, onclick: () => void mutateMemory({ action: 'promote', noteId: note.noteId }, `promote:${note.noteId}`) }, t('cpPromote')) : null,
        canArchive ? h('button', { type: 'button', class: 'cp-action-btn', disabled: busy, onclick: () => void mutateMemory({ action: 'archive', noteId: note.noteId }, `archive:${note.noteId}`) }, t('cpArchive')) : null,
        h('button', { type: 'button', class: 'cp-action-btn danger', disabled: busy, onclick: () => void mutateMemory({ action: 'remove', noteId: note.noteId }, `remove:${note.noteId}`) }, t('cpDelete'))));
  }

  function renderMemoryTab() {
    return h('div', { class: 'cp-pane' },
      renderMeters(),
      renderPressureBanner(),
      h('div', { class: 'cp-toolbar' },
        h('label', { class: 'cp-search' },
          icon('search'),
          h('input', {
            type: 'search',
            placeholder: t('cpSearchNotes'),
            value: cp.memory.q,
            dataset: { focus: 'cp-memory-search' },
            oninput: (e) => {
              cp.memory.q = e.target.value;
              clearTimeout(searchTimer);
              searchTimer = setTimeout(() => void loadMemory(), 260);
            },
          })),
        h('div', { class: 'cp-pills', role: 'group' }, LAYERS.map((layer) =>
          h('button', {
            type: 'button',
            class: `cp-pill${cp.memory.layer === layer ? ' active' : ''}`,
            onclick: () => { cp.memory.layer = layer; void loadMemory(); },
          }, t(`cpLayer_${layer}`)))),
        cp.memory.repos.length > 0
          ? h('select', {
            class: 'cp-select',
            onchange: (e) => { cp.memory.repoId = e.target.value; void loadMemory(); },
          },
          h('option', { value: '', selected: cp.memory.repoId === '' }, t('cpAllRepos')),
          cp.memory.repos.map((r) => h('option', { value: r.id, selected: cp.memory.repoId === r.id }, repoLabel(r.id))))
          : null,
        h('button', {
          type: 'button',
          class: 'cp-primary-btn',
          onclick: () => { cp.memory.formOpen = !cp.memory.formOpen; cp.memory.eviction = null; touch(); },
        }, icon('plus'), t('cpNewNote'))),
      renderCreateForm(),
      renderEvictionPicker(),
      cp.memory.status === 'loading' && cp.memory.notes.length === 0
        ? h('p', { class: 'cp-empty' }, t('cpLoading'))
        : cp.memory.status === 'error'
          ? h('p', { class: 'cp-error' }, t('cpLoadFailed'))
          : cp.memory.notes.length === 0
            ? h('p', { class: 'cp-empty' }, t('cpEmptyNotes'))
            : h('div', { class: 'cp-list' }, cp.memory.notes.map(noteCard)));
  }

  function threadLinkBtn(threadId, threadTitle) {
    if (!threadId) return null;
    return h('button', {
      type: 'button',
      class: 'cp-thread-link',
      onclick: () => openThread(threadId),
    }, icon('layers'), t('cpOpenThread', { title: threadTitle || threadId }));
  }

  function routineCard(r) {
    const busy = Boolean(cp.schedules.busyKey);
    const live = r.status === 'active' || r.status === 'paused';
    const skipped = typeof r.lastResult === 'string' && r.lastResult.startsWith('skipped:');
    return h('article', { class: `cp-card${live ? '' : ' muted'}` },
      h('div', { class: 'cp-card-head' },
        h('div', { class: 'cp-badges' },
          h('span', { class: `cp-badge status-${r.status}` }, tOr(`cpSchedStatus_${r.status}`, r.status)),
          h('span', { class: 'cp-badge' }, r.kind === 'digest' ? t('cpRoutineDigest') : t('cpRoutineInstruction')),
          r.repoName ? h('span', { class: 'cp-badge' }, r.repoName) : null),
        h('span', { class: 'cp-meta' },
          r.scheduleKind === 'cron' ? t('cpScheduleCron', { expr: r.cron ?? '' }) : t('cpScheduleOnce', { when: formatStamp(r.onceAt) }))),
      h('p', { class: 'cp-note-text' }, r.instruction),
      h('div', { class: 'cp-submeta' },
        r.nextRunAt ? h('span', null, t('cpNextRun', { when: formatStamp(r.nextRunAt) })) : null,
        r.lastResult ? h('span', { class: skipped ? 'cp-warn-text' : '' }, t('cpLastRun', { result: r.lastResult })) : null),
      h('div', { class: 'cp-card-actions' },
        threadLinkBtn(r.threadId, r.threadTitle),
        live ? h('button', {
          type: 'button',
          class: 'cp-action-btn',
          disabled: busy,
          onclick: () => void mutateSchedule({ action: 'pause_routine', routineId: r.routineId, paused: r.status === 'active' }, `pause:${r.routineId}`),
        }, r.status === 'active' ? t('cpPause') : t('cpResume')) : null,
        live ? h('button', {
          type: 'button',
          class: 'cp-action-btn danger',
          disabled: busy,
          onclick: () => void mutateSchedule({ action: 'cancel_routine', routineId: r.routineId }, `cancel:${r.routineId}`),
        }, t('cpCancelSchedule')) : null));
  }

  function followupCard(f) {
    const busy = Boolean(cp.schedules.busyKey);
    const open = f.status === 'open';
    return h('article', { class: `cp-card${open ? '' : ' muted'}` },
      h('div', { class: 'cp-card-head' },
        h('div', { class: 'cp-badges' },
          h('span', { class: `cp-badge status-${f.status}` }, tOr(`cpSchedStatus_${f.status}`, f.status)),
          h('span', { class: 'cp-badge' }, tOr(`cpCreatedBy_${f.createdBy}`, f.createdBy))),
        h('span', { class: 'cp-meta' }, t('cpDueAt', { when: formatStamp(f.dueAt) }))),
      h('p', { class: 'cp-note-text' }, f.reason),
      f.lastResult ? h('div', { class: 'cp-submeta' }, h('span', null, t('cpLastRun', { result: f.lastResult }))) : null,
      h('div', { class: 'cp-card-actions' },
        threadLinkBtn(f.threadId, f.threadTitle),
        open ? h('button', {
          type: 'button',
          class: 'cp-action-btn danger',
          disabled: busy,
          onclick: () => void mutateSchedule({ action: 'cancel_followup', followupId: f.followupId }, `cancel:${f.followupId}`),
        }, t('cpCancelSchedule')) : null));
  }

  function prWatchCard(w) {
    const busy = Boolean(cp.schedules.busyKey);
    const active = w.status === 'active';
    const href = safeUrl(w.url);
    const actionable = Boolean(w.hasActionableFeedback || w.hasFailureDetail);
    const headline = w.attentionHeadline || w.failureHeadline || t('prDiagFallbackHeadline');
    const viewLabel =
      w.hasFailureDetail && w.mergeState !== 'conflicted' && w.reviewDecision !== 'changes_requested'
        ? t('prDiagViewLogsBtn')
        : t('prDiagViewTriageBtn');
    return h('article', { class: `cp-card${active ? '' : ' muted'}` },
      h('div', { class: 'cp-card-head' },
        h('div', { class: 'cp-badges' },
          h('span', { class: `cp-badge status-${w.status}` }, tOr(`cpWatchStatus_${w.status}`, w.status)),
          h('span', { class: 'cp-badge' }, w.evidenceMode === 'statuses-only' ? t('cpWatchStatusesOnly') : t('cpWatchFullChecks')),
          w.watchGoal === 'merged' ? h('span', { class: 'cp-badge' }, t('prWatchGoalMerged')) : null,
          w.mergeState === 'conflicted' ? h('span', { class: 'cp-badge warn' }, t('prMergeConflictedBadge')) : null,
          w.reviewDecision === 'changes_requested' ? h('span', { class: 'cp-badge warn' }, t('prRev_changes_requested')) : null,
          w.reviewDecision === 'commented' ? h('span', { class: 'cp-badge' }, t('prRev_commented')) : null,
          w.reviewDecision === 'approved' ? h('span', { class: 'cp-badge accent' }, t('prRev_approved')) : null,
          w.head ? h('code', { class: 'cp-sha' }, w.head.slice(0, 7)) : null),
        active ? h('span', { class: 'cp-meta' }, t('cpWatchNextPoll', { when: formatStamp(w.nextCheckAt), expires: formatStamp(w.expiresAt) })) : null),
      h('p', { class: 'cp-note-text' },
        href ? h('a', { class: 'cp-ext-link', href, target: '_blank', rel: 'noopener noreferrer' }, w.url, icon('external')) : w.url),
      h('div', { class: 'cp-submeta' },
        h('span', null, t('cpWatchChecks', { total: w.checks ?? 0, failed: w.failed ?? 0, pending: w.pending ?? 0 })),
        w.lastError ? h('span', { class: 'cp-warn-text' }, w.lastError) : null),
      actionable
        ? h('div', { class: 'cp-failure-banner' },
          icon('alert'),
          h('span', null, headline))
        : null,
      h('div', { class: 'cp-card-actions' },
        threadLinkBtn(w.threadId, w.threadTitle),
        actionable && openPrDiagnosis
          ? h('button', {
            type: 'button',
            class: 'cp-action-btn',
            onclick: () => openPrDiagnosis(w.id, { head: w.head, threadId: w.threadId, url: w.url, fromControlPlane: true }),
          }, viewLabel)
          : null,
        actionable && prefillPrFix
          ? h('button', {
            type: 'button',
            class: 'cp-action-btn',
            onclick: () => void prefillPrFix(w.id, { head: w.head, threadId: w.threadId, url: w.url }),
          }, t('prDiagPrefillBtn'))
          : null,
        active ? h('button', {
          type: 'button',
          class: 'cp-action-btn danger',
          disabled: busy,
          onclick: () => void mutateSchedule({ action: 'cancel_pr_watch', watchId: w.id }, `cancel:${w.id}`),
        }, t('cpStopWatch')) : null));
  }

  function renderSchedulesTab() {
    if (cp.schedules.status === 'loading' && !cp.schedules.routines.length && !cp.schedules.followups.length && !cp.schedules.prWatches.length) {
      return h('div', { class: 'cp-pane' }, h('p', { class: 'cp-empty' }, t('cpLoading')));
    }
    if (cp.schedules.status === 'error') {
      return h('div', { class: 'cp-pane' }, h('p', { class: 'cp-error' }, t('cpLoadFailed')));
    }
    const showPast = cp.schedules.showHistory;
    const liveRoutines = cp.schedules.routines.filter((r) => r.status === 'active' || r.status === 'paused');
    const pastRoutines = cp.schedules.routines.filter((r) => r.status !== 'active' && r.status !== 'paused');
    const liveFollowups = cp.schedules.followups.filter((f) => f.status === 'open');
    const pastFollowups = cp.schedules.followups.filter((f) => f.status !== 'open');
    const liveWatches = cp.schedules.prWatches.filter((w) => w.status === 'active');
    const pastWatches = cp.schedules.prWatches.filter((w) => w.status !== 'active');
    const pastTotal = pastRoutines.length + pastFollowups.length + pastWatches.length;
    const routinesShown = showPast ? cp.schedules.routines : liveRoutines;
    const followupsShown = showPast ? cp.schedules.followups : liveFollowups;
    const watchesShown = showPast ? cp.schedules.prWatches : liveWatches;
    const lim = cp.schedules.budget;

    return h('div', { class: 'cp-pane' },
      renderSchedulesBudgetCard(lim, () => {
        cp.tab = 'telemetry';
        telemetryPane.ensureLoaded();
        touch();
      }),
      h('section', { class: 'cp-section' },
        h('h3', { class: 'cp-section-title' }, icon('repeat'), t('cpRoutinesHeading')),
        routinesShown.length ? h('div', { class: 'cp-list' }, routinesShown.map(routineCard)) : h('p', { class: 'cp-empty' }, t('cpEmptyRoutines'))),
      h('section', { class: 'cp-section' },
        h('h3', { class: 'cp-section-title' }, icon('clock'), t('cpFollowupsHeading')),
        followupsShown.length ? h('div', { class: 'cp-list' }, followupsShown.map(followupCard)) : h('p', { class: 'cp-empty' }, t('cpEmptyFollowups'))),
      h('section', { class: 'cp-section' },
        h('h3', { class: 'cp-section-title' }, icon('branch'), t('cpPrWatchesHeading')),
        watchesShown.length ? h('div', { class: 'cp-list' }, watchesShown.map(prWatchCard)) : h('p', { class: 'cp-empty' }, t('cpEmptyPrWatches'))),
      pastTotal > 0
        ? h('div', { class: 'cp-history-bar' },
          h('button', {
            type: 'button',
            class: 'cp-mini-btn',
            onclick: () => { cp.schedules.showHistory = !cp.schedules.showHistory; touch(); },
          }, showPast ? t('cpHideHistory') : t('cpShowHistory', { count: pastTotal })))
        : null);
  }

  function renderSkillCreateForm() {
    if (!cp.skills.createOpen) return null;
    const busy = Boolean(cp.skills.busyKey);
    return h('form', {
      class: 'cp-create-form',
      onsubmit: (e) => {
        e.preventDefault();
        void submitNewSkill();
      },
    },
    h('div', { class: 'cp-form-grid' },
      h('select', {
        class: 'cp-select',
        onchange: (e) => {
          cp.skills.newTarget = e.target.value;
          cp.skills.newConfirmOverwrite = false;
          cp.skills.formError = null;
          touch();
        },
      }, SKILL_TARGETS.map((target) =>
        h('option', { value: target, selected: cp.skills.newTarget === target }, t(skillTargetI18nKey(target))))),
      h('input', {
        type: 'text',
        class: 'cp-input',
        maxlength: 64,
        placeholder: t('cpSkillSlugPlaceholder'),
        'aria-label': t('cpSkillSlugLabel'),
        dataset: { focus: 'cp-new-skill-slug' },
        value: cp.skills.newSlug,
        oninput: (e) => {
          cp.skills.newSlug = e.target.value;
          if (cp.skills.newConfirmOverwrite || cp.skills.formError) {
            cp.skills.newConfirmOverwrite = false;
            cp.skills.formError = null;
            touch();
          }
        },
      })),
    h('textarea', {
      class: 'cp-textarea cp-code-textarea',
      rows: 9,
      placeholder: t('cpSkillMarkdownPlaceholder'),
      dataset: { focus: 'cp-new-skill-md' },
      value: cp.skills.newMarkdown,
      oninput: (e) => { cp.skills.newMarkdown = e.target.value; },
    }, cp.skills.newMarkdown),
    cp.skills.formError
      ? h('p', { class: cp.skills.newConfirmOverwrite ? 'cp-stale-note' : 'cp-error' }, t(skillErrorKey(cp.skills.formError)))
      : null,
    h('div', { class: 'cp-form-actions' },
      h('button', {
        type: 'submit',
        class: 'cp-primary-btn',
        disabled: busy,
      }, busy && cp.skills.busyKey === 'create-skill'
        ? t('ckWritingRepo')
        : cp.skills.newConfirmOverwrite
          ? t('ckOverwriteConfirmBtn')
          : t('cpSkillSave')),
      h('button', {
        type: 'button',
        class: 'cp-mini-btn',
        onclick: () => {
          cp.skills.createOpen = false;
          cp.skills.newConfirmOverwrite = false;
          cp.skills.formError = null;
          touch();
        },
      }, t('cpCancelEdit'))));
  }

  function skillCard(item) {
    const busy = Boolean(cp.skills.busyKey);
    const itemKey = `${item.target}:${item.slug}`;
    const editing = cp.skills.editor?.target === item.target && cp.skills.editor?.slug === item.slug
      ? cp.skills.editor
      : null;
    const confirmingDelete = cp.skills.confirmDeleteKey === itemKey;
    const gitBadgeTone = item.gitStatus === 'clean' ? ' accent' : (item.gitStatus === 'modified' || item.gitStatus === 'untracked') ? ' warn' : '';

    return h('article', { class: 'cp-card' },
      h('div', { class: 'cp-card-head' },
        h('div', { class: 'cp-badges' },
          h('span', { class: 'cp-badge' }, t(skillTargetI18nKey(item.target))),
          h('span', { class: `cp-badge${gitBadgeTone}` }, tOr(`cpSkillGit_${item.gitStatus}`, item.gitStatus)),
          h('code', { class: 'cp-skill-path' }, item.relativePath)),
        h('span', { class: 'cp-meta' }, `${formatStamp(item.updatedAt)} · ${item.bytes} B`)),
      h('p', { class: 'cp-note-text' }, h('strong', null, item.name), item.description ? ` — ${item.description}` : ''),
      editing
        ? h('div', { class: 'cp-create-form' },
          h('textarea', {
            class: 'cp-textarea cp-code-textarea',
            rows: 10,
            dataset: { focus: `cp-edit-skill:${itemKey}` },
            value: editing.markdown,
            oninput: (e) => { editing.markdown = e.target.value; },
          }, editing.markdown),
          editing.errorCode
            ? h('p', { class: 'cp-error' }, t(skillErrorKey(editing.errorCode)))
            : null,
          h('div', { class: 'cp-form-actions' },
            h('button', {
              type: 'button',
              class: 'cp-primary-btn',
              disabled: busy,
              onclick: () => void saveEditedSkill(),
            }, cp.skills.busyKey === `save:${itemKey}` ? t('cpSaving') : t('cpSkillSave')),
            editing.conflict
              ? h('button', {
                type: 'button',
                class: 'cp-mini-btn',
                disabled: busy,
                onclick: () => void openSkillEditor(item),
              }, t('cpSkillReload'))
              : null,
            h('button', {
              type: 'button',
              class: 'cp-mini-btn',
              disabled: busy,
              onclick: () => { cp.skills.editor = null; touch(); },
            }, t('cpCancelEdit'))))
        : null,
      h('div', { class: 'cp-card-actions' },
        !editing
          ? h('button', {
            type: 'button',
            class: 'cp-action-btn primary',
            disabled: busy,
            onclick: () => void openSkillEditor(item),
          }, t('cpSkillEdit'))
          : null,
        h('button', {
          type: 'button',
          class: 'cp-action-btn',
          disabled: busy,
          onclick: () => void copyOrDownloadSkill(item, 'download'),
        }, t('cpSkillDownload')),
        h('button', {
          type: 'button',
          class: 'cp-action-btn',
          disabled: busy,
          onclick: () => void copyOrDownloadSkill(item, 'copy'),
        }, t('cpSkillCopy')),
        confirmingDelete
          ? [
            h('button', {
              type: 'button',
              class: 'cp-action-btn danger',
              disabled: busy,
              onclick: () => void deleteRepoSkill(item),
            }, t('cpSkillDeleteConfirm')),
            h('button', {
              type: 'button',
              class: 'cp-action-btn',
              disabled: busy,
              onclick: () => { cp.skills.confirmDeleteKey = null; touch(); },
            }, t('cpCancelEdit')),
          ]
          : h('button', {
            type: 'button',
            class: 'cp-action-btn danger',
            disabled: busy,
            onclick: () => { cp.skills.confirmDeleteKey = itemKey; touch(); },
          }, t('cpDelete'))));
  }

  function renderSkillsTab() {
    const repos = cp.memory.repos;
    if (!repos.length) {
      return h('div', { class: 'cp-pane' },
        cp.memory.status === 'loading'
          ? h('p', { class: 'cp-empty' }, t('cpLoading'))
          : h('p', { class: 'cp-empty' }, t('cpSkillsNoRepos')));
    }
    const currentRepo = selectedSkillRepo();
    const online = currentRepo?.online !== false;
    return h('div', { class: 'cp-pane' },
      h('div', { class: 'cp-toolbar' },
        h('select', {
          class: 'cp-select',
          'aria-label': t('cpSkillsSelectRepo'),
          onchange: (e) => {
            cp.skills.repoKey = e.target.value;
            cp.skills.editor = null;
            cp.skills.confirmDeleteKey = null;
            cp.skills.createOpen = false;
            void loadRepoSkills();
          },
        }, repos.map((r) => {
          const key = repoCompositeKey(r);
          return h('option', { value: key, selected: cp.skills.repoKey === key }, skillRepoOptionLabel(r));
        })),
        h('button', {
          type: 'button',
          class: 'cp-primary-btn',
          disabled: !online,
          onclick: () => {
            cp.skills.createOpen = !cp.skills.createOpen;
            cp.skills.newConfirmOverwrite = false;
            cp.skills.formError = null;
            if (cp.skills.createOpen && !cp.skills.newMarkdown) {
              cp.skills.newMarkdown = t('cpSkillMarkdownPlaceholder');
            }
            touch();
          },
        }, icon('plus'), t('cpSkillsNewBtn'))),
      cp.skills.projectApproved === true
        ? h('p', { class: 'cp-trust-note ok' }, icon('check'), t('cpSkillsPiApproved'))
        : cp.skills.projectApproved === false
          ? h('p', { class: 'cp-trust-note' }, icon('shield'), t('cpSkillsPiUnapproved'))
          : null,
      renderSkillCreateForm(),
      cp.skills.status === 'offline' || !online
        ? h('div', { class: 'cp-alert cp-pressure' }, h('p', { class: 'cp-alert-title' }, icon('alert'), t('cpSkillsOfflineBanner')))
        : cp.skills.status === 'loading' && cp.skills.items.length === 0
          ? h('p', { class: 'cp-empty' }, t('cpLoading'))
          : cp.skills.status === 'error'
            ? h('p', { class: 'cp-error' }, t(skillErrorKey(cp.skills.errorCode)))
            : cp.skills.items.length === 0
              ? h('p', { class: 'cp-empty' }, t('cpSkillsEmpty'))
              : [
                h('div', { class: 'cp-list' }, cp.skills.items.map(skillCard)),
                cp.skills.truncated ? h('p', { class: 'cp-empty' }, t('cpSkillTruncated')) : null,
              ]);
  }

  return {
    open(initialTab = 'memory', initialTarget = null) {
      cp.tab = initialTab === 'schedules'
        ? 'schedules'
        : initialTab === 'skills'
          ? 'skills'
          : initialTab === 'telemetry'
            ? 'telemetry'
            : initialTab === 'worktrees'
              ? 'worktrees'
              : 'memory';
      cp.memory.eviction = null;
      cp.memory.focusNoteId = null;
      cp.skills.editor = null;
      cp.skills.confirmDeleteKey = null;
      if (cp.tab === 'memory' && initialTarget?.noteId) {
        cp.memory.layer = initialTarget.layer === 'archive' ? 'archive' : 'active';
        cp.memory.repoId = '';
        cp.memory.q = typeof initialTarget.q === 'string' ? initialTarget.q : '';
        cp.memory.focusNoteId = initialTarget.noteId;
      } else if (cp.tab === 'worktrees') {
        worktreePane.open(initialTarget);
      } else if (initialTarget) {
        cp.skills.pendingTarget = initialTarget;
        cp.skills.status = 'idle';
      }
      void loadMemory();
      void loadSchedules();
      if (cp.tab === 'telemetry') telemetryPane.open();
      if (cp.tab === 'skills' && cp.memory.repos.length > 0) {
        applyPendingSkillRepo();
        void loadRepoSkills();
      }
    },
    signature() {
      return [cp.tab, cp.rev];
    },
    render(summary) {
      const counts = controlPlaneCounts(summary);
      return h('div', { class: 'cp-root' },
        h('div', { class: 'cp-tabs-bar' },
          h('div', { class: 'cp-tabs', role: 'tablist' },
            h('button', {
              type: 'button',
              role: 'tab',
              'aria-selected': String(cp.tab === 'memory'),
              class: `cp-tab${cp.tab === 'memory' ? ' active' : ''}`,
              onclick: () => { cp.tab = 'memory'; touch(); },
            }, icon('memory'), t('cpTabMemory'), counts.attentionCount > 0 ? h('span', { class: 'cp-tab-badge warn' }, String(counts.attentionCount)) : null),
            h('button', {
              type: 'button',
              role: 'tab',
              'aria-selected': String(cp.tab === 'schedules'),
              class: `cp-tab${cp.tab === 'schedules' ? ' active' : ''}`,
              onclick: () => { cp.tab = 'schedules'; touch(); },
            }, icon('repeat'), t('cpTabSchedules'), counts.activeAuto > 0 ? h('span', { class: 'cp-tab-badge' }, String(counts.activeAuto)) : null),
            h('button', {
              type: 'button',
              role: 'tab',
              'aria-selected': String(cp.tab === 'telemetry'),
              class: `cp-tab${cp.tab === 'telemetry' ? ' active' : ''}`,
              onclick: () => {
                cp.tab = 'telemetry';
                telemetryPane.ensureLoaded();
                touch();
              },
            }, icon('signal'), t('cpTabTelemetry')),
            h('button', {
              type: 'button',
              role: 'tab',
              'aria-selected': String(cp.tab === 'skills'),
              class: `cp-tab${cp.tab === 'skills' ? ' active' : ''}`,
              onclick: () => {
                cp.tab = 'skills';
                if (cp.skills.status === 'idle') void loadRepoSkills();
                touch();
              },
            }, icon('sparkle'), t('cpTabSkills')),
            h('button', {
              type: 'button',
              role: 'tab',
              'aria-selected': String(cp.tab === 'worktrees'),
              class: `cp-tab${cp.tab === 'worktrees' ? ' active' : ''}`,
              onclick: () => {
                cp.tab = 'worktrees';
                worktreePane.ensureLoaded();
                touch();
              },
            }, icon('branch'), t('cpTabWorktrees'))),
          h('button', {
            type: 'button',
            class: 'cp-mini-btn',
            onclick: () => {
              void loadMemory();
              void loadSchedules();
              if (cp.tab === 'telemetry') telemetryPane.reload();
              if (cp.tab === 'skills') void loadRepoSkills();
              if (cp.tab === 'worktrees') worktreePane.reload();
            },
          }, t('cpRefresh'))),
        cp.tab === 'memory'
          ? renderMemoryTab()
          : cp.tab === 'schedules'
            ? renderSchedulesTab()
            : cp.tab === 'telemetry'
              ? telemetryPane.render()
              : cp.tab === 'worktrees'
                ? worktreePane.render()
                : renderSkillsTab());
    },
  };
}

// Worker Checkpoint, Trajectory Compaction & Skill/Memory Extraction UI (Direction 2B, Stage 3).
// Built strictly with h() text nodes from dom.js — zero HTML sinks, zero inline styles.
import { h, icon } from './dom.js';
import { skillErrorKey, skillTargetI18nKey } from './control-plane.js';
import { t, tOr } from './i18n.js';

const SKILL_TARGETS = ['agents-skill', 'claude-skill', 'claude-command'];

export function formatCheckpointPlainText(cp) {
  const lines = [];
  lines.push(`Worker: ${cp.workerId} (${cp.agent})`);
  lines.push(`Turns: ${cp.turnCount} · Tool calls: ${cp.toolCallCount}`);
  if (cp.initialGoal) lines.push(`Goal: ${cp.initialGoal}`);
  if (cp.lastStep) lines.push(`Stopped at: ${cp.lastStep.tool}${cp.lastStep.args ? ` ${cp.lastStep.args}` : ''}`);
  if (cp.git) {
    lines.push(`Git: ${cp.git.branch} (ahead ${cp.git.ahead}, dirty ${cp.git.dirty}, +${cp.git.insertions} -${cp.git.deletions})`);
  }
  if (cp.touchedFiles?.modified?.length) lines.push(`Modified: ${cp.touchedFiles.modified.join(', ')}`);
  if (cp.touchedFiles?.read?.length) lines.push(`Read: ${cp.touchedFiles.read.join(', ')}`);
  if (cp.commandsRun?.length) lines.push(`Commands:\n${cp.commandsRun.map((c) => `  - ${c}`).join('\n')}`);
  if (cp.recentNotes?.length) lines.push(`Recent reasoning:\n${cp.recentNotes.map((n) => `  > ${n}`).join('\n')}`);
  return lines.join('\n');
}

export function createCheckpointModal(deps) {
  const { request, uuid, toast, bump, fillContinuation, refreshWorkspace, openSkillCatalog } = deps;

  const state = {
    rev: 0,
    workerId: null,
    threadId: null,
    status: 'idle',
    checkpoint: null,
    distilling: null,
    distillNotice: null,
    distillErrorDetail: '',
    handoff: null,
    skillData: null,
    skillMarkdownDraft: '',
    skillSlugDraft: '',
    skillTarget: 'agents-skill',
    skillScopeKind: 'repo',
    skillWriting: false,
    skillConfirmOverwrite: false,
    skillWriteError: null,
    skillSavedResult: null,
    selectedNotes: new Set(),
    savingNotes: false,
    notesNotice: null,
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

  function downloadFile(filename, content) {
    const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: filename });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function loadCheckpoint(workerId) {
    state.status = 'loading';
    touch();
    try {
      const { status, data } = await request(`/app/api/workers/${encodeURIComponent(workerId)}/checkpoint`, {});
      if (status === 200 && data) {
        state.checkpoint = data;
        state.status = 'ready';
      } else if (status !== 401) {
        state.status = 'error';
      }
    } catch {
      state.status = 'error';
    }
    touch();
  }

  function scrollToDraft(elementId) {
    if (typeof requestAnimationFrame !== 'function') return;
    requestAnimationFrame(() => {
      document.getElementById(elementId)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  }

  async function runDistill(mode) {
    if (state.distilling || !state.workerId) return;
    state.distilling = mode;
    state.distillNotice = null;
    state.distillErrorDetail = '';
    touch();
    let scrollTarget = null;
    try {
      const { status, data } = await request(`/app/api/workers/${encodeURIComponent(state.workerId)}/distill`, {
        id: uuid(),
        mode,
      });
      if (status === 200 && data) {
        if (mode === 'handoff') {
          state.handoff = data;
          state.distillNotice = 'handoff_ok';
          scrollTarget = 'ck-handoff-box';
        } else {
          state.skillData = data;
          state.skillMarkdownDraft = data.skill?.markdown ?? '';
          state.skillSlugDraft = data.skill?.slug ?? 'extracted-workflow';
          state.skillTarget = 'agents-skill';
          state.skillScopeKind = data.hasWriteWorktree ? 'worktree' : 'repo';
          state.skillConfirmOverwrite = false;
          state.skillWriteError = null;
          state.skillSavedResult = null;
          state.notesNotice = null;
          state.selectedNotes = new Set((data.suggestedNotes ?? []).map((_, idx) => idx));
          state.distillNotice = 'skill_ok';
          scrollTarget = 'ck-skill-box';
        }
      } else if (status === 409 && data?.error === 'over_budget') {
        state.distillNotice = 'over_budget';
        toast(t('ckDistillOverLimit'));
      } else if (status !== 401) {
        state.distillNotice = 'failed';
        const detail = [data?.error, data?.reason].filter(Boolean).join(': ');
        state.distillErrorDetail = detail ? ` (${detail})` : '';
        toast(t('ckDistillFailed'));
      }
    } catch {
      state.distillNotice = 'failed';
      state.distillErrorDetail = '';
      toast(t('ckDistillFailed'));
    } finally {
      state.distilling = null;
      touch();
      if (scrollTarget) scrollToDraft(scrollTarget);
    }
  }

  async function writeSkillToRepo() {
    const sd = state.skillData;
    if (!sd?.deviceId || !sd?.repoId || state.skillWriting) return;
    const slug = state.skillSlugDraft.trim().toLowerCase();
    if (!slug || !state.skillMarkdownDraft.trim()) return;
    state.skillWriting = true;
    state.skillWriteError = null;
    touch();
    try {
      const scope = state.skillScopeKind === 'worktree' && sd.hasWriteWorktree && state.workerId
        ? { kind: 'worktree', repoId: sd.repoId, workerId: state.workerId }
        : { kind: 'repo', repoId: sd.repoId };
      const { status, data } = await request('/app/api/repos/skills/write', {
        id: uuid(),
        deviceId: sd.deviceId,
        scope,
        target: state.skillTarget,
        slug,
        markdown: state.skillMarkdownDraft,
        ...(state.skillConfirmOverwrite ? { overwrite: true } : {}),
      });
      if (status === 200 && data?.summary) {
        state.skillConfirmOverwrite = false;
        state.skillWriteError = null;
        state.skillSavedResult = data;
        toast(t('cpSkillSavedToast', { path: data.summary.relativePath }));
        if (refreshWorkspace) void refreshWorkspace();
      } else if (status === 409 && data?.error === 'already_exists') {
        state.skillConfirmOverwrite = true;
        state.skillWriteError = 'already_exists';
      } else if (status !== 401) {
        state.skillWriteError = data?.error ?? 'io_failed';
      }
    } catch {
      state.skillWriteError = 'io_failed';
    } finally {
      state.skillWriting = false;
      touch();
    }
  }

  async function saveSuggestedNotes() {
    const sd = state.skillData;
    if (!sd || state.savingNotes || state.selectedNotes.size === 0) return;
    state.savingNotes = true;
    state.notesNotice = null;
    touch();
    try {
      const items = (sd.suggestedNotes ?? []).filter((_, idx) => state.selectedNotes.has(idx));
      for (const item of items) {
        await request('/app/api/memory', {
          id: uuid(),
          action: 'create',
          layer: sd.repoId ? 'project' : 'resident',
          ...(sd.repoId ? { scopeRepoId: sd.repoId } : {}),
          kind: item.kind,
          text: item.text,
        });
      }
      state.selectedNotes.clear();
      state.notesNotice = 'saved';
      toast(t('ckNotesSaved'));
      await refreshWorkspace();
    } catch {
      state.notesNotice = 'failed';
      toast(t('cpActionFailed'));
    } finally {
      state.savingNotes = false;
      touch();
    }
  }

  function renderCheckpointSection(cp) {
    const mod = cp.touchedFiles?.modified ?? [];
    const read = cp.touchedFiles?.read ?? [];
    const cmds = cp.commandsRun ?? [];
    const notes = cp.recentNotes ?? [];
    const emptyTrace = !cp.lastStep && !mod.length && !read.length && !cmds.length && !notes.length;

    return h('div', { class: 'cp-section' },
      cp.offlineFallback
        ? h('div', { class: 'cp-alert cp-pressure' }, h('p', { class: 'cp-alert-title' }, icon('alert'), t('ckOfflineBanner')))
        : null,
      h('div', { class: 'cp-tabs-bar' },
        h('div', { class: 'cp-badges' },
          h('span', { class: 'cp-badge accent' }, cp.agent),
          h('span', { class: 'cp-badge' }, t('ckStats', { turns: cp.turnCount ?? 0, tools: cp.toolCallCount ?? 0 })),
          cp.git ? h('span', { class: `cp-badge${cp.git.dirty > 0 ? ' warn' : ''}` }, t('ckGitSummary', { branch: cp.git.branch, ahead: cp.git.ahead, dirty: cp.git.dirty })) : null),
        h('div', { class: 'cp-form-actions' },
          h('button', { type: 'button', class: 'cp-mini-btn', onclick: () => void copyText(formatCheckpointPlainText(cp)) }, t('ckCopySnapshot')),
          h('button', { type: 'button', class: 'cp-mini-btn', onclick: () => { if (state.workerId) void loadCheckpoint(state.workerId); } }, t('cpRefresh')))),
      cp.initialGoal
        ? h('div', { class: 'cp-card' }, h('span', { class: 'cp-meta' }, t('ckInitialGoal')), h('p', { class: 'cp-note-text' }, cp.initialGoal))
        : null,
      cp.lastStep
        ? h('div', { class: 'cp-card' },
          h('span', { class: 'cp-meta' }, t('ckStoppedStep')),
          h('p', { class: 'cp-note-text' }, h('code', { class: 'cp-sha' }, cp.lastStep.tool), cp.lastStep.args ? ` ${cp.lastStep.args}` : ''))
        : null,
      mod.length > 0
        ? h('div', { class: 'cp-card' },
          h('span', { class: 'cp-meta' }, t('ckModifiedFiles', { count: mod.length })),
          h('div', { class: 'cp-badges' }, mod.map((f) => h('code', { class: 'cp-badge accent' }, f))))
        : null,
      read.length > 0
        ? h('div', { class: 'cp-card' },
          h('span', { class: 'cp-meta' }, t('ckReadFiles', { count: read.length })),
          h('div', { class: 'cp-badges' }, read.map((f) => h('code', { class: 'cp-badge' }, f))))
        : null,
      cmds.length > 0
        ? h('div', { class: 'cp-card' },
          h('span', { class: 'cp-meta' }, t('ckCommandsRun', { count: cmds.length })),
          h('ul', { class: 'diff-commits' }, cmds.map((c) => h('li', null, h('code', null, '$'), c))))
        : null,
      notes.length > 0
        ? h('div', { class: 'cp-card' },
          h('span', { class: 'cp-meta' }, t('ckRecentNotes')),
          notes.map((n) => h('p', { class: 'cp-note-text' }, n)))
        : null,
      emptyTrace ? h('p', { class: 'cp-empty' }, t('ckNoTraceYet')) : null);
  }

  function renderBulletCard(labelKey, items) {
    if (!items?.length) return null;
    return h('div', { class: 'cp-card' },
      h('span', { class: 'cp-meta' }, t(labelKey)),
      h('ul', { class: 'cp-pressure-list' }, items.map((item) => h('li', { class: 'cp-note-text' }, `• ${item}`))));
  }

  function renderRepoWriteBox(sd) {
    if (!sd.deviceId || !sd.repoId) return null;
    const saved = state.skillSavedResult;
    return h('div', { class: 'cp-card' },
      h('span', { class: 'cp-meta' }, t('ckWriteSectionTitle'), sd.repoName ? ` · ${sd.repoName}` : ''),
      h('div', { class: 'cp-form-grid' },
        h('select', {
          class: 'cp-select',
          'aria-label': t('cpSkillSlotLabel'),
          onchange: (e) => {
            state.skillTarget = e.target.value;
            state.skillConfirmOverwrite = false;
            state.skillWriteError = null;
            touch();
          },
        }, SKILL_TARGETS.map((target) =>
          h('option', { value: target, selected: state.skillTarget === target }, t(skillTargetI18nKey(target))))),
        sd.hasWriteWorktree
          ? h('select', {
            class: 'cp-select',
            onchange: (e) => {
              state.skillScopeKind = e.target.value;
              state.skillConfirmOverwrite = false;
              state.skillWriteError = null;
              touch();
            },
          },
          h('option', { value: 'worktree', selected: state.skillScopeKind === 'worktree' }, t('ckScopeWorktree')),
          h('option', { value: 'repo', selected: state.skillScopeKind === 'repo' }, t('ckScopeRepo')))
          : h('span', { class: 'cp-badge' }, t('ckScopeRepo')),
        h('input', {
          type: 'text',
          class: 'cp-input',
          maxlength: 64,
          placeholder: t('cpSkillSlugPlaceholder'),
          'aria-label': t('cpSkillSlugLabel'),
          dataset: { focus: 'ck-skill-slug' },
          value: state.skillSlugDraft,
          oninput: (e) => {
            state.skillSlugDraft = e.target.value;
            if (state.skillConfirmOverwrite || state.skillWriteError) {
              state.skillConfirmOverwrite = false;
              state.skillWriteError = null;
              touch();
            }
          },
        })),
      state.skillWriteError
        ? h('p', { class: state.skillConfirmOverwrite ? 'cp-stale-note' : 'cp-error' }, t(skillErrorKey(state.skillWriteError)))
        : null,
      saved?.summary
        ? [
          h('p', { class: 'cp-trust-note ok' }, icon('check'), t('cpSkillSavedToast', { path: saved.summary.relativePath })),
          saved.projectApproved === false && state.skillTarget === 'agents-skill'
            ? h('p', { class: 'cp-trust-note' }, icon('shield'), t('cpSkillsPiUnapproved'))
            : null,
        ]
        : null,
      h('div', { class: 'cp-form-actions' },
        h('button', {
          type: 'button',
          class: 'cp-primary-btn',
          disabled: state.skillWriting,
          onclick: () => void writeSkillToRepo(),
        }, icon('folder'), state.skillWriting
          ? t('ckWritingRepo')
          : state.skillConfirmOverwrite
            ? t('ckOverwriteConfirmBtn')
            : t('ckWriteRepoBtn')),
        saved && openSkillCatalog
          ? h('button', {
            type: 'button',
            class: 'cp-mini-btn',
            onclick: () => openSkillCatalog(sd.deviceId, sd.repoId),
          }, t('ckOpenSkillCatalog'))
          : null));
  }

  function renderDistillNotice() {
    if (state.distilling) {
      return h('p', { class: 'cp-trust-note', role: 'status' }, icon('sparkle'), t('ckDistillingHint'));
    }
    if (state.distillNotice === 'skill_ok') {
      return h('p', { class: 'cp-trust-note ok', role: 'status' }, icon('check'), t('ckSkillDraftReady'));
    }
    if (state.distillNotice === 'handoff_ok') {
      return h('p', { class: 'cp-trust-note ok', role: 'status' }, icon('check'), t('ckHandoffReady'));
    }
    if (state.distillNotice === 'over_budget') {
      return h('p', { class: 'cp-error', role: 'alert' }, t('ckDistillOverLimit'));
    }
    if (state.distillNotice === 'failed') {
      return h('p', { class: 'cp-error', role: 'alert' }, `${t('ckDistillFailed')}${state.distillErrorDetail}`);
    }
    return null;
  }

  function renderDistillSection() {
    const busy = Boolean(state.distilling);
    const ho = state.handoff;
    const sd = state.skillData;
    const dlSlug = state.skillSlugDraft.trim() || sd?.skill?.slug || "extracted";
    return h('div', { class: 'cp-section' },
      h('h3', { class: 'cp-section-title' }, icon('sparkle'), t('ckDistillActions')),
      h('div', { class: 'cp-form-actions' },
        h('button', {
          type: 'button',
          class: 'cp-primary-btn',
          disabled: busy,
          onclick: () => void runDistill('handoff'),
        }, icon('layers'), state.distilling === 'handoff' ? t('ckDistilling') : t('ckDistillHandoffBtn')),
        h('button', {
          type: 'button',
          class: 'cp-mini-btn',
          disabled: busy,
          onclick: () => void runDistill('skill'),
        }, icon('memory'), state.distilling === 'skill' ? t('ckDistilling') : t('ckDistillSkillBtn'))),
      renderDistillNotice(),
      ho
        ? h('div', { id: 'ck-handoff-box', class: 'cp-create-form' },
          h('span', { class: 'cp-meta' }, t('ckHandoffSummary')),
          h('p', { class: 'cp-note-text' }, ho.summary),
          renderBulletCard('ckAccomplished', ho.accomplished),
          renderBulletCard('ckDeadEnds', ho.deadEnds),
          renderBulletCard('ckNextSteps', ho.nextSteps),
          h('div', { class: 'cp-form-actions' },
            ho.continuationPrompt && state.threadId
              ? h('button', {
                type: 'button',
                class: 'cp-primary-btn',
                onclick: () => fillContinuation(state.threadId, ho.continuationPrompt),
              }, t('ckFillComposer'))
              : null,
            ho.continuationPrompt
              ? h('button', {
                type: 'button',
                class: 'cp-mini-btn',
                onclick: () => void copyText(ho.continuationPrompt),
              }, t('ckCopyPrompt'))
              : null))
        : null,
      sd
        ? h('div', { id: 'ck-skill-box', class: 'cp-create-form' },
          h('div', { class: 'cp-badges' },
            h('span', { class: 'cp-meta' }, t('ckSkillPreviewTitle')),
            sd.offerKind === 'update' ? h('span', { class: 'cp-badge accent' }, t('ckOfferUpdateBadge')) : null,
            (sd.evidenceCount ?? 1) >= 2 ? h('span', { class: 'cp-badge' }, t('ckOfferEvidenceBadge', { count: sd.evidenceCount })) : null),
          sd.evidenceSummary ? h('p', { class: 'cp-trust-note' }, sd.evidenceSummary) : null,
          h('textarea', {
            class: 'cp-textarea cp-code-textarea',
            rows: 9,
            dataset: { focus: 'ck-skill-md' },
            value: state.skillMarkdownDraft,
            oninput: (e) => { state.skillMarkdownDraft = e.target.value; },
          }, state.skillMarkdownDraft),
          renderRepoWriteBox(sd),
          h('div', { class: 'cp-form-actions' },
            h('button', {
              type: 'button',
              class: 'cp-mini-btn',
              onclick: () => downloadFile(`${dlSlug}-SKILL.md`, state.skillMarkdownDraft),
            }, t('ckDownloadSkill', { slug: dlSlug })),
            h('button', {
              type: 'button',
              class: 'cp-mini-btn',
              onclick: () => void copyText(state.skillMarkdownDraft),
            }, t('ckCopySkill'))),
          state.notesNotice === 'saved'
            ? h('p', { class: 'cp-trust-note ok', role: 'status' }, icon('check'), t('ckNotesSaved'))
            : state.notesNotice === 'failed'
              ? h('p', { class: 'cp-error', role: 'alert' }, t('cpActionFailed'))
              : null,
          sd.suggestedNotes?.length
            ? h('div', { class: 'cp-card' },
              h('span', { class: 'cp-meta' }, t('ckSuggestedNotesTitle')),
              h('ul', { class: 'cp-evict-list' }, sd.suggestedNotes.map((n, idx) =>
                h('li', null,
                  h('label', { class: 'cp-check-row' },
                    h('input', {
                      type: 'checkbox',
                      checked: state.selectedNotes.has(idx),
                      onchange: (e) => {
                        if (e.target.checked) state.selectedNotes.add(idx);
                        else state.selectedNotes.delete(idx);
                        touch();
                      },
                    }),
                    h('span', { class: 'cp-badge' }, tOr(`cpNoteKind_${n.kind}`, n.kind)),
                    h('span', { class: 'cp-evict-text' }, n.text))))),
              h('div', { class: 'cp-form-actions' },
                h('button', {
                  type: 'button',
                  class: 'cp-primary-btn',
                  disabled: state.savingNotes || state.selectedNotes.size === 0,
                  onclick: () => void saveSuggestedNotes(),
                }, t('ckSaveSelectedNotes', { count: state.selectedNotes.size }))))
            : null)
        : null);
  }

  return {
    open(workerId, threadId) {
      state.workerId = workerId;
      state.threadId = threadId ?? null;
      state.checkpoint = null;
      state.distillNotice = null;
      state.handoff = null;
      state.skillData = null;
      state.skillMarkdownDraft = '';
      state.skillSlugDraft = '';
      state.skillTarget = 'agents-skill';
      state.skillScopeKind = 'repo';
      state.skillConfirmOverwrite = false;
      state.skillWriteError = null;
      state.skillSavedResult = null;
      state.notesNotice = null;
      state.selectedNotes.clear();
      void loadCheckpoint(workerId);
    },
    openSkillOffer(offer) {
      state.workerId = offer.workerId;
      state.threadId = offer.threadId ?? null;
      state.checkpoint = null;
      state.distillNotice = 'skill_ok';
      state.handoff = null;
      state.skillData = {
        mode: 'skill',
        workerId: offer.workerId,
        deviceId: offer.deviceId,
        repoId: offer.repoId,
        repoName: offer.repoName ?? null,
        hasWriteWorktree: false,
        offerKind: offer.offerKind === 'update' ? 'update' : 'create',
        evidenceCount: offer.evidenceCount ?? 1,
        evidenceSummary: offer.evidenceSummary ?? null,
        skill: {
          slug: offer.slug,
          name: offer.name,
          description: offer.description,
          markdown: offer.markdown,
        },
        suggestedNotes: [],
      };
      state.skillMarkdownDraft = offer.markdown ?? '';
      state.skillSlugDraft = offer.slug ?? '';
      state.skillTarget = offer.target || 'agents-skill';
      state.skillScopeKind = 'repo';
      state.skillConfirmOverwrite = offer.offerKind === 'update';
      state.skillWriteError = null;
      state.skillSavedResult = null;
      state.notesNotice = null;
      state.selectedNotes.clear();
      void loadCheckpoint(offer.workerId);
    },
    title() {
      return t('ckDialogTitle', { worker: state.workerId ?? '' });
    },
    signature() {
      return [state.workerId, state.rev];
    },
    render() {
      const topSection = state.status === 'loading' && !state.checkpoint
        ? h('p', { class: 'cp-empty' }, t('ckLoading'))
        : state.status === 'error' && !state.checkpoint
          ? h('p', { class: 'cp-error' }, t('ckLoadFailed'))
          : state.checkpoint
            ? renderCheckpointSection(state.checkpoint)
            : null;
      const bottomSection = state.checkpoint || state.skillData ? renderDistillSection() : null;
      return h('div', { class: 'cp-root' },
        h('div', { class: 'cp-pane' }, topSection, bottomSection));
    },
  };
}

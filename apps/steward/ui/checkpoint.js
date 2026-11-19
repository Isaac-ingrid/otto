// Worker Checkpoint, Trajectory Compaction & Skill/Memory Extraction UI (Direction 2B, Stage 3).
// Built strictly with h() text nodes from dom.js — zero HTML sinks, zero inline styles.
import { h, icon } from './dom.js';
import { t, tOr } from './i18n.js';

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
  const { request, uuid, toast, bump, fillContinuation, refreshWorkspace } = deps;

  const state = {
    rev: 0,
    workerId: null,
    threadId: null,
    status: 'idle',
    checkpoint: null,
    distilling: null,
    handoff: null,
    skillData: null,
    skillMarkdownDraft: '',
    selectedNotes: new Set(),
    savingNotes: false,
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

  async function runDistill(mode) {
    if (state.distilling || !state.workerId) return;
    state.distilling = mode;
    touch();
    try {
      const { status, data } = await request(`/app/api/workers/${encodeURIComponent(state.workerId)}/distill`, {
        id: uuid(),
        mode,
      });
      if (status === 200 && data) {
        if (mode === 'handoff') {
          state.handoff = data;
        } else {
          state.skillData = data;
          state.skillMarkdownDraft = data.skill?.markdown ?? '';
          state.selectedNotes = new Set((data.suggestedNotes ?? []).map((_, idx) => idx));
        }
      } else if (status === 409 && data?.error === 'over_budget') {
        toast(t('ckDistillOverLimit'));
      } else if (status !== 401) {
        toast(t('ckDistillFailed'));
      }
    } catch {
      toast(t('ckDistillFailed'));
    } finally {
      state.distilling = null;
      touch();
    }
  }

  async function saveSuggestedNotes() {
    const sd = state.skillData;
    if (!sd || state.savingNotes || state.selectedNotes.size === 0) return;
    state.savingNotes = true;
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
      toast(t('ckNotesSaved'));
      await refreshWorkspace();
    } catch {
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

  function renderDistillSection() {
    const busy = Boolean(state.distilling);
    const ho = state.handoff;
    const sd = state.skillData;
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
      ho
        ? h('div', { class: 'cp-create-form' },
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
        ? h('div', { class: 'cp-create-form' },
          h('span', { class: 'cp-meta' }, t('ckSkillPreviewTitle')),
          h('textarea', {
            class: 'cp-textarea',
            rows: 9,
            dataset: { focus: 'ck-skill-md' },
            value: state.skillMarkdownDraft,
            oninput: (e) => { state.skillMarkdownDraft = e.target.value; },
          }, state.skillMarkdownDraft),
          h('div', { class: 'cp-form-actions' },
            h('button', {
              type: 'button',
              class: 'cp-primary-btn',
              onclick: () => downloadFile(`${sd.skill?.slug || "extracted"}-SKILL.md`, state.skillMarkdownDraft),
            }, t('ckDownloadSkill', { slug: sd.skill?.slug || "extracted" })),
            h('button', {
              type: 'button',
              class: 'cp-mini-btn',
              onclick: () => void copyText(state.skillMarkdownDraft),
            }, t('ckCopySkill'))),
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
      state.handoff = null;
      state.skillData = null;
      state.skillMarkdownDraft = '';
      state.selectedNotes.clear();
      void loadCheckpoint(workerId);
    },
    title() {
      return t('ckDialogTitle', { worker: state.workerId ?? '' });
    },
    signature() {
      return [state.workerId, state.rev];
    },
    render() {
      return h('div', { class: 'cp-root' },
        h('div', { class: 'cp-pane' },
          state.status === 'loading' && !state.checkpoint
            ? h('p', { class: 'cp-empty' }, t('ckLoading'))
            : state.status === 'error'
              ? h('p', { class: 'cp-error' }, t('ckLoadFailed'))
              : state.checkpoint
                ? [renderCheckpointSection(state.checkpoint), renderDistillSection()]
                : null));
    },
  };
}

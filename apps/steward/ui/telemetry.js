// Multi-day Steward budget trends, native declarative SVG stacked bar chart, Top Thread/Repo
// consumption leaderboards, and Worker runtime context-window health classification (Direction D).
// Built strictly with h() and svg() from dom.js — zero HTML sinks, zero inline styles, zero external chart libs.
import { h, icon, svg } from './dom.js';
import { formatClock, formatUsd } from './format.js';
import { t } from './i18n.js';

export const TELEMETRY_CATEGORIES = [
  'chat',
  'wake',
  'schedule',
  'pr_triage',
  'memory_skill',
  'unattributed',
];

export const TELEMETRY_DAYS_OPTIONS = [
  { days: 7, labelKey: 'tmDaysWeek' },
  { days: 14, labelKey: 'tmDaysFortnight' },
  { days: 30, labelKey: 'tmDaysMonth' },
];

export const TELEMETRY_I18N_KEYS = [
  'tmCat_chat',
  'tmCat_wake',
  'tmCat_schedule',
  'tmCat_pr_triage',
  'tmCat_memory_skill',
  'tmCat_unattributed',
  'tmDaysWeek',
  'tmDaysFortnight',
  'tmDaysMonth',
];

/** Compact human-readable token formatter (`840` -> `'840'`, `12400` -> `'12.4k'`, `1250000` -> `'1.25M'`). */
export function formatCompactTokens(value) {
  const n = typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${m >= 10 ? m.toFixed(1) : m.toFixed(2).replace(/\.?0+$/, '')}M`;
  }
  if (n >= 1_000) {
    const k = n / 1_000;
    return `${k >= 100 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, '')}k`;
  }
  return String(n);
}

/**
 * Classifies a Worker's runtime context-window watermark into 3 actionable tiers aligned with
 * Steward's `HIGH_CONTEXT_USAGE = 0.8` handoff threshold (`normal` < 80%, `warn` 80–89%, `high` >= 90%),
 * while degrading honestly (`level: 'unknown'`) when only token counts without window size exist.
 */
export function classifyWorkerContext(worker) {
  if (!worker || typeof worker !== 'object') {
    return {
      hasTelemetry: false,
      percent: null,
      tokens: null,
      window: null,
      compactionCount: 0,
      slowToolMs: null,
      compacting: false,
      level: 'unknown',
    };
  }
  const rawPct = worker.contextPercent;
  const percent = typeof rawPct === 'number' && Number.isFinite(rawPct) && rawPct >= 0
    ? Math.max(0, Math.min(100, Math.round(rawPct)))
    : null;
  const tokens = typeof worker.contextTokens === 'number' && Number.isFinite(worker.contextTokens) && worker.contextTokens >= 0
    ? Math.round(worker.contextTokens)
    : null;
  const window = typeof worker.contextWindow === 'number' && Number.isFinite(worker.contextWindow) && worker.contextWindow > 0
    ? Math.round(worker.contextWindow)
    : null;
  const compactionCount = typeof worker.compactionCount === 'number' && Number.isFinite(worker.compactionCount) && worker.compactionCount > 0
    ? Math.round(worker.compactionCount)
    : 0;
  const rawToolMs = worker.lastToolDurationMs;
  const slowToolMs = typeof rawToolMs === 'number' && Number.isFinite(rawToolMs) && rawToolMs >= 2000
    ? Math.round(rawToolMs)
    : null;
  const compacting = worker.progress?.phase === 'compacting';

  let level = 'unknown';
  if (percent !== null) {
    if (percent >= 90) level = 'high';
    else if (percent >= 80) level = 'warn';
    else level = 'normal';
  }

  const hasTelemetry = percent !== null || (tokens !== null && tokens > 0) || compactionCount > 0 || slowToolMs !== null || compacting;

  return {
    hasTelemetry,
    percent,
    tokens,
    window,
    compactionCount,
    slowToolMs,
    compacting,
    level,
  };
}

/**
 * Pure deterministic layout calculator for the SVG stacked daily usage chart.
 * Automatically falls back from `'steward_usd'` to `'steward_tokens'` when all reported Steward
 * dollar costs are $0 (free/unpriced models) while non-zero Steward tokens exist.
 */
export function computeStackedChartGeometry(series, options = {}) {
  const points = Array.isArray(series) ? series : [];
  const requestedMode = options.mode === 'worker_tokens' ? 'worker_tokens' : 'steward_usd';
  const limitUsd = typeof options.limitUsd === 'number' && Number.isFinite(options.limitUsd) && options.limitUsd > 0
    ? options.limitUsd
    : 0;
  const width = options.width ?? 640;
  const height = options.height ?? 176;
  const plotLeft = 12;
  const plotRight = width - 12;
  const plotTop = 14;
  const plotBottom = height - 26;
  const plotWidth = Math.max(1, plotRight - plotLeft);
  const plotHeight = Math.max(1, plotBottom - plotTop);

  const anyStewardUsd = points.some((p) => (p?.totalCostUsd ?? 0) > 0);
  const anyStewardTok = points.some((p) => (p?.totalTokens ?? 0) > 0);
  const unit = requestedMode === 'worker_tokens'
    ? 'worker_tokens'
    : (!anyStewardUsd && anyStewardTok ? 'steward_tokens' : 'steward_usd');

  const totals = points.map((p) => {
    if (unit === 'worker_tokens') return Math.max(0, p?.worker?.totalTokens ?? 0);
    if (unit === 'steward_tokens') return Math.max(0, p?.totalTokens ?? 0);
    return Math.max(0, p?.totalCostUsd ?? 0);
  });

  const peakData = totals.reduce((acc, v) => Math.max(acc, v), 0);
  const rawMax = unit === 'steward_usd' && limitUsd > 0
    ? Math.max(peakData, limitUsd * 1.08)
    : peakData;
  const maxVal = rawMax > 0 ? rawMax : 1;

  const count = Math.max(1, points.length);
  const slotWidth = plotWidth / count;
  const barWidth = Math.max(6, Math.min(34, Math.floor(slotWidth * 0.66)));
  const labelStride = count > 20 ? 5 : count > 10 ? 2 : 1;

  const bars = points.map((point, index) => {
    const centerX = plotLeft + slotWidth * index + slotWidth / 2;
    const x = Math.round((centerX - barWidth / 2) * 10) / 10;
    const total = totals[index] ?? 0;
    const segments = [];

    if (unit === 'worker_tokens') {
      if (total > 0) {
        const hPx = Math.max(2, Math.round((total / maxVal) * plotHeight * 10) / 10);
        segments.push({
          category: 'worker',
          value: total,
          y: Math.round((plotBottom - hPx) * 10) / 10,
          height: hPx,
        });
      }
    } else {
      let cursorY = plotBottom;
      for (const category of TELEMETRY_CATEGORIES) {
        const bucket = point?.byCategory?.[category];
        const val = unit === 'steward_tokens'
          ? Math.max(0, bucket?.tokens ?? 0)
          : Math.max(0, bucket?.costUsd ?? 0);
        if (!(val > 0)) continue;
        const rawH = (val / maxVal) * plotHeight;
        const hPx = Math.max(1.5, Math.min(cursorY - plotTop, Math.round(rawH * 10) / 10));
        if (hPx <= 0) continue;
        const y = Math.round((cursorY - hPx) * 10) / 10;
        segments.push({ category, value: val, y, height: hPx });
        cursorY = y;
      }
    }

    return {
      index,
      day: String(point?.day ?? ''),
      shortLabel: String(point?.day ?? '').slice(5),
      showLabel: index === count - 1 || index % labelStride === 0,
      x,
      centerX: Math.round(centerX * 10) / 10,
      width: barWidth,
      total,
      overLimit: Boolean(point?.overLimit),
      segments,
    };
  });

  const limitLineY = unit === 'steward_usd' && limitUsd > 0 && limitUsd <= maxVal
    ? Math.round((plotBottom - (limitUsd / maxVal) * plotHeight) * 10) / 10
    : null;

  return {
    unit,
    width,
    height,
    plotLeft,
    plotRight,
    plotTop,
    plotBottom,
    maxVal,
    limitUsd,
    limitLineY,
    bars,
  };
}

/** Renders the always-visible compact daily Steward budget card at the top of Control Plane -> Schedules. */
export function renderSchedulesBudgetCard(budget, onOpenTrends) {
  if (!budget) return null;
  const limit = typeof budget.limitUsd === 'number' && budget.limitUsd > 0 ? budget.limitUsd : 0;
  const spent = typeof budget.costUsd === 'number' ? budget.costUsd : 0;
  const pct = limit > 0 ? Math.min(100, Math.round((spent / limit) * 100)) : 0;
  const toneClass = budget.over ? ' is-over' : pct >= 80 ? ' is-warn' : '';
  const dayLabel = budget.day ?? 'UTC';

  return h('div', { class: `cp-meter-card tm-sched-budget${toneClass}` },
    h('div', { class: 'cp-meter-head' },
      h('strong', null, t('tmTodayBudgetTitle', { day: dayLabel })),
      h('span', null, t('tmTodayBudgetUsage', {
        spent: formatUsd(spent),
        limit: formatUsd(budget.limitUsd ?? 0),
        tokens: formatCompactTokens(budget.tokens ?? 0),
      }))),
    limit > 0
      ? h('progress', { class: `cp-meter${toneClass}`, value: Math.min(spent, limit), max: limit })
      : null,
    h('div', { class: 'tm-sched-budget-foot' },
      h('div', { class: 'tm-sched-budget-meta' },
        budget.over
          ? h('span', { class: 'cp-warn-text' }, icon('alert'), t('cpOverLimitBanner', {
            spent: formatUsd(spent),
            limit: formatUsd(budget.limitUsd ?? 0),
          }))
          : budget.resetsAt
            ? h('span', null, `00:00 UTC (${formatClock(budget.resetsAt)})`)
            : null,
        (budget.skippedWakes ?? 0) > 0
          ? h('span', { class: 'cp-badge status-paused' }, t('tmSkippedWakesBadge', { count: budget.skippedWakes }))
          : null),
      onOpenTrends
        ? h('button', {
          type: 'button',
          class: 'cp-mini-btn',
          onclick: onOpenTrends,
        }, t('tmViewTrendsBtn'))
        : null));
}

export function createTelemetryPane(deps) {
  const { request, touch, openThread } = deps;

  const tm = {
    days: 7,
    mode: 'steward_usd',
    status: 'idle',
    data: null,
    selectedIndex: -1,
  };

  async function load(days = tm.days) {
    tm.days = days;
    tm.status = 'loading';
    touch();
    const { status, data } = await request(`/app/api/telemetry?days=${days}`);
    if (status === 200 && data && Array.isArray(data.series)) {
      tm.data = data;
      tm.status = 'ready';
      tm.selectedIndex = data.series.length > 0 ? data.series.length - 1 : -1;
    } else {
      tm.status = 'error';
    }
    touch();
  }

  function renderSelectedDayInspector(series, geom) {
    if (!series.length) return null;
    const idx = tm.selectedIndex >= 0 && tm.selectedIndex < series.length
      ? tm.selectedIndex
      : series.length - 1;
    const point = series[idx];
    if (!point) return null;

    const activeCats = TELEMETRY_CATEGORIES.filter((cat) => {
      const b = point.byCategory?.[cat];
      return b && ((b.costUsd ?? 0) > 0 || (b.tokens ?? 0) > 0);
    });

    return h('div', { class: 'tm-day-inspector' },
      h('div', { class: 'tm-day-inspector-head' },
        h('strong', null, t('tmSelectedDayTitle', {
          day: point.day,
          total: formatUsd(point.totalCostUsd ?? 0),
          tokens: formatCompactTokens(point.totalTokens ?? 0),
        })),
        h('span', { class: 'tm-day-inspector-sub' }, t('tmSelectedDayWorker', {
          runs: point.worker?.settledRuns ?? 0,
          tokens: formatCompactTokens(point.worker?.totalTokens ?? 0),
        })),
        (point.skippedWakes ?? 0) > 0
          ? h('span', { class: 'cp-badge status-paused' }, t('tmSkippedWakesBadge', { count: point.skippedWakes }))
          : null),
      activeCats.length > 0
        ? h('div', { class: 'tm-cat-chips' }, activeCats.map((cat) => {
          const b = point.byCategory[cat];
          const metric = geom.unit === 'steward_tokens'
            ? `${formatCompactTokens(b.tokens ?? 0)} tok`
            : `${formatUsd(b.costUsd ?? 0)} · ${formatCompactTokens(b.tokens ?? 0)} tok`;
          return h('span', { class: 'tm-cat-chip' },
            h('span', { class: `tm-swatch tm-bar-${cat}` }),
            `${t(`tmCat_${cat}`)}: ${metric}`);
        }))
        : null);
  }

  function renderChart(data) {
    const series = data.series ?? [];
    const geom = computeStackedChartGeometry(series, {
      mode: tm.mode,
      limitUsd: data.budget?.limitUsd ?? 0,
    });
    const selectedIdx = tm.selectedIndex >= 0 && tm.selectedIndex < series.length
      ? tm.selectedIndex
      : series.length - 1;

    const headingKey = geom.unit === 'worker_tokens'
      ? 'tmChartHeadingWorkerTok'
      : geom.unit === 'steward_tokens'
        ? 'tmChartHeadingStewardTok'
        : 'tmChartHeadingStewardUsd';

    const svgNode = svg(
      'svg',
      {
        class: 'tm-svg-chart',
        viewBox: `0 0 ${geom.width} ${geom.height}`,
        role: 'img',
        'aria-label': t('tmChartAriaLabel'),
      },
      svg('line', {
        class: 'tm-axis-line',
        x1: geom.plotLeft,
        y1: geom.plotBottom,
        x2: geom.plotRight,
        y2: geom.plotBottom,
      }),
      geom.limitLineY !== null
        ? svg('g', { class: 'tm-limit-group' },
          svg('line', {
            class: 'tm-limit-line',
            x1: geom.plotLeft,
            y1: geom.limitLineY,
            x2: geom.plotRight,
            y2: geom.limitLineY,
            'stroke-dasharray': '4 4',
          }),
          svg('text', {
            class: 'tm-limit-label',
            x: geom.plotRight - 4,
            y: Math.max(11, geom.limitLineY - 4),
            'text-anchor': 'end',
          }, t('tmDailyCapLine', { limit: formatUsd(geom.limitUsd) })))
        : null,
      geom.bars.map((bar) => {
        const isSelected = bar.index === selectedIdx;
        const point = series[bar.index];
        const summaryTitle = `${bar.day}: ${formatUsd(point?.totalCostUsd ?? 0)} (${formatCompactTokens(point?.totalTokens ?? 0)} tok)`;
        return svg('g', {
          class: `tm-day-col${isSelected ? ' selected' : ''}${bar.overLimit ? ' over-limit' : ''}`,
          tabindex: '0',
          role: 'button',
          'aria-pressed': String(isSelected),
          'aria-label': summaryTitle,
          onclick: () => {
            tm.selectedIndex = bar.index;
            touch();
          },
          onkeydown: (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              tm.selectedIndex = bar.index;
              touch();
            } else if (e.key === 'ArrowLeft' && bar.index > 0) {
              e.preventDefault();
              tm.selectedIndex = bar.index - 1;
              touch();
            } else if (e.key === 'ArrowRight' && bar.index < geom.bars.length - 1) {
              e.preventDefault();
              tm.selectedIndex = bar.index + 1;
              touch();
            }
          },
        },
        svg('title', null, summaryTitle),
        svg('rect', {
          class: 'tm-day-hit',
          x: Math.max(0, bar.centerX - Math.max(bar.width / 2 + 3, 10)),
          y: geom.plotTop,
          width: Math.max(bar.width + 6, 20),
          height: geom.plotBottom - geom.plotTop,
          rx: 3,
        }),
        bar.segments.length > 0
          ? bar.segments.map((seg) => svg('rect', {
            class: `tm-bar-seg tm-bar-${seg.category}`,
            x: bar.x,
            y: seg.y,
            width: bar.width,
            height: seg.height,
            rx: 2,
          }))
          : svg('rect', {
            class: 'tm-bar-zero',
            x: bar.x,
            y: geom.plotBottom - 2,
            width: bar.width,
            height: 2,
            rx: 1,
          }),
        bar.showLabel
          ? svg('text', {
            class: 'tm-day-label',
            x: bar.centerX,
            y: geom.height - 8,
            'text-anchor': 'middle',
          }, bar.shortLabel)
          : null);
      }),
    );

    return h('section', { class: 'cp-section tm-chart-card' },
      h('div', { class: 'tm-chart-head' },
        h('h3', { class: 'cp-section-title' }, icon('signal'), t(headingKey)),
        geom.unit !== 'worker_tokens'
          ? h('div', { class: 'tm-legend' }, TELEMETRY_CATEGORIES.map((cat) =>
            h('span', { class: 'tm-legend-item' },
              h('span', { class: `tm-swatch tm-bar-${cat}` }),
              t(`tmCat_${cat}`))))
          : null),
      svgNode,
      renderSelectedDayInspector(series, geom));
  }

  function renderRankings(data) {
    const threads = data.topThreads ?? [];
    const repos = data.topRepos ?? [];

    return h('div', { class: 'tm-rank-grid' },
      h('section', { class: 'cp-section tm-rank-col' },
        h('h3', { class: 'cp-section-title' }, icon('layers'), t('tmTopThreadsHeading')),
        threads.length === 0
          ? h('p', { class: 'cp-empty' }, t('tmEmptyRanks'))
          : h('div', { class: 'cp-list' }, threads.map((item) =>
            h('button', {
              type: 'button',
              class: 'tm-rank-row tm-thread-btn',
              onclick: () => openThread(item.threadId, Boolean(item.archived)),
            },
            h('div', { class: 'tm-rank-main' },
              h('strong', { class: 'tm-rank-title' }, item.title),
              item.archived ? h('span', { class: 'cp-badge' }, t('archived')) : null,
              item.repos?.length ? h('span', { class: 'cp-meta' }, item.repos.join(', ')) : null),
            h('div', { class: 'tm-rank-metrics' }, t('tmThreadMetrics', {
              cost: formatUsd(item.stewardCostUsd ?? 0),
              stewardTok: formatCompactTokens(item.stewardTokens ?? 0),
              workerTok: formatCompactTokens(item.workerTokens ?? 0),
            })))))),
      h('section', { class: 'cp-section tm-rank-col' },
        h('h3', { class: 'cp-section-title' }, icon('folder'), t('tmTopReposHeading')),
        repos.length === 0
          ? h('p', { class: 'cp-empty' }, t('tmEmptyRanks'))
          : h('div', { class: 'cp-list' }, repos.map((repo) =>
            h('div', { class: 'tm-rank-row' },
              h('div', { class: 'tm-rank-main' },
                h('strong', { class: 'tm-rank-title' }, repo.repoName)),
              h('div', { class: 'tm-rank-metrics' }, t('tmRepoMetrics', {
                runs: repo.workerRuns ?? 0,
                workerTok: formatCompactTokens(repo.workerTokens ?? 0),
                cost: formatUsd(repo.stewardCostUsd ?? 0),
              })))))));
  }

  return {
    open() {
      void load(tm.days);
    },
    ensureLoaded() {
      if (tm.status === 'idle') void load(tm.days);
    },
    reload() {
      void load(tm.days);
    },
    render() {
      const data = tm.data;
      return h('div', { class: 'cp-pane tm-pane' },
        h('div', { class: 'cp-toolbar tm-toolbar' },
          h('div', { class: 'cp-pills', role: 'group' }, TELEMETRY_DAYS_OPTIONS.map((opt) =>
            h('button', {
              type: 'button',
              class: `cp-pill${tm.days === opt.days ? ' active' : ''}`,
              onclick: () => void load(opt.days),
            }, t(opt.labelKey)))),
          h('div', { class: 'cp-pills', role: 'group' },
            h('button', {
              type: 'button',
              class: `cp-pill${tm.mode === 'steward_usd' ? ' active' : ''}`,
              onclick: () => { tm.mode = 'steward_usd'; touch(); },
            }, t('tmModeSteward')),
            h('button', {
              type: 'button',
              class: `cp-pill${tm.mode === 'worker_tokens' ? ' active' : ''}`,
              onclick: () => { tm.mode = 'worker_tokens'; touch(); },
            }, t('tmModeWorker')))),
        tm.status === 'loading' && !data
          ? h('p', { class: 'cp-empty' }, t('cpLoading'))
          : tm.status === 'error' && !data
            ? h('p', { class: 'cp-error' }, t('cpLoadFailed'))
            : !data
              ? h('p', { class: 'cp-empty' }, t('cpLoading'))
              : [
                renderSchedulesBudgetCard(data.budget, null),
                h('div', { class: 'tm-kpi-grid' },
                  h('div', { class: 'cp-meter-card tm-kpi-card' },
                    h('span', { class: 'tm-kpi-label' }, t('tmKpiStewardSpend')),
                    h('strong', { class: 'tm-kpi-value' }, formatUsd(data.totals?.stewardCostUsd ?? 0)),
                    (data.totals?.skippedWakes ?? 0) > 0
                      ? h('small', { class: 'cp-warn-text' }, t('tmSkippedWakesBadge', { count: data.totals.skippedWakes }))
                      : null),
                  h('div', { class: 'cp-meter-card tm-kpi-card' },
                    h('span', { class: 'tm-kpi-label' }, t('tmKpiStewardTokens')),
                    h('strong', { class: 'tm-kpi-value' }, formatCompactTokens(data.totals?.stewardTokens ?? 0))),
                  h('div', { class: 'cp-meter-card tm-kpi-card' },
                    h('span', { class: 'tm-kpi-label' }, t('tmKpiWorkerUsage')),
                    h('strong', { class: 'tm-kpi-value' }, t('tmKpiWorkerRuns', {
                      runs: data.totals?.workerRuns ?? 0,
                      tokens: formatCompactTokens(data.totals?.workerTokens ?? 0),
                    })),
                    (data.totals?.workerReportedCostUsd ?? 0) > 0
                      ? h('small', { class: 'tm-kpi-sub' }, t('tmKpiWorkerReportedUsd', { cost: formatUsd(data.totals.workerReportedCostUsd) }))
                      : null)),
                renderChart(data),
                renderRankings(data),
              ]);
    },
  };
}

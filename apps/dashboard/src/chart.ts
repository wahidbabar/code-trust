// The survival chart: both cohorts' curves as step functions on one 0 to 100% axis, in hand-written
// SVG. No chart library, because a library's default draws a missing value as 0.
import type { MeasuredCohort, SurvivalCurve } from '@code-trust/shared';
import {
  axisEndDay,
  CHART_HEIGHT,
  COHORT_LABEL,
  COHORT_NOUN,
  COHORT_ORDER,
  chartScales,
  DEFAULT_CHART_WIDTH,
  lastPoint,
  pointAt,
  runPath,
  type Scales,
  stepRuns,
  stopDays,
  THIN_AT_RISK,
  xTicks,
} from './curve.ts';
import { h, svg } from './dom.ts';
import { formatSurvival, NOT_OBSERVED, plural } from './format.ts';

const END_LABEL_MIN_GAP_PX = 16;

export function renderSurvivalChart(curves: readonly SurvivalCurve[]): HTMLElement {
  const ordered = COHORT_ORDER.flatMap((cohort) => curves.filter((curve) => curve.cohort === cohort));
  if (ordered.length === 0) {
    return h('p', { class: 'chart-empty' }, 'There are no AI or human lines to chart yet.');
  }

  const tooltip = h('div', { class: 'chart-tooltip', hidden: true });
  const frame = h('div', { class: 'chart-frame' }, tooltip);
  let drawnWidth = 0;
  let plot: SVGSVGElement | undefined;
  // Drawn at the frame's real width, so text stays its CSS size instead of scaling with a viewBox.
  const draw = (width: number) => {
    drawnWidth = width;
    const next = drawPlot(ordered, width, tooltip);
    if (plot) plot.replaceWith(next);
    else frame.prepend(next);
    plot = next;
  };
  draw(DEFAULT_CHART_WIDTH);

  if (typeof ResizeObserver !== 'undefined') {
    const observer = new ResizeObserver((entries) => {
      // Removing an observed element notifies too: that is when a replaced view lets go.
      if (!frame.isConnected) {
        observer.disconnect();
        return;
      }
      const width = Math.round(entries[0]?.contentRect.width ?? 0);
      if (width > 0 && width !== drawnWidth) draw(width);
    });
    observer.observe(frame);
  }

  return h('div', { class: 'chart' }, legend(ordered), frame, notes(ordered), tableView(ordered));
}

function drawPlot(curves: readonly SurvivalCurve[], width: number, tooltip: HTMLElement): SVGSVGElement {
  const scales = chartScales(axisEndDay(curves), width);
  const plot = svg('svg', {
    class: 'chart-plot',
    viewBox: `0 0 ${width} ${CHART_HEIGHT}`,
    role: 'img',
    'aria-label': describe(curves),
    tabindex: 0,
  });

  for (const share of [0, 0.25, 0.5, 0.75, 1]) {
    const y = scales.y(share);
    plot.append(
      svg('line', { class: share === 0 ? 'axis' : 'grid', x1: scales.left, x2: scales.right, y1: y, y2: y }),
      svg(
        'text',
        { class: 'tick-label', x: scales.left - 8, y, 'text-anchor': 'end', dy: '0.32em' },
        `${share * 100}%`,
      ),
    );
  }
  for (const day of xTicks(scales)) {
    const x = scales.x(day);
    plot.append(
      svg('line', { class: 'axis', x1: x, x2: x, y1: scales.bottom, y2: scales.bottom + 4 }),
      svg('text', { class: 'tick-label', x, y: scales.bottom + 18, 'text-anchor': 'middle' }, String(day)),
    );
  }
  plot.append(
    svg(
      'text',
      { class: 'axis-title', x: (scales.left + scales.right) / 2, y: CHART_HEIGHT - 6, 'text-anchor': 'middle' },
      'days since the lines landed',
    ),
  );

  // The baseline cohort first, so the AI curve sits on top where they overlap.
  for (const curve of [...curves].reverse()) plot.append(drawCurve(curve, scales));
  plot.append(...endLabels(curves, scales));
  addHoverLayer(plot, curves, scales, tooltip);
  return plot;
}

function drawCurve(curve: SurvivalCurve, scales: Scales): SVGGElement {
  const group = svg('g', { class: `curve curve-${curve.cohort}`, 'data-cohort': curve.cohort });
  for (const run of stepRuns(curve.points, scales.endDay)) {
    const d = runPath(run, scales);
    if (d === null) continue;
    group.append(
      svg('path', {
        class: run.thin ? 'run run-thin' : 'run',
        d,
        'data-day': run.day,
        'data-until-day': run.untilDay,
        'data-at-risk': run.atRisk,
      }),
    );
  }
  const last = lastPoint(curve.points);
  group.append(svg('circle', { class: 'end-dot', cx: scales.x(last.day), cy: scales.y(last.survival), r: 4 }));
  return group;
}

// Direct labels at each curve's end. When two ends crowd each other, neither is labeled: nudging
// them apart detaches them from their lines, and the legend and tooltip still name both.
function endLabels(curves: readonly SurvivalCurve[], scales: Scales): SVGTextElement[] {
  const ends = curves.map((curve) => {
    const last = lastPoint(curve.points);
    // A curve at 0 runs on along the baseline, so its label sits above the line.
    const y = last.survival === 0 ? scales.y(0) - 10 : scales.y(last.survival);
    return {
      cohort: curve.cohort,
      x: scales.x(last.day) + 9,
      y,
      text: `${COHORT_LABEL[curve.cohort]} ${formatSurvival(last.survival)}`,
    };
  });
  const [a, b] = ends;
  if (a && b && Math.abs(a.y - b.y) < END_LABEL_MIN_GAP_PX && Math.abs(a.x - b.x) < 80) return [];
  return ends.map((end) =>
    svg('text', { class: 'end-label', x: end.x, y: end.y, dy: '0.32em', 'data-cohort': end.cohort }, end.text),
  );
}

function addHoverLayer(plot: SVGSVGElement, curves: readonly SurvivalCurve[], scales: Scales, tooltip: HTMLElement) {
  const crosshair = svg('line', {
    class: 'crosshair',
    x1: 0,
    x2: 0,
    y1: scales.top,
    y2: scales.bottom,
    visibility: 'hidden',
  });
  const hitArea = svg('rect', {
    class: 'hit-area',
    x: scales.left,
    y: scales.top,
    width: scales.right - scales.left,
    height: scales.bottom - scales.top,
  });
  plot.append(crosshair, hitArea);
  const days = stopDays(curves, scales.endDay);
  let activeDay = 0;

  const show = (day: number) => {
    activeDay = day;
    const x = scales.x(day);
    crosshair.setAttribute('x1', String(x));
    crosshair.setAttribute('x2', String(x));
    crosshair.setAttribute('visibility', 'visible');
    fillTooltip(tooltip, curves, day);
    tooltip.hidden = false;
    // CSSOM, not a style attribute: the build's Content-Security-Policy allows no inline styles.
    tooltip.style.left = `${x}px`;
    tooltip.classList.toggle('is-flipped', x > scales.width * 0.6);
  };
  const hide = () => {
    crosshair.setAttribute('visibility', 'hidden');
    tooltip.hidden = true;
  };

  plot.addEventListener('pointermove', (event) => {
    const box = plot.getBoundingClientRect();
    const scale = box.width > 0 ? scales.width / box.width : 1;
    show(scales.dayAt((event.clientX - box.left) * scale));
  });
  plot.addEventListener('pointerleave', hide);
  plot.addEventListener('focus', () => show(activeDay));
  plot.addEventListener('blur', hide);
  plot.addEventListener('keydown', (event) => {
    const target =
      event.key === 'ArrowRight'
        ? days.find((day) => day > activeDay)
        : event.key === 'ArrowLeft'
          ? days.findLast((day) => day < activeDay)
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? scales.endDay
              : undefined;
    if (target === undefined) return;
    event.preventDefault();
    show(target);
  });
}

function fillTooltip(tooltip: HTMLElement, curves: readonly SurvivalCurve[], day: number) {
  tooltip.replaceChildren(
    h('p', { class: 'tooltip-day' }, `Day ${day}`),
    h(
      'ul',
      {},
      ...curves.map((curve) => {
        const point = pointAt(curve.points, day);
        const label = COHORT_LABEL[curve.cohort];
        if (point === null) {
          return h(
            'li',
            { 'data-cohort': curve.cohort },
            lineKey(curve.cohort),
            h('strong', {}, NOT_OBSERVED),
            h('span', {}, label),
          );
        }
        const detail = point.atRisk === 0 ? 'every line removed' : `${plural(point.atRisk, 'line')} at risk`;
        return h(
          'li',
          { 'data-cohort': curve.cohort },
          lineKey(curve.cohort),
          h('strong', {}, formatSurvival(point.survival)),
          h('span', {}, `${label}, ${detail}`),
        );
      }),
    ),
  );
}

function legend(curves: readonly SurvivalCurve[]): HTMLElement {
  return h(
    'ul',
    { class: 'legend' },
    ...curves.map((curve) => h('li', {}, lineKey(curve.cohort), `${COHORT_LABEL[curve.cohort]}-written lines`)),
    h(
      'li',
      {},
      h('span', { class: 'line-key line-key-thin', 'aria-hidden': 'true' }),
      `Thin: fewer than ${THIN_AT_RISK} lines at risk, so noisy`,
    ),
  );
}

// Where each curve ends, in words: 0 is a result, while a curve above 0 is unknown past its end.
function notes(curves: readonly SurvivalCurve[]): HTMLElement {
  return h(
    'ul',
    { class: 'chart-notes' },
    ...curves.map((curve) => {
      const last = lastPoint(curve.points);
      if (last.survival === 0) {
        return h(
          'li',
          { 'data-cohort': curve.cohort, 'data-note': 'all-removed' },
          `Every ${COHORT_NOUN[curve.cohort]} line was removed: none lasted ${plural(last.day, 'full day')}.`,
        );
      }
      return h(
        'li',
        { 'data-cohort': curve.cohort, 'data-note': 'observed-until' },
        `${COHORT_LABEL[curve.cohort]} lines are observed up to day ${last.day}. Survival past that is ${NOT_OBSERVED}.`,
      );
    }),
  );
}

function tableView(curves: readonly SurvivalCurve[]): HTMLElement {
  return h(
    'details',
    { class: 'chart-table', 'data-keep-open': 'chart-table' },
    h('summary', {}, 'Show the curves as a table'),
    ...curves.map((curve) =>
      h(
        'table',
        { 'data-cohort': curve.cohort },
        h('caption', {}, `${COHORT_LABEL[curve.cohort]}-written lines`),
        h(
          'thead',
          {},
          h(
            'tr',
            {},
            h('th', { scope: 'col' }, 'From day'),
            h('th', { scope: 'col' }, 'Survival'),
            h('th', { scope: 'col' }, 'Lines at risk'),
          ),
        ),
        h(
          'tbody',
          {},
          ...curve.points.map((point) =>
            h(
              'tr',
              {},
              h('td', {}, String(point.day)),
              h('td', {}, formatSurvival(point.survival)),
              h('td', {}, String(point.atRisk)),
            ),
          ),
        ),
      ),
    ),
  );
}

function lineKey(cohort: MeasuredCohort): HTMLElement {
  return h('span', { class: `line-key line-key-${cohort}`, 'aria-hidden': 'true' });
}

function describe(curves: readonly SurvivalCurve[]): string {
  const parts = curves.map((curve) => {
    const last = lastPoint(curve.points);
    const label = COHORT_LABEL[curve.cohort];
    return last.survival === 0
      ? `${label}: 0% from day ${last.day}, every line removed.`
      : `${label}: ${formatSurvival(last.survival)} at day ${last.day}, the last day observed.`;
  });
  return `Survival curves. ${parts.join(' ')}`;
}

import type { SurvivalCurve } from '@code-trust/shared';
import {
  revertedSurvivalCurveFixture,
  survivalCurveFixture,
  youngSurvivalCurveFixture,
} from '@code-trust/shared/fixtures';
import { describe, expect, test } from 'vitest';
import { renderSurvivalChart } from './chart.ts';
import { axisEndDay, chartScales, DEFAULT_CHART_WIDTH } from './curve.ts';

type Segment = [x1: number, y1: number, x2: number, y2: number];

// Reads an SVG path's absolute M, L, H and V commands into straight segments. Any other command
// fails the test, so a curve drawn with curves or relative moves cannot slip past the checks.
function segments(d: string): Segment[] {
  const tokens = d.trim().split(/[\s,]+/);
  const out: Segment[] = [];
  let x = Number.NaN;
  let y = Number.NaN;
  for (let i = 0; i < tokens.length; ) {
    const command = tokens[i++];
    if (command === 'M') {
      x = Number(tokens[i++]);
      y = Number(tokens[i++]);
    } else if (command === 'L') {
      const nx = Number(tokens[i++]);
      const ny = Number(tokens[i++]);
      out.push([x, y, nx, ny]);
      [x, y] = [nx, ny];
    } else if (command === 'H') {
      const nx = Number(tokens[i++]);
      out.push([x, y, nx, y]);
      x = nx;
    } else if (command === 'V') {
      const ny = Number(tokens[i++]);
      out.push([x, y, x, ny]);
      y = ny;
    } else {
      throw new Error(`unexpected path command ${command} in "${d}"`);
    }
  }
  return out;
}

function curveSegments(chart: HTMLElement, cohort: string): Segment[] {
  const paths = [...chart.querySelectorAll(`g[data-cohort="${cohort}"] path`)];
  return paths.flatMap((path) => segments(path.getAttribute('d') ?? ''));
}

const scalesFor = (curves: SurvivalCurve[]) => chartScales(axisEndDay(curves), DEFAULT_CHART_WIDTH);

describe('the survival chart', () => {
  test('survivalCurveFixture draws as a step path with no diagonals that ends at its last point', () => {
    const curves = [survivalCurveFixture, youngSurvivalCurveFixture];
    const chart = renderSurvivalChart(curves);
    const { x, y, right } = scalesFor(curves);

    const ai = curveSegments(chart, 'ai');
    for (const [x1, y1, x2, y2] of ai) expect(x1 === x2 || y1 === y2).toBe(true);
    // Each value holds until the next point's day, then drops straight down on that day.
    expect(ai).toEqual([
      [x(0), y(1), x(11), y(1)],
      [x(11), y(1), x(11), y(0.8)],
      [x(11), y(0.8), x(46), y(0.8)],
      [x(46), y(0.8), x(61), y(0.8)],
      [x(61), y(0.8), x(61), y(0.64)],
      [x(61), y(0.64), x(200), y(0.64)],
    ]);
    // Nothing past day 200, on an axis that runs on to day 210.
    expect(Math.max(...ai.flatMap(([x1, , x2]) => [x1, x2]))).toBe(x(200));
    expect(x(200)).toBeLessThan(right);

    // The young human curve stops at day 60, where survival past it is unknown.
    expect(curveSegments(chart, 'human')).toEqual([
      [x(0), y(1), x(13), y(1)],
      [x(13), y(1), x(13), y(0.9)],
      [x(13), y(0.9), x(60), y(0.9)],
    ]);
    expect(chart.querySelector('[data-note="all-removed"]')).toBeNull();
    expect(chart.querySelector('[data-cohort="human"][data-note="observed-until"]')?.textContent).toBe(
      'Human lines are observed up to day 60. Survival past that is not observed yet.',
    );
  });

  test('runs with fewer than 10 lines at risk are drawn thin', () => {
    const chart = renderSurvivalChart([survivalCurveFixture, youngSurvivalCurveFixture]);
    const runs = (cohort: string) =>
      [...chart.querySelectorAll(`g[data-cohort="${cohort}"] path.run`)].map((run) => [
        run.getAttribute('data-at-risk'),
        run.classList.contains('run-thin'),
      ]);
    expect(runs('ai')).toEqual([
      ['10', false],
      ['8', true],
      ['5', true],
      ['4', true],
    ]);
    expect(runs('human')).toEqual([
      ['40', false],
      ['36', false],
    ]);
    // The count itself is in the table view, not only in the line's width.
    const rows = [...chart.querySelectorAll('table[data-cohort="ai"] tbody tr')].map((row) => row.textContent);
    expect(rows).toEqual(['0100%10', '1180%8', '4680%5', '6164%4', '20064%4']);
  });

  test('revertedSurvivalCurveFixture drops to 0 and says every line was removed', () => {
    const curves = [revertedSurvivalCurveFixture];
    const chart = renderSurvivalChart(curves);
    const { x, y, right } = scalesFor(curves);
    // 0 is a result and holds, so the curve runs on along 0 to the end of the axis.
    expect(curveSegments(chart, 'ai')).toEqual([
      [x(0), y(1), x(6), y(1)],
      [x(6), y(1), x(6), y(0)],
      [x(6), y(0), right, y(0)],
    ]);
    expect(chart.querySelector('[data-note="all-removed"]')?.textContent).toBe(
      'Every AI line was removed: none lasted 6 full days.',
    );
    expect(chart.querySelector('.end-label')?.textContent).toBe('AI 0%');
  });

  test('the tooltip reads "not observed yet" past a curve\'s last day and 0% after a curve reached 0', () => {
    const chart = renderSurvivalChart([revertedSurvivalCurveFixture, youngSurvivalCurveFixture]);
    const plot = chart.querySelector('svg');
    const press = (key: string) => plot?.dispatchEvent(new KeyboardEvent('keydown', { key }));
    const rows = () => [...chart.querySelectorAll('.chart-tooltip li')].map((row) => row.textContent);

    press('End');
    expect(chart.querySelector('.tooltip-day')?.textContent).toBe('Day 180');
    expect(rows()).toEqual(['0%AI, every line removed', 'not observed yetHuman']);

    press('Home');
    press('ArrowRight');
    expect(chart.querySelector('.tooltip-day')?.textContent).toBe('Day 6');
    expect(rows()).toEqual(['0%AI, every line removed', '100%Human, 40 lines at risk']);
  });
});

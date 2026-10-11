// Geometry for the survival chart. Pure functions, so the step-function rules are tested without a
// DOM. A curve is a step function (SurvivalCurvePointsSchema): a value holds until the next point,
// a curve that reaches 0 stays 0, and any other curve is unknown past its last point.
import {
  type MeasuredCohort,
  SURVIVAL_HORIZON_DAYS,
  type SurvivalCurve,
  type SurvivalCurvePoint,
} from '@code-trust/shared';

/** Below this many lines at risk, one removal moves the estimate by more than a tenth of its value. */
export const THIN_AT_RISK = 10;

export const COHORT_ORDER: readonly MeasuredCohort[] = ['ai', 'human'];
export const COHORT_LABEL: Record<MeasuredCohort, string> = { ai: 'AI', human: 'Human' };
/** The cohort as a word inside a sentence. */
export const COHORT_NOUN: Record<MeasuredCohort, string> = { ai: 'AI', human: 'human' };

export const CHART_HEIGHT = 280;
/** The width drawn before the chart is on the page and can be measured. */
export const DEFAULT_CHART_WIDTH = 640;
const MARGIN = { top: 16, right: 88, bottom: 44, left: 48 } as const;
const MIN_TICK_GAP_PX = 28;
const LAST_HORIZON_DAY = Math.max(...SURVIVAL_HORIZON_DAYS);

export function lastPoint(points: readonly SurvivalCurvePoint[]): SurvivalCurvePoint {
  const last = points[points.length - 1];
  // The schema guarantees the day 0 point, so this only fires on data that skipped parsing.
  if (last === undefined) throw new Error('a survival curve has at least its day 0 point');
  return last;
}

/**
 * The x axis reaches at least the last headline horizon and always runs past the last observed
 * day, so a curve that stops is seen to stop instead of meeting the edge of the chart.
 */
export function axisEndDay(curves: readonly SurvivalCurve[]): number {
  const lastDay = Math.max(0, ...curves.map((curve) => lastPoint(curve.points).day));
  return lastDay < LAST_HORIZON_DAY ? LAST_HORIZON_DAY : (Math.floor(lastDay / 30) + 1) * 30;
}

/** The step function's point in effect on `day`, or null where survival is not observed yet. */
export function pointAt(points: readonly SurvivalCurvePoint[], day: number): SurvivalCurvePoint | null {
  const last = lastPoint(points);
  if (day > last.day) return last.survival === 0 ? { ...last, day } : null;
  let found: SurvivalCurvePoint | null = null;
  for (const point of points) {
    if (point.day > day) break;
    found = point;
  }
  return found;
}

/** One point's stretch of the curve: the drop onto its value, then the value held. */
export interface StepRun {
  day: number;
  /** Where the run ends: the next point's day, the axis end once survival is 0, else its own day. */
  untilDay: number;
  /** The value before the step on `day`. */
  previous: number;
  survival: number;
  atRisk: number;
  /** Few lines at risk: drawn thin, because the estimate is noisy there. 0 at risk is an exact 0. */
  thin: boolean;
}

export function stepRuns(points: readonly SurvivalCurvePoint[], axisEnd: number): StepRun[] {
  return points.map((point, i) => {
    const next = points[i + 1];
    const previous = points[i - 1]?.survival ?? point.survival;
    const untilDay = next !== undefined ? next.day : point.survival === 0 ? axisEnd : point.day;
    return {
      day: point.day,
      untilDay,
      previous,
      survival: point.survival,
      atRisk: point.atRisk,
      thin: point.atRisk > 0 && point.atRisk < THIN_AT_RISK,
    };
  });
}

export interface Scales {
  width: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
  endDay: number;
  x(day: number): number;
  y(survival: number): number;
  /** The whole day nearest to an x position, kept on the axis. */
  dayAt(x: number): number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function chartScales(endDay: number, width: number): Scales {
  const left = MARGIN.left;
  const right = Math.max(left + 1, width - MARGIN.right);
  const top = MARGIN.top;
  const bottom = CHART_HEIGHT - MARGIN.bottom;
  return {
    width,
    left,
    right,
    top,
    bottom,
    endDay,
    x: (day) => round2(left + (day / endDay) * (right - left)),
    // Fixed at 0 to 100%, so 0 is always the baseline and a small change is never blown up.
    y: (survival) => round2(top + (1 - survival) * (bottom - top)),
    dayAt: (x) => Math.min(endDay, Math.max(0, Math.round(((x - left) / (right - left)) * endDay))),
  };
}

/** A run as horizontal and vertical moves only: a step function has no diagonals. Null when empty. */
export function runPath(run: StepRun, scales: Scales): string | null {
  const parts = [`M ${scales.x(run.day)} ${scales.y(run.previous)}`];
  if (run.previous !== run.survival) parts.push(`V ${scales.y(run.survival)}`);
  if (run.untilDay > run.day) parts.push(`H ${scales.x(run.untilDay)}`);
  return parts.length > 1 ? parts.join(' ') : null;
}

/** Day 0, the headline horizons and the axis end, leaving out a tick that would crowd the one before. */
export function xTicks(scales: Scales): number[] {
  const ticks: number[] = [];
  for (const day of [0, ...SURVIVAL_HORIZON_DAYS, scales.endDay]) {
    const previous = ticks[ticks.length - 1];
    if (previous !== undefined && (day <= previous || scales.x(day) - scales.x(previous) < MIN_TICK_GAP_PX)) continue;
    ticks.push(day);
  }
  return ticks;
}

/** The days the keyboard steps through: every point of every curve, and the axis end. */
export function stopDays(curves: readonly SurvivalCurve[], axisEnd: number): number[] {
  const days = new Set([0, axisEnd, ...curves.flatMap((curve) => curve.points.map((point) => point.day))]);
  return [...days].sort((a, b) => a - b);
}

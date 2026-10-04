// The Kaplan-Meier estimator on whole days, as the Metric definitions in docs/architecture.md state
// it. It works over the distinct lifetimes, not day by day, so a repository's age costs nothing.
import type { IsoTimestamp, SurvivalCurvePoint, SurvivalMetric, SurvivalObservation } from '@code-trust/shared';

const DAY_MS = 86_400_000;

export type SurvivalEstimate = Pick<
  SurvivalMetric,
  'linesTotal' | 'linesRemoved' | 'linesCensored' | 'survival30d' | 'survival90d' | 'survival180d'
> & { points: SurvivalCurvePoint[] };

/** One cohort's observations in, its numbers out. Null when the cohort has no lines. */
export function estimateSurvival(
  observations: readonly Pick<SurvivalObservation, 'lineCount' | 'introducedAt' | 'removedAt'>[],
  observedAt: IsoTimestamp,
): SurvivalEstimate | null {
  // Per whole-day lifetime T: the lines that leave the risk set after day T, and how many of them
  // were removed rather than censored.
  const byLifetime = new Map<number, { leaving: number; removed: number }>();
  let linesRemoved = 0;
  let linesCensored = 0;
  for (const observation of observations) {
    const { lineCount, introducedAt, removedAt } = observation;
    if (!Number.isInteger(lineCount) || lineCount < 1) throw new RangeError(`not a line count: ${lineCount}`);
    const end = removedAt ?? observedAt;
    // Clock skew can put the end before the start; that lifetime counts as 0.
    const lifetime = Math.max(0, Math.floor((parseTime(end) - parseTime(introducedAt)) / DAY_MS));
    const tally = byLifetime.get(lifetime) ?? { leaving: 0, removed: 0 };
    tally.leaving += lineCount;
    if (removedAt === null) linesCensored += lineCount;
    else {
      tally.removed += lineCount;
      linesRemoved += lineCount;
    }
    byLifetime.set(lifetime, tally);
  }
  const linesTotal = linesRemoved + linesCensored;
  if (linesTotal === 0) return null;

  // S and n_k change only on the day after a lifetime, so those days and day 0 are the points.
  const points: SurvivalCurvePoint[] = [{ day: 0, survival: 1, atRisk: linesTotal }];
  let survival = 1;
  let atRisk = linesTotal;
  for (const [lifetime, { leaving, removed }] of [...byLifetime].sort(([a], [b]) => a - b)) {
    // The factor exactly as the definition writes it, so nothing is rounded: 0 only when every
    // line at risk was removed, which also leaves nothing at risk.
    const next = survival * (1 - removed / atRisk);
    if (atRisk > leaving) {
      survival = next;
      atRisk -= leaving;
      points.push({ day: lifetime + 1, survival, atRisk });
    } else if (next === 0) {
      points.push({ day: lifetime + 1, survival: 0, atRisk: 0 });
    } else if ((points.at(-1)?.day ?? 0) < lifetime) {
      // The longest-lived lines are still alive: end on the last day with lines at risk.
      points.push({ day: lifetime, survival, atRisk });
    }
  }

  return {
    linesTotal,
    linesRemoved,
    linesCensored,
    survival30d: survivalAt(points, 30),
    survival90d: survivalAt(points, 90),
    survival180d: survivalAt(points, 180),
    points,
  };
}

/** S(day) read off the step function: 0 past a curve that reached 0, unknown past any other. */
function survivalAt(points: readonly SurvivalCurvePoint[], day: number): number | null {
  const last = points.at(-1);
  if (last === undefined) return null;
  if (day > last.day) return last.survival === 0 ? 0 : null;
  return points.findLast((point) => point.day <= day)?.survival ?? null;
}

function parseTime(timestamp: IsoTimestamp): number {
  const ms = Date.parse(timestamp);
  if (Number.isNaN(ms)) throw new RangeError(`not a timestamp: ${timestamp}`);
  return ms;
}

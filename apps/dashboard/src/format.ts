// How numbers and dates read on the page. Null versus 0 is the metric's sharpest rule: 0 means
// every line was removed, null means no line has been observed that long. Arithmetic turns null
// into 0 (`null * 100`, `Math.round(null)`), so null is branched on before any arithmetic.

export const NOT_OBSERVED = 'not observed yet';
export const NOT_ANALYZED = 'not analyzed yet';

const DAY_MS = 86_400_000;

export function formatSurvival(value: number | null): string {
  if (value === null) return NOT_OBSERVED;
  if (value === 0) return '0%';
  if (value === 1) return '100%';
  const percent = value * 100;
  // Plain rounding would print 0.004 as "0%", which reads as "every line was removed".
  if (percent < 0.5) return '<1%';
  if (percent >= 99.5) return '>99%';
  return `${Math.round(percent)}%`;
}

// UTC, so a date reads the same for every viewer and in every test run.
const dateFormat = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' });
const dateTimeFormat = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium',
  timeStyle: 'short',
  hourCycle: 'h23',
  timeZone: 'UTC',
});

export const formatDate = (iso: string): string => dateFormat.format(new Date(iso));

export const formatDateTime = (iso: string): string => `${dateTimeFormat.format(new Date(iso))} UTC`;

/** The viewer's local clock time, for when the page last refreshed. */
export const formatClock = (ms: number): string =>
  new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export const shortSha = (sha: string): string => sha.slice(0, 7);

export const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;

/** How long before the observation the repo last changed. A long gap means its code survives by default. */
export function describeLastActivityGap(headCommittedAt: string, observedAt: string): string {
  const days = Math.floor((Date.parse(observedAt) - Date.parse(headCommittedAt)) / DAY_MS);
  if (days < 1) return 'less than a day before it was observed';
  return `${plural(days, 'day')} before it was observed`;
}

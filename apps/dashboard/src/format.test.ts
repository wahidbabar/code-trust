import { describe, expect, test } from 'vitest';
import { describeLastActivityGap, formatDate, formatDateTime, formatSurvival, NOT_OBSERVED } from './format.ts';

describe('formatSurvival', () => {
  test('null is "not observed yet", and 0 is 0%', () => {
    expect(formatSurvival(null)).toBe(NOT_OBSERVED);
    expect(formatSurvival(0)).toBe('0%');
  });

  test('a share rounds to a whole percent', () => {
    expect(formatSurvival(0.8)).toBe('80%');
    expect(formatSurvival(0.64)).toBe('64%');
    expect(formatSurvival(1)).toBe('100%');
  });

  test('a survival below 0.5% renders as <1%, not 0%, and one just under 1 as >99%, not 100%', () => {
    expect(formatSurvival(0.004)).toBe('<1%');
    expect(formatSurvival(0.0001)).toBe('<1%');
    expect(formatSurvival(0.996)).toBe('>99%');
    expect(formatSurvival(0.995)).toBe('>99%');
    expect(formatSurvival(0.005)).toBe('1%');
  });
});

describe('dates', () => {
  test('read in UTC, the same for every viewer', () => {
    expect(formatDate('2026-09-29T23:30:00.000Z')).toBe('Sep 29, 2026');
    expect(formatDateTime('2026-10-01T00:00:00.000Z')).toBe('Oct 1, 2026, 00:00 UTC');
  });

  test('the last activity is placed relative to the observation', () => {
    expect(describeLastActivityGap('2026-09-29T00:00:00.000Z', '2026-10-01T00:00:00.000Z')).toBe(
      '2 days before it was observed',
    );
    expect(describeLastActivityGap('2026-09-30T00:00:00.000Z', '2026-10-01T00:00:00.000Z')).toBe(
      '1 day before it was observed',
    );
    expect(describeLastActivityGap('2026-09-30T18:00:00.000Z', '2026-10-01T00:00:00.000Z')).toBe(
      'less than a day before it was observed',
    );
  });
});

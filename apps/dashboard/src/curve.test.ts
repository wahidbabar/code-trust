import {
  revertedSurvivalCurveFixture,
  survivalCurveFixture,
  youngSurvivalCurveFixture,
} from '@code-trust/shared/fixtures';
import { describe, expect, test } from 'vitest';
import { axisEndDay, chartScales, pointAt, stopDays, xTicks } from './curve.ts';

describe('pointAt', () => {
  const points = survivalCurveFixture.points;

  test("holds each value until the next point's day", () => {
    expect(pointAt(points, 0)?.survival).toBe(1);
    expect(pointAt(points, 10)?.survival).toBe(1);
    expect(pointAt(points, 11)?.survival).toBe(0.8);
    expect(pointAt(points, 60)?.survival).toBe(0.8);
    expect(pointAt(points, 60)?.atRisk).toBe(5);
    expect(pointAt(points, 61)?.survival).toBe(0.64);
    expect(pointAt(points, 200)?.survival).toBe(0.64);
  });

  test('is unknown past the last point of a curve above 0, and stays 0 after a curve reached 0', () => {
    expect(pointAt(points, 201)).toBeNull();
    expect(pointAt(youngSurvivalCurveFixture.points, 61)).toBeNull();
    expect(pointAt(revertedSurvivalCurveFixture.points, 5)?.survival).toBe(1);
    expect(pointAt(revertedSurvivalCurveFixture.points, 6)?.survival).toBe(0);
    expect(pointAt(revertedSurvivalCurveFixture.points, 500)).toMatchObject({ survival: 0, atRisk: 0 });
  });
});

describe('axisEndDay', () => {
  test('reaches the 180 day horizon and always runs past the last observed day', () => {
    expect(axisEndDay([youngSurvivalCurveFixture])).toBe(180);
    expect(axisEndDay([revertedSurvivalCurveFixture])).toBe(180);
    expect(axisEndDay([survivalCurveFixture, youngSurvivalCurveFixture])).toBe(210);
    const lastDayOn180 = {
      cohort: 'ai' as const,
      points: [
        { day: 0, survival: 1, atRisk: 3 },
        { day: 180, survival: 1, atRisk: 3 },
      ],
    };
    expect(axisEndDay([lastDayOn180])).toBe(210);
  });
});

test('ticks keep day 0, the horizons and the end unless they would crowd each other', () => {
  expect(xTicks(chartScales(210, 640))).toEqual([0, 30, 90, 180, 210]);
  expect(xTicks(chartScales(180, 640))).toEqual([0, 30, 90, 180]);
  // Three years of history squeezes day 30 next to day 0.
  expect(xTicks(chartScales(1110, 640))).toEqual([0, 90, 180, 1110]);
});

test('the keyboard stops on every point and the axis end', () => {
  expect(stopDays([survivalCurveFixture, youngSurvivalCurveFixture], 210)).toEqual([0, 11, 13, 46, 60, 61, 200, 210]);
});

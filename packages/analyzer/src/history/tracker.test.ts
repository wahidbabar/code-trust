import { describe, expect, test } from 'vitest';
import type { Hunk } from './log-parser.ts';
import { BLANK, LineTracker, linesFromFlags, TrackerError } from './tracker.ts';

const hunk = (oldStart: number, oldCount: number, newStart: number, added: number[]): Hunk => ({
  oldStart,
  oldCount,
  newStart,
  newCount: added.length,
  added: Uint8Array.from(added),
});

const owner = (value: number) => () => value;

describe('LineTracker.apply', () => {
  test('inserts at the top and the end, replaces and deletes in the middle, and counts only non-blank removals', () => {
    const tracker = new LineTracker();
    const old = Int32Array.from([1, BLANK, 1, 2, 2]);

    const next = tracker.apply(
      old,
      [hunk(0, 0, 1, [1]), hunk(2, 2, 3, [1, 0]), hunk(5, 0, 7, [1])],
      9,
      owner(7),
      'test',
    );

    expect([...next]).toEqual([7, 1, 7, BLANK, 2, 2, 7]);
    expect(tracker.removals).toEqual(new Map([[1, new Map([[9, 1]])]]));
  });

  test('deletes to an empty file and builds a new one from an empty array', () => {
    const tracker = new LineTracker();
    expect([...tracker.apply(Int32Array.from([3, 3]), [hunk(1, 2, 0, [])], 4, owner(0), 'test')]).toEqual([]);
    expect([...tracker.apply(new Int32Array(0), [hunk(0, 0, 1, [1, 0, 1])], 4, owner(5), 'test')]).toEqual([
      5,
      BLANK,
      5,
    ]);
    expect(tracker.removals.get(3)?.get(4)).toBe(2);
  });

  test('passes each added line its new line number', () => {
    const lines = new LineTracker().apply(
      Int32Array.from([1, 1]),
      [hunk(1, 0, 2, [1, 1])],
      0,
      (line) => line * 10,
      't',
    );
    expect([...lines]).toEqual([1, 20, 30, 1]);
  });

  test('throws when a hunk does not fit the file, instead of drifting', () => {
    const tracker = new LineTracker();
    expect(() => tracker.apply(Int32Array.from([1]), [hunk(2, 1, 2, [])], 0, owner(0), 't')).toThrow(TrackerError);
    expect(() => tracker.apply(Int32Array.from([1, 1]), [hunk(1, 1, 2, [1])], 0, owner(0), 't')).toThrow(
      /expected at line 1/,
    );
    expect(() =>
      tracker.apply(Int32Array.from([1, 1, 1]), [hunk(2, 1, 2, [1]), hunk(1, 1, 1, [1])], 0, owner(0), 't'),
    ).toThrow(TrackerError);
  });
});

test('aliveCounts and linesFromFlags skip blank lines', () => {
  const tracker = new LineTracker();
  tracker.files.set(
    'a',
    linesFromFlags(Uint8Array.from([1, 0, 1]), (line) => line),
  );
  tracker.files.set('b', Int32Array.from([3, BLANK]));
  expect(tracker.aliveCounts()).toEqual(
    new Map([
      [1, 1],
      [3, 2],
    ]),
  );
});

// Line records per file. A line is one Int32 in its file's array: the index of the commit that
// introduced it, or BLANK. Nothing is kept for a line once it is removed except one count per
// (introducer, remover) pair, so memory follows the size of the tree, not of the history.
import type { Hunk } from './log-parser.ts';

/** A blank or whitespace-only line: it holds a position but is never counted. */
export const BLANK = -1;

/** Returns the owner for a line added at `newLine` (1-based, in the new version of the file). */
export type OwnerAt = (newLine: number) => number;

export class TrackerError extends Error {
  constructor(message: string) {
    super(`line tracking failed: ${message}`);
    this.name = 'TrackerError';
  }
}

export class LineTracker {
  /** Every measured text file at the current mainline commit, empty files included. */
  readonly files = new Map<string, Int32Array>();
  /** introducer commit index, then remover mainline index, then line count. */
  readonly removals = new Map<number, Map<number, number>>();

  /** Counts every non-blank line of `lines` as removed by `remover`. */
  removeAll(lines: Int32Array, remover: number): void {
    this.countRemovals(lines, 0, lines.length, remover);
  }

  /**
   * Applies `-U0` hunks to a file's lines and returns the new array. Removed lines are counted
   * against `remover`; added lines get `ownerAt(line)`, or BLANK when blank. Every hunk is checked
   * against the old array's bounds and the new side's numbering, so a parse or state error throws
   * instead of drifting.
   */
  apply(old: Int32Array, hunks: readonly Hunk[], remover: number, nonBlankOwner: OwnerAt, label: string): Int32Array {
    let length = old.length;
    for (const hunk of hunks) length += hunk.newCount - hunk.oldCount;
    if (length < 0) throw new TrackerError(`${label}: the hunks remove more lines than the file has`);
    const next = new Int32Array(length);
    let oldPos = 0;
    let newPos = 0;
    for (const hunk of hunks) {
      // With a zero count, git names the line before the change, so the change starts right after it.
      const oldStart = hunk.oldCount === 0 ? hunk.oldStart : hunk.oldStart - 1;
      const newStart = hunk.newCount === 0 ? hunk.newStart : hunk.newStart - 1;
      if (oldStart < oldPos || oldStart + hunk.oldCount > old.length) {
        throw new TrackerError(
          `${label}: hunk -${hunk.oldStart},${hunk.oldCount} is outside a ${old.length}-line file`,
        );
      }
      next.set(old.subarray(oldPos, oldStart), newPos);
      newPos += oldStart - oldPos;
      if (newPos !== newStart) {
        throw new TrackerError(`${label}: hunk +${hunk.newStart},${hunk.newCount} expected at line ${newPos + 1}`);
      }
      this.countRemovals(old, oldStart, oldStart + hunk.oldCount, remover);
      for (let i = 0; i < hunk.newCount; i++) {
        next[newPos + i] = hunk.added[i] === 1 ? nonBlankOwner(newStart + i + 1) : BLANK;
      }
      newPos += hunk.newCount;
      oldPos = oldStart + hunk.oldCount;
    }
    next.set(old.subarray(oldPos), newPos);
    return next;
  }

  /** Lines alive now: introducer commit index to line count. */
  aliveCounts(): Map<number, number> {
    const alive = new Map<number, number>();
    for (const lines of this.files.values()) {
      for (const owner of lines) {
        if (owner !== BLANK) alive.set(owner, (alive.get(owner) ?? 0) + 1);
      }
    }
    return alive;
  }

  private countRemovals(lines: Int32Array, start: number, end: number, remover: number): void {
    for (const owner of lines.subarray(start, end)) {
      if (owner === BLANK) continue;
      let byRemover = this.removals.get(owner);
      if (!byRemover) {
        byRemover = new Map();
        this.removals.set(owner, byRemover);
      }
      byRemover.set(remover, (byRemover.get(remover) ?? 0) + 1);
    }
  }
}

/** Lines of a whole new file: `nonBlank[i]` is 1 for a line with content. */
export function linesFromFlags(nonBlank: Uint8Array, nonBlankOwner: OwnerAt): Int32Array {
  const lines = new Int32Array(nonBlank.length);
  for (let i = 0; i < nonBlank.length; i++) lines[i] = nonBlank[i] === 1 ? nonBlankOwner(i + 1) : BLANK;
  return lines;
}

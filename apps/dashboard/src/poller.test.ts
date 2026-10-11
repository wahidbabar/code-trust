import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { FRESH_FOR_MS, POLL_INTERVAL_MS, type Poller, startPoller } from './poller.ts';
import { restoreVisibility, setVisibility, stubVisibility } from './testing.ts';

const HOUR_MS = 60 * 60_000;

let poller: Poller | undefined;
let load: ReturnType<typeof vi.fn<() => Promise<void>>>;

beforeEach(() => {
  vi.useFakeTimers();
  stubVisibility('visible');
  load = vi.fn(async () => undefined);
});

afterEach(() => {
  poller?.stop();
  poller = undefined;
  restoreVisibility();
  vi.useRealTimers();
});

describe('polling', () => {
  test('a visible tab fetches again after 10 minutes and not before', async () => {
    poller = startPoller(load);
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS - 1);
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(load).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(load).toHaveBeenCalledTimes(3);
  });

  test('a hidden tab never fetches', async () => {
    // Opened in a background tab: not even the first load runs.
    stubVisibility('hidden');
    poller = startPoller(load);
    await vi.advanceTimersByTimeAsync(HOUR_MS);
    expect(load).not.toHaveBeenCalled();

    // Shown, then hidden again before its next poll: polling stops with it, and no timer is left
    // to wake the hidden tab.
    setVisibility('visible');
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS / 2);
    setVisibility('hidden');
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(HOUR_MS);
    expect(load).toHaveBeenCalledTimes(1);

    // Not even a retry fetches while hidden.
    poller.refresh();
    expect(load).toHaveBeenCalledTimes(1);
  });

  test('becoming visible refetches when the data is more than a minute old', async () => {
    poller = startPoller(load);
    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(FRESH_FOR_MS + 1);
    setVisibility('visible');
    expect(load).toHaveBeenCalledTimes(2);
  });

  test('becoming visible does not refetch when the data is a minute old or newer', async () => {
    poller = startPoller(load);
    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(FRESH_FOR_MS / 2);
    setVisibility('visible');
    expect(load).toHaveBeenCalledTimes(1);

    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(FRESH_FOR_MS / 2);
    setVisibility('visible');
    expect(load).toHaveBeenCalledTimes(1);

    // The next poll keeps its turn, 10 minutes after the last fetch started.
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS - FRESH_FOR_MS - 1);
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(load).toHaveBeenCalledTimes(2);
  });

  test('a failed load still schedules the next poll, and a running load is never started twice', async () => {
    let fail: (() => void) | undefined;
    load.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          fail = () => reject(new Error('503'));
        }),
    );
    poller = startPoller(load);
    poller.refresh();
    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(2 * FRESH_FOR_MS);
    setVisibility('visible');
    expect(load).toHaveBeenCalledTimes(1);

    fail?.();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS - 2 * FRESH_FOR_MS);
    expect(load).toHaveBeenCalledTimes(2);
  });

  test('a view that already has fresh data waits for its turn instead of fetching on start', async () => {
    poller = startPoller(load, { lastStartedAt: Date.now() - FRESH_FOR_MS / 2 });
    expect(load).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS - FRESH_FOR_MS / 2);
    expect(load).toHaveBeenCalledTimes(1);
  });

  test('stop ends polling', async () => {
    poller = startPoller(load);
    poller.stop();
    setVisibility('hidden');
    setVisibility('visible');
    await vi.advanceTimersByTimeAsync(HOUR_MS);
    expect(load).toHaveBeenCalledTimes(1);
  });
});

// Refreshes the open view. Neon's free plan has 100 CU-hours a month and suspends its compute
// after 5 idle minutes, so a 1 minute poll from one open tab would keep it awake around the
// clock, while metrics only change when a push is analyzed. So: every 10 minutes, and never
// while the tab is hidden.

export const POLL_INTERVAL_MS = 10 * 60_000;
/** Data requested less than this long ago is not refetched when the tab becomes visible again. */
export const FRESH_FOR_MS = 60_000;

type VisibilityDocument = Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>;

export interface PollerOptions {
  intervalMs?: number;
  freshForMs?: number;
  /** When the data already on screen was requested, so it is not refetched while still fresh. */
  lastStartedAt?: number;
  doc?: VisibilityDocument;
  now?: () => number;
}

export interface Poller {
  /** Loads now, unless a load is running or the tab is hidden. */
  refresh(): void;
  stop(): void;
}

/**
 * Starts polling `load`. Each poll is timed from when the previous one started, and the next is
 * scheduled only once it settles, so polls never overlap. Data age is measured from the last
 * request, good or failed, so a failing API is retried at most once a minute as the tab comes back.
 */
export function startPoller(load: () => Promise<void>, options: PollerOptions = {}): Poller {
  const intervalMs = options.intervalMs ?? POLL_INTERVAL_MS;
  const freshForMs = options.freshForMs ?? FRESH_FOR_MS;
  const doc = options.doc ?? document;
  const now = options.now ?? (() => Date.now());
  let lastStartedAt = options.lastStartedAt;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let loading = false;
  let stopped = false;

  const visible = () => doc.visibilityState === 'visible';

  const cancel = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };

  const scheduleNext = () => {
    cancel();
    if (stopped || !visible() || lastStartedAt === undefined) return;
    timer = setTimeout(run, Math.max(0, lastStartedAt + intervalMs - now()));
  };

  function run(): void {
    cancel();
    if (stopped || loading || !visible()) return;
    loading = true;
    lastStartedAt = now();
    // `load` reports its own failures to the view; the poller only needs to know it settled.
    load()
      .catch(() => undefined)
      .finally(() => {
        loading = false;
        scheduleNext();
      });
  }

  // On start and on becoming visible: stale data is refetched now, fresh data waits for its turn.
  function wake(): void {
    if (stopped || loading || !visible()) return;
    if (lastStartedAt === undefined || now() - lastStartedAt > freshForMs) run();
    else scheduleNext();
  }

  const onVisibilityChange = () => {
    if (visible()) wake();
    else cancel();
  };

  doc.addEventListener('visibilitychange', onVisibilityChange);
  wake();

  return {
    refresh: run,
    stop() {
      stopped = true;
      cancel();
      doc.removeEventListener('visibilitychange', onVisibilityChange);
    },
  };
}

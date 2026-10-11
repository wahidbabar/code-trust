// Routing and the open view's lifecycle. Hash routes, because GitHub Pages serves files and cannot
// rewrite a path to index.html.
import { GithubIdSchema } from '@code-trust/shared';
import { type ApiClient, ApiError } from './api.ts';
import { loadRepoList, loadRepoView } from './load.ts';
import { type Poller, startPoller } from './poller.ts';
import { renderListView, renderRepoView, renderUnknownRoute, type ViewActions, type ViewState } from './views.ts';

export type Route = { name: 'list' } | { name: 'repo'; repoId: number } | { name: 'unknown' };

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, '') || '/';
  if (path === '/') return { name: 'list' };
  // Digits only with no leading zero, the API's own rule, so nothing else ever reaches a request URL.
  const match = /^\/repos\/([1-9][0-9]*)$/.exec(path);
  const repoId = GithubIdSchema.safeParse(Number(match?.[1]));
  return match && repoId.success ? { name: 'repo', repoId: repoId.data } : { name: 'unknown' };
}

const routeKey = (route: Route): string => (route.name === 'repo' ? `repo/${route.repoId}` : route.name);

export interface AppOptions {
  root: HTMLElement;
  client: ApiClient;
  win?: Pick<Window, 'location' | 'addEventListener' | 'removeEventListener'>;
  doc?: Document;
  now?: () => number;
}

interface CacheEntry<T> {
  state: ViewState<T>;
  startedAt: number;
}

export function mountApp(options: AppOptions): { destroy(): void } {
  const { root, client } = options;
  const win = options.win ?? window;
  const doc = options.doc ?? document;
  const now = options.now ?? (() => Date.now());
  // The last state of each view visited, so going back shows it at once and refetches only if it is stale.
  const cache = new Map<string, CacheEntry<unknown>>();
  let currentKey: string | undefined;
  let stopView: (() => void) | undefined;

  const paint = (key: string, view: HTMLElement) => {
    // Keep open what the reader opened, such as the table view, across a refresh of the same view.
    if (root.dataset.view === key) {
      const open = new Set(
        [...root.querySelectorAll('details[open][data-keep-open]')].map((d) => d.getAttribute('data-keep-open')),
      );
      for (const details of view.querySelectorAll('details[data-keep-open]')) {
        if (open.has(details.getAttribute('data-keep-open'))) details.setAttribute('open', '');
      }
    }
    root.dataset.view = key;
    root.replaceChildren(view);
  };

  function startView<T>(
    key: string,
    load: (signal: AbortSignal) => Promise<T>,
    render: (state: ViewState<T>, actions: ViewActions) => HTMLElement,
    title: (state: ViewState<T>) => string,
  ): () => void {
    const cached = cache.get(key) as CacheEntry<T> | undefined;
    let state: ViewState<T> = cached?.state ?? { status: 'loading' };
    let request: AbortController | undefined;
    let stopped = false;
    let poller: Poller | undefined;
    const actions: ViewActions = { retry: () => poller?.refresh() };

    const show = () => {
      if (stopped) return;
      doc.title = title(state);
      paint(key, render(state, actions));
    };

    const refresh = async () => {
      request?.abort();
      const current = new AbortController();
      request = current;
      const startedAt = now();
      // The previous render stays up, dimmed, while the refresh runs: no skeleton, no jump.
      if (state.status === 'ready') root.firstElementChild?.classList.add('is-refreshing');
      try {
        const data = await load(current.signal);
        if (current.signal.aborted) return;
        state = { status: 'ready', data, fetchedAt: startedAt, stale: null };
      } catch (error) {
        if (current.signal.aborted) return;
        state = afterFailure(state, error instanceof Error ? error : new Error(String(error)), now());
      }
      cache.set(key, { state, startedAt });
      show();
    };

    show();
    poller = startPoller(refresh, { doc, now, ...(cached ? { lastStartedAt: cached.startedAt } : {}) });
    return () => {
      stopped = true;
      poller?.stop();
      request?.abort();
    };
  }

  const open = () => {
    const route = parseRoute(win.location.hash);
    const key = routeKey(route);
    // Browsers and test doubles can both report one navigation; the second is a no-op.
    if (key === currentKey) return;
    currentKey = key;
    stopView?.();
    if (route.name === 'unknown') {
      stopView = undefined;
      doc.title = 'Not found · code-trust';
      paint(key, renderUnknownRoute());
    } else if (route.name === 'list') {
      stopView = startView(
        key,
        (signal) => loadRepoList(client, signal),
        renderListView,
        () => 'code-trust',
      );
    } else {
      stopView = startView(
        key,
        (signal) => loadRepoView(client, route.repoId, signal),
        (state, actions) => renderRepoView(route.repoId, state, actions),
        (state) => {
          if (state.status !== 'ready') return `Repository ${route.repoId} · code-trust`;
          const repo = state.data.kind === 'analyzed' ? state.data.summary.repo : state.data.repo;
          return `${repo.owner}/${repo.name} · code-trust`;
        },
      );
    }
  };

  win.addEventListener('hashchange', open);
  open();
  return {
    destroy() {
      win.removeEventListener('hashchange', open);
      stopView?.();
      currentKey = undefined;
    },
  };
}

function afterFailure<T>(state: ViewState<T>, error: Error, at: number): ViewState<T> {
  // A 404 means the repo is gone: made private, deleted or uninstalled. Its old data must not stay up.
  if (error instanceof ApiError && error.kind === 'not_found') return { status: 'not_found' };
  if (state.status === 'ready') return { ...state, stale: { error, failedAt: at } };
  return { status: 'error', error };
}

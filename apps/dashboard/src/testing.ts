// Test doubles shared by the dashboard's tests. Nothing in the site imports this file.
import { vi } from 'vitest';

let visibility: DocumentVisibilityState = 'visible';

/** Replaces document.visibilityState with a value the test controls. Undo with restoreVisibility. */
export function stubVisibility(initial: DocumentVisibilityState = 'visible'): void {
  visibility = initial;
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
}

/** Sets the visibility and fires `visibilitychange`, as a browser does when the tab is switched. */
export function setVisibility(next: DocumentVisibilityState): void {
  visibility = next;
  document.dispatchEvent(new Event('visibilitychange'));
}

export function restoreVisibility(): void {
  Reflect.deleteProperty(document, 'visibilityState');
}

/**
 * A Response with only what the client reads. A real Response reads its body through streams,
 * which do not always settle under fake timers.
 */
export function fakeResponse(body: unknown, status = 200): Response {
  const response: Pick<Response, 'ok' | 'status' | 'json'> = {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
  return response as Response;
}

export function notJsonResponse(): Response {
  const response: Pick<Response, 'ok' | 'status' | 'json'> = {
    ok: true,
    status: 200,
    json: async () => {
      throw new SyntaxError('Unexpected token < in JSON at position 0');
    },
  };
  return response as Response;
}

type Handler = () => Response | Promise<Response>;

/**
 * Replaces the global fetch, the one the site's client calls by default, with a router over exact
 * URLs. Every URL requested is recorded, and an unknown one fails the request like a network error.
 */
export function stubFetch(routes: Record<string, Handler>): string[] {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      calls.push(String(input));
      const handler = routes[String(input)];
      if (handler === undefined) throw new TypeError(`no route for ${String(input)}`);
      return handler();
    }),
  );
  return calls;
}

/** Lets pending promise chains (fetch, parse, render) run to the end without moving the clock. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(0);
}

// Dev server and build for the dashboard. Tests use vitest.config.ts, so nothing here runs in CI's
// test step.
import { defineConfig, loadEnv, type Plugin } from 'vite';

// The API's own fallback is 3000 when CONDUCTOR_PORT is unset (apps/api/src/main.ts).
const apiPort = Number(process.env.CONDUCTOR_PORT || 3000);

export default defineConfig(({ command, mode }) => {
  const { VITE_API_URL = '' } = loadEnv(mode, import.meta.dirname, 'VITE_');
  return {
    // A project site: https://wahidbabar.github.io/code-trust/.
    base: '/code-trust/',
    server: {
      // Loopback only, like the API, and a fixed port so it never drifts into a sibling worktree's range.
      host: '127.0.0.1',
      port: apiPort + 1,
      strictPort: true,
      // Same origin in dev, so no CORS. 127.0.0.1 and not localhost, which can resolve to ::1 while
      // the API listens on IPv4 loopback only. Vite runs the proxy before the base path, so `/api`
      // works at the root while the page is served under /code-trust/.
      proxy: {
        '/api': { target: `http://127.0.0.1:${apiPort}`, rewrite: (path) => path.replace(/^\/api/, '') },
      },
    },
    preview: { host: '127.0.0.1', port: apiPort + 2, strictPort: true },
    plugins: command === 'build' ? [contentSecurityPolicy(apiOrigin(VITE_API_URL))] : [],
  };
});

function apiOrigin(url: string): string {
  if (!url) throw new Error('VITE_API_URL must be set to the CodeTrustApi Function URL to build the site');
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`VITE_API_URL is not a URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`VITE_API_URL must be an https URL, not ${url}`);
  return parsed.origin;
}

// The browser itself enforces that the page talks to the API and nothing else. Build only: in dev
// it would block Vite's own websocket and injected styles.
function contentSecurityPolicy(apiOrigin: string): Plugin {
  const policy = [
    "default-src 'self'",
    `connect-src ${apiOrigin}`,
    "img-src 'self'",
    "style-src 'self'",
    "script-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
  return {
    name: 'code-trust-csp',
    apply: 'build',
    transformIndexHtml: () => [
      { tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: policy }, injectTo: 'head-prepend' },
    ],
  };
}

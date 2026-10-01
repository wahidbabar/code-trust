import { defineConfig } from 'vitest/config';

// One project per workspace package, so a root `pnpm test` and a per-package `vitest run`
// (what verify:changed uses) discover the same tests.
export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/*', 'infra'],
  },
});

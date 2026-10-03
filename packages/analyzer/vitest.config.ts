import { defineConfig } from 'vitest/config';

// The tests build real git repositories, and each one spawns dozens of git processes. Under the
// full verify every package runs at once, so the defaults (5 s per test, 10 s per hook) are too tight.
export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});

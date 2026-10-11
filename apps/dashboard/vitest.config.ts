import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts, whose build step requires VITE_API_URL and whose dev server needs a port.
export default defineConfig({
  test: {
    environment: 'happy-dom',
  },
});

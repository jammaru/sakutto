import { resolve } from 'node:path';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';

// Some harnesses set GIT_CONFIG_COUNT without its matching GIT_CONFIG_KEY_0. Git then rejects
// every subprocess with "missing config key" before release/fixture tests reach the branch
// code. Drop only that incomplete command-line config block for the test process.
if (process.env.GIT_CONFIG_COUNT && !process.env.GIT_CONFIG_KEY_0) {
  delete process.env.GIT_CONFIG_COUNT;
  for (const key of Object.keys(process.env)) {
    if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/u.test(key)) delete process.env[key];
  }
}

export default defineConfig({
  plugins: [svelte({ configFile: false })],
  define: {
    __SAKUTTO_FAKE_ENGINE__: 'false',
  },
  resolve: {
    alias: {
      '@': resolve(import.meta.dirname, 'src'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    pool: 'threads',
  },
});

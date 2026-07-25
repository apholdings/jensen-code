import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    testTimeout: 30000, // 30 seconds for API calls
    server: {
      deps: {
        external: [/@silvia-odwyer\/photon-node/],
      },
    },
  },
});

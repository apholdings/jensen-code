import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const packageDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
	resolve: {
		alias: [
			{ find: '@apholdings/jensen-ai/oauth', replacement: resolve(packageDir, '../ai/src/oauth.ts') },
			{ find: '@apholdings/jensen-ai', replacement: resolve(packageDir, '../ai/src/index.ts') },
			{ find: '@apholdings/jensen-agent-core', replacement: resolve(packageDir, '../agent/src/index.ts') },
		],
	},
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

import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Proxy E2E suites run in their own serial config (vitest.e2e.config.ts)
    // because each loads the ~30MB ONNX model in beforeAll; running them in the
    // parallel unit run starved the loads and timed out. Keep them out here so
    // this run stays fast and reliably green. `npm run test:run` runs both.
    exclude: [...configDefaults.exclude, 'test/proxy/**/*.e2e.test.ts'],
    // The proxy E2E suites load the ~30MB ONNX embedding model in beforeAll;
    // under the contended parallel coverage run several suites initialize it
    // simultaneously and 30s was still occasionally exceeded (each suite passes
    // in isolation). Give setup/teardown hooks generous headroom — a hung hook
    // still fails, just later.
    hookTimeout: 120000,
    coverage: {
      provider: 'v8',
      include: ['src/detection/**'],
      thresholds: {
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80,
      },
    },
  },
});

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
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

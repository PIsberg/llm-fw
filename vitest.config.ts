import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // The proxy E2E suites load the ~30MB ONNX embedding model in beforeAll;
    // under the contended parallel coverage run that can exceed the default 10s
    // hook timeout. Give setup/teardown hooks more headroom.
    hookTimeout: 30000,
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

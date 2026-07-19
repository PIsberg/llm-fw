import { defineConfig } from 'vitest/config';

// Dedicated config for the proxy end-to-end suites.
//
// Each *.e2e.test.ts file loads the ~30 MB ONNX embedding model in its
// beforeAll hook. Under the default parallel run, all ~14 suites initialise
// the model simultaneously and starve each other of CPU, so several hooks
// exceed even the 120 s timeout (they pass individually — this is pure
// load-contention, not a code fault).
//
// `fileParallelism: false` runs the files one at a time, each still in its own
// isolated fork, so exactly one model load is ever in flight. That keeps full
// per-file isolation (fixed ports / process.env are not shared) while making
// the suite deterministically green. It is slower by design; reliability wins
// for E2E.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/proxy/**/*.e2e.test.ts'],
    fileParallelism: false,
    hookTimeout: 120000,
  },
});

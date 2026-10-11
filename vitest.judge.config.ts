import { defineConfig } from 'vitest/config';

// Stage 3 judge coverage (test/detection/stage3-judge.test.ts) against a live
// Ollama. Kept out of the default run, where no Ollama exists and the suite
// could only skip; `npm run test:judge` runs it, and so does the nightly
// workflow against a pinned Ollama container. It fails when Ollama is
// unreachable rather than skipping, so the job cannot go green without a judge.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/detection/stage3-judge.test.ts'],
    hookTimeout: 300000,
    testTimeout: 300000,
  },
});

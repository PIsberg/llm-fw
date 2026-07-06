import { defineConfig, configDefaults } from 'vitest/config';

// Task C9 — dedicated vitest project for mutation testing (Stryker).
//
// Scoped to test/detection ONLY, and further pared down to the subset that
// runs fast and self-contained (no live Ollama, no real model
// download/inference). Stryker re-executes the suite once per surviving
// mutant candidate, so anything slow or network-dependent here is multiplied
// across thousands of runs — excluded files either hit a live Ollama server
// (stage3-judge), run the real (unmocked) embedding/classifier model across a
// large fixture set (accuracy/multilingual/media/image-attacks), or spin up
// real worker threads for numerical-identity comparison (inferenceIsolation).
// None of these exercise the seven regex-boundary modules any more than the
// fast unit/integration suites already do, so excluding them costs no
// mutation coverage on the mutated files while keeping the run bounded.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/detection/**/*.test.ts'],
    exclude: [
      ...configDefaults.exclude,
      'test/detection/stage3-judge.test.ts',
      'test/detection/accuracy.eval.test.ts',
      'test/detection/multilingual.test.ts',
      'test/detection/multilingual-indirect.test.ts',
      'test/detection/inferenceIsolation.test.ts',
      'test/detection/image-attacks.test.ts',
      'test/detection/media.test.ts',
    ],
  },
});

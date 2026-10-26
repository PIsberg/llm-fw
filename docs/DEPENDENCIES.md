[llm-fw](../README.md) > [Documentation](README.md) > Third-party dependencies

# Third-party dependencies

Every package llm-fw declares in `package.json`, why it is there, and whether it reaches
a user. `test/ci/dependencySurface.test.ts` fails when a declared package has no row below.
Licences outside the permissive set are in [NOTICE.md](../NOTICE.md).

## What a user installs

`npm i llm-fw` installs the **runtime** dependency, the **optional peer** only if the user
adds it, and nothing else. Measured on `package-lock.json` at 0.9.2:

| Group | Packages in the lockfile |
| --- | --- |
| Runtime (`dependencies` and everything they pull in) | 42, plus 27 optional or peer (platform binaries) |
| Dev only (`devDependencies` and their trees) | 451 |

Three things keep the dev group out of the release, each pinned by a test:

1. **Declared as `devDependencies`.** npm does not install them for a consumer, and the
   Docker runtime stage runs `npm ci --omit=dev`.
2. **`files` is `["dist", "data", "NOTICE.md"]`.** `npm pack --dry-run` lists 386 files and
   none is a test, script, fixture or report.
3. **`src/` imports no dev package.** `dist/` is compiled from `src/`, so such an import
   would be a module-not-found for every user. The one deliberate exception is
   `tesseract.js`, loaded through a dynamic import that degrades when it is absent.

To check by hand: `npm pack --dry-run`, and
`npm install ./llm-fw-*.tgz --omit=dev --dry-run` in an empty directory.

## Runtime

| Package | Version | Licence | Why |
| --- | --- | --- | --- |
| `@huggingface/transformers` | `~4.2.0` | Apache-2.0 | Runs the embedding model (`Xenova/multilingual-e5-small`) for stage 2 of detection in `src/detection/embedding.ts`, locally, with no network call at request time. The only direct runtime dependency. Pinned to a minor because a model-runtime change can move verdicts. |

### Transitive, and why they are there

These are not chosen by llm-fw. They arrive with `@huggingface/transformers`:

| Package | Pulled in by | Role |
| --- | --- | --- |
| `onnxruntime-node` | transformers | Native ONNX inference, the part that does the maths |
| `onnxruntime-web` | transformers | WASM build of the same runtime; present but not the path llm-fw uses on Node |
| `onnxruntime-common` | both runtimes | Shared types and tensor code |
| `sharp` | transformers | Image decoding for vision pipelines llm-fw does not run; hard dependency of transformers. Its libvips binaries are LGPL, see [NOTICE.md](../NOTICE.md) |
| `@huggingface/jinja`, `@huggingface/tokenizers` | transformers | Chat templates and the tokenizer for the embedding model |
| `adm-zip`, `global-agent` | onnxruntime-node | Install-time binary download helpers |
| `protobufjs` and `@protobufjs/*`, `long`, `flatbuffers`, `guid-typescript`, `platform` | onnxruntime-web | Model file parsing |
| `@types/node`, `undici-types` | `protobufjs` | Type declarations that protobufjs lists as a runtime dependency. They are never loaded; they are in the tree only because of that declaration |

`package.json` `overrides` raises `qs`, `adm-zip`, `sharp` and `global-agent` for this
repository's own tree and CI. npm applies `overrides` from the root project only, so a
consumer still resolves the parents' ranges. Read the `//overrides` note there before
relying on a clean `npm audit`.

## Optional peer

| Package | Version | Licence | Why |
| --- | --- | --- | --- |
| `tesseract.js` | `^7.0.0` | Apache-2.0 | OCR for text in images (`nonText.ocr`, off by default), `src/detection/ocr.ts`. An optional peer rather than a dependency because it cost every install about 50 MB and 13 packages for a feature most installs never enable. `npm i tesseract.js` turns it on; without it OCR degrades to opaque handling. |

## Development only

None of these ship. Versions are in `package.json`.

| Package | Used for |
| --- | --- |
| `typescript` | Compiles `src/` to `dist/` (`npm run build`) and type-checks (`tsc --noEmit`) |
| `@types/node` | Node API types for the compiler |
| `tsx` | Runs TypeScript scripts directly: `npm run dev`, scorecard, fpr, recall floor, verdict dump and diff, benchmarks |
| `vitest` | Unit, integration and proxy end-to-end test runner (`npm run test:run`) |
| `@vitest/coverage-v8` | Coverage reports (`npm run test:coverage`) |
| `fast-check` | Property and fuzz tests, `test/fuzz/` and `test/detection/` |
| `@playwright/test` | Browser tests of the dashboard UI (`npm run test:e2e`) |
| `@stryker-mutator/core` | Weekly mutation testing (`npm run mutation`) |
| `@stryker-mutator/vitest-runner` | Lets Stryker run the vitest suite |
| `eslint` | Lint (`npm run lint`) |
| `@typescript-eslint/eslint-plugin` | TypeScript lint rules |
| `@typescript-eslint/parser` | Parses TypeScript for eslint |
| `knip` | Finds unused exports and dependencies (`npm run knip`), not in CI |
| `hyparquet` | Reads the Parquet benign-traffic datasets that `scripts/fetch-eval-data.ts` downloads for the false-positive evaluation |
| `tesseract.js` | The same package as the optional peer above, installed in development so the OCR tests and build resolve it |

## Adding or changing one

- Prefer none. A runtime dependency is a cost every user pays on install.
- Decide the group first: if only a test, script or build step imports it, it is a
  `devDependencies` entry. `src/` must never import one.
- Add its row here. The test above fails until you do.
- Version bumps follow the `dependencies` skill in `.claude/skills/dependencies/`.

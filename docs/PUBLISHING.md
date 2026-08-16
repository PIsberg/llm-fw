[llm-fw](../README.md) > [Documentation](README.md) > Publishing (maintainers)

# Publishing (maintainers)


Releases are published to [npmjs.com](https://www.npmjs.com/package/llm-fw) by the **Publish to npm** GitHub Actions workflow (`.github/workflows/release.yml`):

1. Bump `version` in `package.json` and commit/merge to `main`.
2. Create a **GitHub Release** with tag `vX.Y.Z` (matching that version — the workflow fails on a mismatch).
3. The workflow lints, type-checks, builds, runs the test suite, and runs `npm publish --provenance --access public`.

Only `dist/` and `data/` ship (the `files` whitelist); `npm pack --dry-run` shows the exact tarball. **Setup required once:** add an `NPM_TOKEN` repository secret — an npm *Automation* access token with publish rights to the `llm-fw` package. Publishing with provenance means the npm page links back to the exact commit and workflow run that built the release; consider scoping `NPM_TOKEN` to a protected `npm` Environment for an approval gate.

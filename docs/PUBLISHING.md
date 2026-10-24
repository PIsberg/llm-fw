[llm-fw](../README.md) > [Documentation](README.md) > Publishing (maintainers)

# Publishing (maintainers)


Releases are published to [npmjs.com](https://www.npmjs.com/package/llm-fw) by the **Publish to npm** GitHub Actions workflow (`.github/workflows/release.yml`):

1. Bump `version` in `package.json` and commit/merge to `main`.
2. Create a **GitHub Release** with tag `vX.Y.Z` (matching that version — the workflow fails on a mismatch).
3. The workflow lints, type-checks, builds, runs the test suite, and runs `npm publish --provenance --access public`.
4. A second job attaches `llm-fw-vX.Y.Z.cdx.json` to the Release: a CycloneDX SBOM of the production dependencies, generated from the lockfile at the tag with `npm sbom --omit dev`. It is a separate job because uploading a release asset needs `contents: write`, which the publish job, able to mint an npm OIDC token, does not hold. If only this job fails, re-run it; the package is already on npm.

Only `dist/` and `data/` ship (the `files` whitelist); `npm pack --dry-run` shows the exact tarball. Publishing with provenance means the npm page links back to the exact commit and workflow run that built the release.

## Authentication: Trusted Publishing

The workflow authenticates with [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers) (OIDC). There is no npm token in the repository secrets. **Setup required once:** on npmjs.com, open the `llm-fw` package settings and add a trusted publisher for GitHub Actions with repository `PIsberg/llm-fw` and workflow filename `release.yml`. Renaming the workflow file breaks publishing until the trusted publisher is updated to match.

Trusted Publishing needs npm 11.5.1 or later. Node 22 bundles npm 10, so the workflow upgrades npm to a pinned 11.x before publishing. A stored token used to sit here instead, and a granular publish token lives at most 90 days: v0.7.0 failed on an expired `NPM_TOKEN`, which npm reports as `404 Not Found - PUT https://registry.npmjs.org/llm-fw` rather than a 401.

## When a publish fails after the Release exists

Re-running the failed job runs the workflow as it was at the tag, so a workflow fix merged afterwards does not reach it. Once the fix is on `main` and `main`'s `package.json` still carries the unpublished version, publish it with a manual **Run workflow** on `main` (the `workflow_dispatch` trigger). That run skips the tag check, so confirm the version first.

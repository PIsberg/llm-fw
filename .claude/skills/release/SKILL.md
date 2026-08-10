---
name: release
description: Cut an llm-fw release — establish what is actually published versus tagged versus written down, prepare the version bump and changelog on a branch, drive CI to green, then stop and hand the irreversible publish step back. Use when asked to release, cut a version, ship, publish to npm, or bump the version; and when checking whether a fix has actually reached users.
---

# Releasing llm-fw

Publishing is a one-way door. `npm publish` cannot be undone (unpublish is
window-limited and burns the version number forever), and a GitHub Release fires
`.github/workflows/release.yml` the moment it is published. So this skill does
everything up to that door and stops.

**You prepare. A human publishes.** Never create the GitHub Release, never
`npm publish`, never merge the PR. Push the tag only after CI is green on the
merged commit, and only when explicitly asked.

## How a release actually works here

`.github/workflows/release.yml` triggers on `release: published`. It runs lint,
`tsc --noEmit`, build, and `npm run test:run`, then verifies the tag matches
`package.json` version, then publishes to npm with provenance. So:

1. `package.json` version and the git tag **must** agree, or the workflow fails
   at the verify step after the Release already exists.
2. The tag names the commit that gets published. Whatever is on that commit is
   what users receive.
3. `NPM_TOKEN` must be a valid automation token with publish rights, or the
   workflow fails at the last step with the Release already public.

## Step 1 — establish ground truth before touching anything

Four sources can disagree, and the ones written in prose are the least
trustworthy. Read all four:

```bash
node -p "require('./package.json').version"      # what a build would claim
npm view llm-fw versions dist-tags.latest        # what users can actually install
git tag --sort=-v:refname | head -5              # what was tagged
gh release list --limit 5                        # what triggered a publish
grep -n "^## \[" CHANGELOG.md | head -5          # what the notes claim
git log --oneline "$(git describe --tags --abbrev=0)"..main   # unreleased commits
```

Report the four numbers plainly before proposing anything. The failure this
catches is real and has already happened in this repo: `package.json` and
`CHANGELOG.md` both said `0.4.0` while npm's latest was `0.3.0` and no `v0.4.0`
tag existed. A version bumped in a commit is not a release, and a dated
`## [0.4.0]` heading in the changelog is a claim, not evidence.

**When package.json is ahead of the newest tag**, you are finishing an
abandoned release, not starting a new one. Do not bump again — the number is
already allocated. Confirm with the human before changing it.

**When a downstream consumer or an issue is waiting on a specific fix**, prove
the fix is on the commit you are about to tag, rather than assuming it is
because the PR merged:

```bash
git log --oneline "$(git describe --tags --abbrev=0)"..main -- <path/to/fixed/file>
```

## Step 2 — decide the version

SemVer, judged against the diff since the last published version, not against
the commit subjects:

- **patch** — bug fixes, detection tuning that only changes scores, docs
- **minor** — new CLI commands or flags, new detection stages, new config keys,
  anything additive to `src/api.ts` or the exported types
- **major** — a removed or renamed CLI command, a config key that stops being
  read, a changed default that blocks traffic that used to pass

Detection changes deserve care: a threshold change that turns a warn into a
block is a breaking change for anyone whose traffic sat in that band, even
though no signature changed. Say so in the notes.

## Step 3 — prepare on a branch

Never commit to `main`. Branch from the commit you intend to release, not from
whatever is checked out:

```bash
git status                      # if the tree is dirty, stop and ask
git switch -c release/vX.Y.Z main
```

Then:

1. **Version.** `npm version X.Y.Z --no-git-tag-version` — the flag matters, the
   tag is created later and only after CI is green.
2. **Changelog.** Rename `## [Unreleased]` to `## [X.Y.Z] - YYYY-MM-DD` using
   today's real date, and open a fresh empty `## [Unreleased]` above it. Write
   what changed for a *user*, not what changed in the tree: the failure a fix
   prevents, the flag that is now available, the default that moved.
3. **Docs the release makes wrong.** Grep for the outgoing version and for any
   claim the change invalidates:
   ```bash
   grep -rn "0\.4\.0" README.md docs/ --include="*.md"
   ```
   A workaround comment that no longer applies, or a README example using a
   removed flag, is a defect shipping with the release.
4. **Licence surface.** If the release touches `src/license/` or
   `src/cli/license.ts`, check `src/license/account.ts` still carries the real
   Keygen account values. Shipping the placeholder means every paying customer's
   key reports `unverified`. `test/license/` covers the maths; nothing covers a
   forgotten paste, so look.

## Step 4 — verify, and report the result honestly

Run what CI runs, in the same order, so a local red is a real red:

```bash
npx tsc --noEmit
npm run lint
npm run build
npm run test:run        # vitest run + the e2e proxy config — both, not just the first
```

Rules for reporting:

- **A skipped gate is not a passed gate.** `npm run test:e2e` (Playwright) and
  the load tests run in CI but are frequently skipped locally. Say "not run
  locally, CI covers it" — never fold them into "tests pass".
- **Never let a pipe eat an exit code.** `npm run test:run | tail` reports
  `tail`'s status. Check the command directly or use `PIPESTATUS`.
- **Paste failures.** If something is red, show the output. Do not describe a
  partial run as done.
- Local green does not settle it. CI runs a different OS and JDK-independent
  Node matrix, and the failures that only appear there are the ones worth having.

## Step 5 — PR, then follow the pipeline to green

```bash
git push -u origin release/vX.Y.Z
gh pr create --title "release: vX.Y.Z" --body "..."
```

The PR body states what the release contains and how it was verified — the diff
already shows what changed.

Then stay on the run. Pushing is not the end of the task:

```bash
gh pr checks --watch
gh run view <id> --log-failed    # read the failing job, fix, push, repeat
```

Do not hand back a red pipeline as done. Do not merge the PR — that is the
human's call.

## Step 6 — stop here and hand over

Once the PR is green, print the exact remaining commands and stop:

```
Ready to release vX.Y.Z. Remaining steps are yours:

  1. Merge the PR (or ask me to, explicitly).
  2. Wait for CI to go green on main — the tag must point at a verified commit.
  3. git tag vX.Y.Z <merge-sha> && git push origin vX.Y.Z
  4. gh release create vX.Y.Z --title "vX.Y.Z" --notes-file <notes>
     ↳ this publishes to npm. It cannot be undone.
```

A tag that triggers a publish cannot be re-cut. If asked to tag, confirm CI is
green on the exact commit first, and refuse to tag a commit whose checks are
pending.

## After a publish (only when asked to confirm one)

```bash
npm view llm-fw dist-tags.latest      # the number users now get
npm view llm-fw@X.Y.Z dist.tarball
gh run list --workflow=release.yml --limit 1
```

If the workflow failed *after* the Release was published, the Release exists but
npm does not have the version. Say exactly that — the fix is re-running the
workflow, not cutting a new version.

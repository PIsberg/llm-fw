# Rule: documentation

Read before any documentation change.

## Where things belong

| Content | Home |
| --- | --- |
| Pitch, screenshots, install, quick start, mode overview, licence | `README.md` |
| Anything longer than a section | `docs/guides/<topic>.md`, linked from `docs/README.md` |
| System design, diagrams | `docs/ARCHITECTURE.md` |
| Measurements and methodology | `docs/BENCHMARK*.md`, `docs/SCORECARD.md`, `docs/LOADTESTS.md` |
| What a feature must do | `docs/specs/SPEC-<feature>.md` |
| How it was built | `docs/plans/PLAN-<feature>.md` |
| Contributor process and style | `CONTRIBUTING.md` |
| Agent working rules | `.claude/rules/`, indexed from `CLAUDE.md` |

**The README is a landing page, not a manual.** It was 1761 lines and is now
roughly 500. New reference material goes in a guide and gets a link, not an
appended README section.

Every new document under `docs/` needs a row in `docs/README.md`. An unindexed
document is one nobody finds.

## Rules

- **Update what the change makes wrong, in the same change.** A comment
  justifying a workaround that no longer exists is a defect.
- **Add a `## [Unreleased]` entry to `CHANGELOG.md`** in Keep a Changelog
  format. Describe the change for a user, the failure it prevents or the flag
  now available, not the diff.
- **Numbers over adjectives.** "537 to 137 lines" beats "much smaller". If it
  was not measured, say so rather than reaching for an intensifier.
- **Say what was verified and how**, in one line, rather than asserting
  confidence.
- **No em-dashes in new prose.** No curly quotes. En-dash only in numeric
  ranges. Existing prose keeps its own style; do not sweep it.
- **Never hand-edit inside generated markers.** Change the generator.
- **Do not repeat generated values in prose** (ruleset version, scorecard
  numbers outside the generated block). They go stale silently.

## Links

Relative links only. No `file:///` absolute paths: they were removed once
already and they break for everyone but the author.

After moving or renaming a document, re-run the link check:

```bash
npm run docs:links
```

It walks every tracked `.md`, resolves relative links, and verifies heading
anchors exist in the target file.

## Claims

A README, a changelog or a release note is a claim about behaviour. If the
answer matters, verify it against the code before repeating it. Prefer ground
truth the build enforces (an enum's length, a pinned test, a generated count)
over any number written in prose.

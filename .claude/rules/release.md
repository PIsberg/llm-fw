# Rule: releasing

The full runbook is the `release` skill at
[`.claude/skills/release/SKILL.md`](../skills/release/SKILL.md). Invoke it
rather than improvising. This file exists so the routing table in `CLAUDE.md`
has somewhere to point.

The non-negotiables it enforces:

- Establish what is actually published on npm versus tagged in git versus
  written in the changelog, before touching anything. They disagree more often
  than you would expect.
- Prepare on a branch. Never commit to `main`.
- Wait for green before anything irreversible. Push, let CI finish, then tag.
  A tag that publishes cannot be re-cut.
- Follow the pipeline after every push and stay on it until it is green. A
  local green build does not settle it: CI runs a different OS, a different
  Node version and a different contention profile.
- Stop at the publish step and hand it back. Publishing, tagging and merging
  are a human's call.

Related: `npm run ruleset:digest` and the CI gate that fails until
`RULESET_VERSION` is cut when a verdict-affecting file changed. See
[detection.md](detection.md).

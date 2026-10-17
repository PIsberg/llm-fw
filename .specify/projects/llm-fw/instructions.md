# llm-fw: project instructions

- Read `CLAUDE.md`, then the `.claude/rules/` file its "Read before you work" table names for the area you touch: `config.md` for a new module or config key, `proxy-gateway.md` for anything sent upstream or back to the client.
- The newest gateway module, the lean-ctx shell module (`modules.leanCtx`, PR #370), is the reference for a new module's shape: `BUILTINS` entry, config, tests, its section in `docs/guides/token-savings.md`.
- Run the unit and e2e halves separately, `npx vitest run` then `npx vitest run --config vitest.e2e.config.ts`. A combined `npm run test:run` has been killed for low memory on this machine.
- Set `LLM_FW_MODEL_DIR=$HOME/.llm-fw/models` for every test run. Without it each e2e file downloads the model and the run looks hung for 7+ minutes.
- Never let a test, script or measurement write to the real `~/.llm-fw`: use a scratch `LLM_FW_DIR`.
- `ctx_shell` detaches commands longer than about 110 s into a job that reports no output. Run the gate and the test suites with native Bash.
- The lean-ctx shell blocks `node -e`. Write an `.mjs` script (or an `.mts` run with `node --import tsx/esm`) in a scratch directory instead.
- Do not call a paid model API, spawn `claude -p`, or run `llm-fw setup` without the user's go-ahead: they cost money or reroute the user's other sessions. (inferred from past live tests)
- Token counts quoted in docs or a PR come from a real tokenizer on LF-normalised text, never chars/4.
- Measured facts about token-saving modules and how to measure one are in `token-savings-findings.md` beside this file.

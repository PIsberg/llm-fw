# Rule: configuration

Read when adding a config key, an env var, or a CLI flag.

## Layering

`loadConfig` in `src/config/config.ts` merges, lowest precedence first:

1. `DEFAULT_CONFIG` in `src/config/config.ts`
2. a cosmiconfig project file, searched upward from cwd (`package.json` key
   `llm-fw`, `.llm-fw.json`, `.llm-fwrc*`, `llm-fw.config.js`)
3. `<LLM_FW_DIR>/config.json`, default `~/.llm-fw/config.json`
4. `LLM_FW_*` environment variables, via the `ENV_OVERRIDES` table
5. `extraTargets` appended to `targets`
6. observe-mode rewriting, when enforcement is `observe`

## Adding a key

A new key is not one edit. It is five, and reviewers will look for all of them:

1. The type in `src/types.ts`.
2. The default in `DEFAULT_CONFIG`.
3. An entry in `ENV_OVERRIDES` if it should be settable from the environment.
4. Hot-reload classification: warm keys apply live; cold keys must be listed as
   restart-required. Ports, bind hosts, `proxy.mode`, `bypass`, `targets` and
   `interceptDomains` are cold.
5. Documentation in [docs/guides/configuration.md](../../docs/guides/configuration.md),
   next to its siblings, plus a `CHANGELOG.md` entry.

## Traps that have bitten before

- **Booleans are strictly `'true'`.** `ENV_OVERRIDES` tests `v === 'true'`, so
  `1` and `yes` both mean false.
- **`loadConfig` only applies an entry `if (value)`.** An empty string is
  ignored, not treated as false.
- **Arrays replace wholesale.** Overriding `targets` in a file drops the entire
  built-in provider registry. That is why `extraTargets` exists.
- **`LLM_FW_DIR` is read at module load** by `src/proxy/certs.ts`. It must be in
  the process environment; setting it from config is too late.
- **`LLM_FW_GATEWAY_KEY_<SLUG>` is deliberately not in the config object**, so
  the dashboard settings view cannot read provider keys back out. Keep it that
  way.

## CLI flags

`src/cli/index.ts` is a plain `switch` on `process.argv[2]`, and flags are
matched with `args.includes(...)`. There is no arg parser. If you add a flag,
add it to the `usage` text in the same file: `--gateway` and `--observe` are
both real and both missing from it today.

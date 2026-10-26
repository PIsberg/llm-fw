/**
 * The options each subcommand accepts, checked before it runs.
 *
 * Subcommands read their flags with `args.includes(...)`, so anything else on
 * the command line used to be dropped without a word. `llm-fw start
 * --obeserve` started the firewall in enforce mode, and it refused traffic the
 * operator had asked it only to observe. A misspelt flag on a security tool
 * has to stop the command, not quietly pick the strict default or the loose
 * one.
 *
 * `flags` stand alone; `valued` take the next argument as their value. Keep
 * this in step with what each subcommand reads: `test/cli/options.test.ts`
 * checks every entry is documented in `USAGE`.
 */
export const KNOWN_OPTIONS: Record<string, { flags: string[]; valued: string[] }> = {
  setup: { flags: ['--proxy-only', '--sinkhole', '--judge', '--no-judge'], valued: [] },
  'setup-judge': { flags: [], valued: [] },
  uninstall: { flags: ['--yes', '-y', '--keep-model', '--purge'], valued: [] },
  start: { flags: ['--standalone', '--stand-alone', '--gateway', '--observe', '--dry-run', '--monitor'], valued: [] },
  stop: { flags: [], valued: [] },
  status: { flags: [], valued: [] },
  doctor: { flags: ['--json'], valued: [] },
  '--doctor': { flags: ['--json'], valued: [] },
  'install-service': { flags: [], valued: [] },
  'uninstall-service': { flags: [], valued: [] },
  license: {
    flags: ['--deactivate', '--deactivate-file', '--status', '--verify'],
    valued: ['--activate', '--activate-file'],
  },
};

/** True when the args ask for help rather than for the subcommand to run. */
export function wantsHelp(args: string[]): boolean {
  return args.includes('--help') || args.includes('-h');
}

/**
 * The error to print when `args` holds anything `command` does not accept, or
 * undefined when every argument is known. Commands missing from the table are
 * left to the dispatcher, which already rejects them.
 */
export function checkOptions(command: string, args: string[]): string | undefined {
  const known = KNOWN_OPTIONS[command];
  if (!known) return undefined;
  let valueNext = false;
  for (const arg of args) {
    if (valueNext) {
      valueNext = false;
      continue;
    }
    if (known.valued.includes(arg)) {
      valueNext = true;
      continue;
    }
    if (known.flags.includes(arg)) continue;
    const kind = arg.startsWith('-') ? 'unknown option' : 'unexpected argument';
    const guess = nearest(arg.startsWith('-') ? arg : `--${arg}`, [...known.flags, ...known.valued]);
    const hint = guess ? ` (did you mean ${guess}?)` : '';
    return `llm-fw ${command}: ${kind} "${arg}"${hint}. Run "llm-fw --help" for the options.`;
  }
  return undefined;
}

/** The candidate within two edits of `word`, if there is one. */
function nearest(word: string, candidates: string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = 3;
  for (const c of candidates) {
    const d = editDistance(word, c);
    if (d < bestDistance) {
      best = c;
      bestDistance = d;
    }
  }
  return best;
}

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution = (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      row[j] = Math.min((prev[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, substitution);
    }
    prev = row;
  }
  return prev[b.length] ?? 0;
}

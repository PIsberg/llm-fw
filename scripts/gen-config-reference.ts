/**
 * Generate the environment-variable reference in docs/guides/configuration.md.
 *
 * The guide promised "the full key reference" and listed four variables while
 * ENV_OVERRIDES held eighty-one. A hand-written table of that size is a table
 * that is wrong within a release, so this derives it from the code: the names
 * and the config path each one writes come from parsing ENV_OVERRIDES, and the
 * default values come from importing DEFAULT_CONFIG. `npm run config:reference`
 * rewrites the marked region; test/config/config-reference.test.ts fails when
 * the file and the code disagree, so adding a variable without documenting it
 * makes CI red.
 *
 * Usage:
 *   npm run config:reference          rewrite the region
 *   npm run config:reference -- --check   exit 1 if it is stale
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG } from '../src/config/config.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(root, 'src', 'config', 'config.ts');
const TARGET = path.join(root, 'docs', 'guides', 'configuration.md');
const START = '<!-- CONFIG-REFERENCE-START -->';
const END = '<!-- CONFIG-REFERENCE-END -->';

/** The `LLM_FW_*` entries of ENV_OVERRIDES, with the config path each writes. */
export function parseEnvOverrides(source: string): { name: string; path: string }[] {
  const table = source.slice(source.indexOf('const ENV_OVERRIDES'));
  const lines = table.split(/\r?\n/);
  const ENTRY = /^\s{2}(LLM_FW_[A-Z0-9_]+):\s*\(([\w]+),/;
  const out: { name: string; path: string }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const entry = ENTRY.exec(lines[i]);
    if (!entry) continue;
    const [, name, cfgParam] = entry;
    // Several entries span multiple lines (the TLS pair, the per-surface
    // threshold), so the body runs to the next entry or the end of the table.
    // Reading only the declaration line reported those three as having no key.
    let body = lines[i];
    for (let j = i + 1; j < lines.length && !ENTRY.test(lines[j]) && !/^\};/.test(lines[j]); j++) {
      body += ' ' + lines[j];
    }
    // Regex literals only: the last assignment onto the config parameter is
    // the one that lands on the config object, earlier ones are locals.
    const assignments = [...body.matchAll(/(?:^|[^\w.$])([a-zA-Z_$][\w$]*)\.([\w.]+?)\s*=[^=]/g)]
      .filter(m => m[1] === cfgParam)
      .map(m => m[2]);
    out.push({ name, path: assignments.length ? assignments[assignments.length - 1] : '' });
  }
  return out;
}

/** Read a dotted path out of the default config, for the Default column. */
function defaultFor(dotted: string): string {
  if (!dotted) return '';
  let cursor: unknown = DEFAULT_CONFIG;
  for (const segment of dotted.split('.')) {
    if (cursor === null || typeof cursor !== 'object') return '';
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  if (cursor === undefined) return '_unset_';
  if (typeof cursor === 'string') return cursor === '' ? '_empty_' : '`' + cursor + '`';
  if (Array.isArray(cursor)) return '`' + cursor.length + ' entries`';
  if (typeof cursor === 'object') return '';
  return '`' + String(cursor) + '`';
}

/**
 * Compare and render on LF regardless of what is on disk.
 *
 * git checks this file out with CRLF on Windows while the generator emits LF,
 * so a byte comparison failed for every Windows contributor and passed on CI.
 * A gate that only fires on other people's machines is worse than no gate.
 */
export function normalizeEol(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

export function renderTable(source: string): string {
  const rows = parseEnvOverrides(source)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(e => `| \`${e.name}\` | ${e.path ? '`' + e.path + '`' : ''} | ${defaultFor(e.path)} |`);
  return [
    `_${rows.length} variables, generated from \`ENV_OVERRIDES\` in \`src/config/config.ts\` by \`npm run config:reference\`. Do not edit by hand._`,
    '',
    '| Variable | Sets | Default |',
    '| --- | --- | --- |',
    ...rows,
  ].join('\n');
}

function main(): void {
  const source = fs.readFileSync(SOURCE, 'utf8');
  const doc = fs.readFileSync(TARGET, 'utf8');
  const from = doc.indexOf(START);
  const to = doc.indexOf(END);
  if (from === -1 || to === -1) {
    console.error(`${TARGET} is missing the ${START} / ${END} markers.`);
    process.exitCode = 1;
    return;
  }
  const usesCrlf = doc.includes('\r\n');
  const region = '\n\n' + renderTable(source) + '\n\n';
  // Match the file's existing convention so regenerating never rewrites
  // every line ending as a side effect.
  const next = doc.slice(0, from + START.length) + (usesCrlf ? region.replace(/\n/g, '\r\n') : region) + doc.slice(to);
  if (process.argv.includes('--check')) {
    if (normalizeEol(next) !== normalizeEol(doc)) {
      console.error('docs/guides/configuration.md is stale. Run: npm run config:reference');
      process.exitCode = 1;
      return;
    }
    console.log('config reference is up to date');
    return;
  }
  fs.writeFileSync(TARGET, next, 'utf8');
  console.log(`wrote ${parseEnvOverrides(source).length} variables to docs/guides/configuration.md`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();

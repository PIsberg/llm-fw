/**
 * Extract the markup tags Claude Code wraps its own text in, from its
 * binary, and keep src/detection/clientTags.ts in step with them.
 *
 *   npm run client-tags -- [--from <claude binary or cli.js>]          rewrite the list
 *   npm run client-tags -- [--from <claude binary or cli.js>] --check  fail on drift
 *
 * Without --from, the `claude` on PATH is read. The binary is only read,
 * never run. The scheduled Client Tags workflow downloads the newest
 * @anthropic-ai/claude-code-linux-x64 and runs --check, so a tag a new
 * release adds fails a job before it blocks anyone's session.
 *
 * Claude Code keeps its tag names as string constants next to each other
 * and lists them in arrays (the one that holds "system-reminder" is the list
 * of tags it treats as its own markup). The extractor anchors on that array,
 * resolves its identifiers and spreads through the constants declared
 * around it, adds the other arrays in that region whose every member
 * resolves to a tag, and adds every constant there that is used as a tag in
 * a template (`<${name}>`). When the anchor is gone the extractor fails
 * instead of guessing: a release that moved it needs a human to look.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = path.join(ROOT, 'src', 'detection', 'clientTags.ts');
const ANCHOR = '"system-reminder","system_reminder"';
const TAG = /^[a-z][a-z0-9_-]{1,63}$/;
const REGION = 40_000;

export interface Extracted { version: string | null; tags: string[] }

/** Tag names from the text of a Claude Code build. Throws when the anchor is missing. */
export function extractClaudeCodeTags(source: string): Extracted {
  const at = source.indexOf(ANCHOR);
  if (at < 0) throw new Error(`anchor ${ANCHOR} not found: the tag lists moved, update scripts/client-tags.ts`);
  const region = source.slice(Math.max(0, at - REGION), at + REGION);

  const consts = new Map<string, string>();
  const declaredAt = new Map<string, number>();
  for (const m of region.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)="([a-z][a-z0-9_-]{1,63})"/g)) { consts.set(m[1]!, m[2]!); declaredAt.set(m[1]!, m.index); }
  const arrays = new Map<string, string[]>();
  for (const m of region.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)=\[([^\]]{1,4000})\]/g)) arrays.set(m[1]!, m[2]!.split(','));

  // An array member is a "literal", an identifier naming a constant, or a
  // ...spread of another array. null when any member is something else.
  const resolve = (members: string[], seen = new Set<string>()): string[] | null => {
    const out: string[] = [];
    for (const raw of members) {
      const t = raw.trim();
      const lit = /^"([^"]*)"$/.exec(t);
      if (lit) {
        if (!TAG.test(lit[1]!)) return null;
        out.push(lit[1]!);
        continue;
      }
      const spread = /^\.\.\.([A-Za-z_$][\w$]*)$/.exec(t);
      if (spread) {
        const name = spread[1]!;
        const inner = arrays.get(name);
        if (!inner || seen.has(name)) return null;
        const r = resolve(inner, new Set([...seen, name]));
        if (!r) return null;
        out.push(...r);
        continue;
      }
      const c = consts.get(t);
      if (c === undefined) return null;
      out.push(c);
    }
    return out;
  };

  const anchorArray = /(?<![\w$.])([A-Za-z_$][\w$]*)=\[[^\]]*$/.exec(source.slice(Math.max(0, at - 4000), at));
  const anchorName = anchorArray?.[1];
  const anchored = anchorName ? resolve(arrays.get(anchorName) ?? []) : null;
  if (!anchored) throw new Error('the array holding the anchor did not resolve to tag names: update scripts/client-tags.ts');

  const tags = new Set(anchored);
  // The block of tag constants: from the first constant the anchor array
  // names to the anchor. Some are never in a list or a literal template (the
  // task-notification fields go through a helper), so take them all.
  const members = (arrays.get(anchorName!) ?? []).map(t => t.trim())
  const starts = members.map(t => declaredAt.get(t)).filter((n): n is number => n !== undefined)
  const anchorInRegion = at - Math.max(0, at - REGION)
  if (starts.length) for (const [name, pos] of declaredAt) if (pos >= Math.min(...starts) && pos < anchorInRegion) tags.add(consts.get(name)!)
  for (const [, members] of arrays) {
    const r = resolve(members);
    if (r && r.length >= 2 && r.some(t => anchored.includes(t))) for (const t of r) tags.add(t);
  }
  // A constant declared beside the lists and used as a tag anywhere in the
  // bundle (the skill envelope's template is far from the declarations).
  const declared = new Set(consts.keys());
  for (const m of source.matchAll(/<\/?\$\{([A-Za-z_$][\w$]*)\}>/g)) {
    if (declared.has(m[1]!)) tags.add(consts.get(m[1]!)!);
  }
  const version = /README_URL:"[^"]*",VERSION:"(\d+\.\d+\.\d+)"/.exec(source)?.[1] ?? null;
  return { version, tags: [...tags].sort() };
}

function render({ version, tags }: Extracted): string {
  const lines = tags.map(t => `  '${t}',`).join('\n');
  return `// GENERATED by \`npm run client-tags\` from Claude Code ${version ?? '(unknown version)'}. Do not edit:
// rerun the script. scripts/client-tags.ts says how the list is extracted, and
// the scheduled Client Tags workflow fails when a newer release adds a tag.
//
// The markup tags Claude Code wraps its own text in. clientEnvelopes.ts drops
// these tags, and only these, from a user turn Claude Code sent that consists
// of nothing but them, and scores what they carry.
export const CLAUDE_CODE_TAGS: ReadonlySet<string> = new Set([
${lines}
])
`;
}

function readSource(from: string | undefined): string {
  let file = from;
  if (!file) {
    const which = process.platform === 'win32' ? 'where' : 'which';
    file = execFileSync(which, ['claude'], { encoding: 'utf8' }).split(/\r?\n/)[0]!.trim();
  }
  // latin1 keeps every byte as one char, so a native binary reads as text.
  return fs.readFileSync(file, 'latin1');
}

function main(): void {
  const args = process.argv.slice(2);
  const i = args.indexOf('--from');
  const extracted = extractClaudeCodeTags(readSource(i >= 0 ? args[i + 1] : undefined));
  const next = render(extracted);
  if (!args.includes('--check')) {
    fs.writeFileSync(TARGET, next);
    console.log(`wrote ${extracted.tags.length} tags from Claude Code ${extracted.version ?? '(unknown)'} to ${path.relative(ROOT, TARGET)}`);
    return;
  }
  const current = fs.existsSync(TARGET) ? new Set([...fs.readFileSync(TARGET, 'utf8').matchAll(/^ {2}'([^']+)',$/gm)].map(m => m[1]!)) : new Set<string>();
  const added = extracted.tags.filter(t => !current.has(t));
  const removed = [...current].filter(t => !extracted.tags.includes(t));
  console.log(`Claude Code ${extracted.version ?? '(unknown)'}: ${extracted.tags.length} tags, ${added.length} new, ${removed.length} gone`);
  if (added.length) console.log(`  new:  ${added.join(', ')}`);
  if (removed.length) console.log(`  gone: ${removed.join(', ')}`);
  if (added.length || removed.length) {
    console.log('Run `npm run client-tags` with that release and check each new tag before committing: see .claude/rules/detection.md.');
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

/**
 * Extract the markup tags Codex wraps its own text in, from the codex-rs
 * sources at a release, and keep scripts/codex-tags.json in step with them
 * (#607).
 *
 *   npm run codex-tags                          rewrite the list from the newest release
 *   npm run codex-tags -- --check               fail on drift
 *   npm run codex-tags -- --ref rust-v0.167.0   a given release instead of the newest
 *   npm run codex-tags -- --from <codex-rs dir> read a local checkout instead of GitHub
 *
 * The scheduled Client Tags workflow runs --check, so a tag a new Codex release
 * adds fails a job before it blocks anyone's session; the Claude Code half of
 * that job is scripts/client-tags.ts.
 *
 * Codex keeps most of its wrapper tags in one block of `pub const
 * <NAME>_OPEN_TAG: &str = "<tag>"` pairs in protocol/src/protocol.rs. That
 * block is the anchor: when it is gone the extractor fails instead of
 * guessing. A few more are private constants in other crates, read from the
 * reviewed list in SOURCES; each must still hold at least one tag constant,
 * so a moved one fails here too. Tags Codex only writes as string literals or
 * in format! strings (turn_aborted, model_switch, user_shell_command and
 * more) are not extracted: there is nothing stable to anchor on.
 *
 * The list is not read by detection yet. clientEnvelopes.ts matches Codex's
 * wrappers by hand-written rules, and a new tag here means checking whether
 * it needs one.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = path.join(ROOT, 'scripts', 'codex-tags.json');
const REPO = 'openai/codex';

/** The anchor file, then the reviewed files with private tag constants. Paths under codex-rs/. */
export const ANCHOR = 'protocol/src/protocol.rs';
export const SOURCES = [
  ANCHOR,
  'core/src/realtime_context.rs',
  'core/src/context/internal_model_context.rs',
  'ext/git-attribution/src/world_state.rs',
  'context-fragments/src/additional_context.rs',
] as const;

// `const NAME: &str = "<tag>"`, `"<tag"` (takes attributes) or `"<prefix_"`.
// Closing forms ("</tag>") repeat the opening one and are skipped.
const TAG_CONST = /\bconst\s+[A-Z][A-Z0-9_]*\s*:\s*&str\s*=\s*"<([a-z][a-z0-9_]{0,63})(>?)"/g;
const ANCHOR_CONST = /\bpub\s+const\s+[A-Z][A-Z0-9_]*_OPEN_TAG\s*:\s*&str\s*=\s*"<[a-z]/;

/** Tag names from codex-rs sources, keyed by their path under codex-rs/. A prefix is listed as `name_*`. */
export function extractCodexTags(files: Readonly<Record<string, string>>): string[] {
  const anchor = files[ANCHOR];
  if (anchor === undefined || !ANCHOR_CONST.test(anchor)) {
    throw new Error(`no \`pub const *_OPEN_TAG\` block in ${ANCHOR}: the tag list moved, update scripts/codex-tags.ts`);
  }
  const tags = new Set<string>();
  for (const file of SOURCES) {
    const text = files[file];
    if (text === undefined) throw new Error(`${file} is missing: it moved, update SOURCES in scripts/codex-tags.ts`);
    let found = 0;
    for (const m of text.matchAll(TAG_CONST)) {
      const name = m[1]!;
      tags.add(!m[2] && name.endsWith('_') ? `${name}*` : name);
      found++;
    }
    if (found === 0) throw new Error(`${file} holds no tag constant any more: update SOURCES in scripts/codex-tags.ts`);
  }
  return [...tags].sort();
}

/** Tags added and gone, against the committed list. */
export function codexTagDrift(committed: readonly string[], extracted: readonly string[]): { added: string[]; removed: string[] } {
  return {
    added: extracted.filter(t => !committed.includes(t)),
    removed: committed.filter(t => !extracted.includes(t)),
  };
}

async function github(url: string): Promise<Response> {
  const headers: Record<string, string> = { accept: 'application/vnd.github+json', 'user-agent': 'llm-fw-codex-tags' };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res;
}

async function readSources(ref: string | undefined, from: string | undefined): Promise<{ ref: string; files: Record<string, string> }> {
  const files: Record<string, string> = {};
  if (from) {
    for (const f of SOURCES) { const p = path.join(from, f); if (fs.existsSync(p)) files[f] = fs.readFileSync(p, 'utf8'); }
    return { ref: ref ?? `local ${from}`, files };
  }
  const tag = ref ?? (await (await github(`https://api.github.com/repos/${REPO}/releases/latest`)).json() as { tag_name: string }).tag_name;
  for (const f of SOURCES) {
    const res = await fetch(`https://raw.githubusercontent.com/${REPO}/${encodeURIComponent(tag)}/codex-rs/${f}`);
    if (res.status === 404) continue;
    if (!res.ok) throw new Error(`codex-rs/${f} at ${tag}: HTTP ${res.status}`);
    files[f] = await res.text();
  }
  return { ref: tag, files };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const { ref, files } = await readSources(opt('--ref'), opt('--from'));
  const tags = extractCodexTags(files);
  if (!args.includes('--check')) {
    fs.writeFileSync(TARGET, `${JSON.stringify({ generatedBy: 'npm run codex-tags', release: ref, tags }, null, 2)}\n`);
    console.log(`wrote ${tags.length} tags from Codex ${ref} to ${path.relative(ROOT, TARGET)}`);
    return;
  }
  const committed = fs.existsSync(TARGET) ? (JSON.parse(fs.readFileSync(TARGET, 'utf8')) as { tags: string[] }).tags : [];
  const { added, removed } = codexTagDrift(committed, tags);
  console.log(`Codex ${ref}: ${tags.length} tags, ${added.length} new, ${removed.length} gone`);
  if (added.length) console.log(`  new:  ${added.join(', ')}`);
  if (removed.length) console.log(`  gone: ${removed.join(', ')}`);
  if (added.length || removed.length) {
    console.log('Check each new tag against src/detection/clientEnvelopes.ts, then run `npm run codex-tags` to commit the list: see .claude/rules/detection.md.');
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
}

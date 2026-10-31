/**
 * Replay the agents' own local transcripts through the pipeline and count
 * what would block: the false-positive measure that matches real use.
 *
 *   npm run replay:transcripts -- [--since 14] [--out run.jsonl] [--default-config]
 *                                 [--no-claude] [--no-codex] [--limit N] [--match <substr>]
 *                                 [--shard i/n] [--count]
 *   npm run replay:transcripts -- --diff before.jsonl after.jsonl
 *
 * Reads Claude Code transcripts under ~/.claude/projects (subagents included)
 * and Codex transcripts under ~/.codex/sessions modified in the last --since
 * days, rebuilds each distinct item as the request the proxy would see
 * (test/eval/lib/transcripts.ts), and runs it through the pipeline as that
 * client. The config is the one `llm-fw start` would load (LLM_FW_DIR, then
 * LLM_FW_* overrides), so an opt-in stage you turned on is measured;
 * --default-config measures the shipped defaults instead. Enforcement is
 * forced to enforce, so a would-be block counts even under observe, and the
 * judge is off: it is asynchronous and never blocks by default, and a run
 * would otherwise start Ollama for every item.
 *
 * Transcripts are private. Nothing is written except the --out file, which
 * holds the full text of every item that did not pass: keep it out of the
 * repository (scratch/ is ignored). Point LLM_FW_MODEL_DIR at a warm cache.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Pipeline } from '../src/detection/pipeline.js';
import { DEFAULT_CONFIG, loadConfig } from '../src/config/config.js';
import type { BlockEvent, Config } from '../src/types.js';
import { claudeCodeItems, codexItems, dedupe, type ReplayItem } from '../test/eval/lib/transcripts.js';
import { diffReplays, type ReplayRecord } from '../test/eval/lib/replayDiff.js';

const args = process.argv.slice(2);
const flag = (k: string): boolean => args.includes(k);
const opt = (k: string): string | undefined => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };

function walk(dir: string, sinceMs: number, acc: string[] = []): string[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    // tool-results/ holds spilled tool output, already inside the transcript;
    // memory/ is the agent's notes, not traffic.
    if (e.isDirectory()) {
      if (e.name !== 'tool-results' && e.name !== 'memory') walk(p, sinceMs, acc);
      continue;
    }
    if (e.name.endsWith('.jsonl') && fs.statSync(p).mtimeMs >= sinceMs) acc.push(p);
  }
  return acc;
}

function preview(text: string): string {
  return text.replace(/\s+/g, ' ').slice(0, 140);
}

async function replay(): Promise<void> {
  const sinceDays = Number(opt('--since') ?? 14);
  const sinceMs = Date.now() - sinceDays * 86_400_000;
  const match = opt('--match');
  const limit = Number(opt('--limit') ?? Infinity);
  const out = opt('--out');

  const items: ReplayItem[] = [];
  const read = (f: string): string => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
  const keep = (f: string): boolean => !match || f.includes(match);
  if (!flag('--no-claude')) for (const f of walk(path.join(os.homedir(), '.claude', 'projects'), sinceMs).filter(keep)) items.push(...claudeCodeItems(read(f), f));
  if (!flag('--no-codex')) for (const f of walk(path.join(os.homedir(), '.codex', 'sessions'), sinceMs).filter(keep)) items.push(...codexItems(read(f), f));
  // --shard i/n keeps every n-th item, so n processes can split one run.
  const [shardI, shardN] = (opt('--shard') ?? '0/1').split('/').map(Number) as [number, number];
  const todo = dedupe(items).filter((_, k) => k % shardN === shardI).slice(0, limit);
  if (flag('--count')) {
    const by = new Map<string, number>();
    for (const it of todo) by.set(`${it.client} ${it.kind}`, (by.get(`${it.client} ${it.kind}`) ?? 0) + 1);
    console.log(`${todo.length} distinct items ${JSON.stringify(Object.fromEntries(by))}`);
    return;
  }

  const config: Config = flag('--default-config') ? structuredClone(DEFAULT_CONFIG) : await loadConfig();
  config.enforcement = 'enforce';
  config.detection.judgeEnabled = false;
  const pipeline = new Pipeline(config);
  await pipeline.init();

  const counts = new Map<string, number>();
  const bump = (k: string): void => { counts.set(k, (counts.get(k) ?? 0) + 1); };
  const blocked: ReplayRecord[] = [];
  if (out) fs.writeFileSync(out, '');
  const t0 = Date.now();
  let n = 0;
  for (const it of todo) {
    n++;
    let ev: BlockEvent | undefined;
    const r = await pipeline.run(it.path, it.body, { target: it.target, method: 'POST', path: it.path, sandboxClient: it.client, onEvent: e => { if (e.action === 'blocked') ev ??= e; } });
    bump(`${it.client} ${it.kind} ${r.action}`);
    const rec: ReplayRecord = { key: it.key, client: it.client, kind: it.kind, action: r.action, stage: r.stage, file: it.file };
    if (r.action === 'block') {
      bump(`block by stage: ${r.stage}`);
      const text = r.blockedItem?.text ?? '';
      blocked.push({ ...rec, preview: preview(ev?.payload_preview ?? text), text });
    }
    if (out) fs.appendFileSync(out, `${JSON.stringify(r.action === 'block' ? blocked.at(-1) : rec)}\n`);
    if (n % 500 === 0) console.error(`${n}/${todo.length}, ${((Date.now() - t0) / n).toFixed(1)} ms per item`);
  }
  await pipeline.close();

  console.log(`transcripts from the last ${sinceDays} days: ${todo.length} distinct items${flag('--default-config') ? ', default config' : ', your config'}`);
  for (const [k, v] of [...counts].sort()) console.log(`  ${k.padEnd(36)} ${v}`);
  const total = todo.length;
  console.log(`blocked: ${blocked.length} of ${total} (${total ? ((blocked.length / total) * 100).toFixed(2) : '0.00'}%)`);
  for (const b of blocked.slice(0, 40)) console.log(`  [${b.client} ${b.kind} ${b.stage}] ${b.preview}`);
  const where = out ? ` in ${out}` : '';
  if (blocked.length > 40) console.log(`  ... ${blocked.length - 40} more${where}`);
}

function diff(): void {
  const i = args.indexOf('--diff');
  const [a, b] = [args[i + 1], args[i + 2]];
  if (!a || !b) { console.error('usage: npm run replay:transcripts -- --diff before.jsonl after.jsonl'); process.exit(2); }
  const load = (f: string): ReplayRecord[] => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as ReplayRecord);
  const d = diffReplays(load(a), load(b));
  console.log(`compared ${d.compared} items present in both runs: ${d.changed.length} verdicts changed`);
  console.log(`  newly blocked: ${d.newlyBlocked.length}`);
  for (const r of d.newlyBlocked.slice(0, 40)) console.log(`    [${r.client} ${r.kind} ${r.stage}] ${r.preview ?? ''}`);
  console.log(`  no longer blocked: ${d.unblocked.length}`);
  for (const r of d.unblocked.slice(0, 40)) console.log(`    [${r.client} ${r.kind} was ${r.stage}] ${r.preview ?? ''}`);
}

if (flag('--diff')) diff();
else await replay();

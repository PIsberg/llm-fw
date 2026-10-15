/**
 * Row-by-row verdicts of the default pipeline over every eval split.
 *
 *   npm run verdicts:dump -- out.json
 *
 * Judge and classifier off, every row on the surface it would really arrive
 * on (test/eval/lib/surfaces.ts), including the full Dolly-15k when
 * test/eval/data/local/dolly-15k-full.json is present (23,938 rows in all).
 * Run it on two trees, a ruleset change or a dependency bump, and compare with
 * `npm run verdicts:diff`. Used for #312: transformers 4.3.1 with
 * onnxruntime-node held at 1.24.3 moved 0 of 23,938 verdicts; with its own
 * onnxruntime-node 1.30.0 it moved 10.
 *
 * Point LLM_FW_MODEL_DIR at a warm model cache, or every run downloads it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pipeline } from '../src/detection/pipeline.js';
import { DEFAULT_CONFIG } from '../src/config/config.js';
import { anthropicRequestFor, type EvalRow } from '../test/eval/lib/surfaces.js';
import type { VerdictDump } from './verdict-diff.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

async function main(): Promise<void> {
  const out = process.argv[2];
  if (!out) {
    console.error('usage: npm run verdicts:dump -- <out.json>');
    process.exit(2);
  }
  const config = structuredClone(DEFAULT_CONFIG);
  config.detection.judgeEnabled = false;
  if (config.detection.classifier) config.detection.classifier.enabled = false;
  const pipeline = new Pipeline(config);
  await pipeline.init();

  const dataDir = path.join(ROOT, 'test', 'eval', 'data');
  const files = fs.readdirSync(dataDir).filter(f => f.endsWith('.json')).map(f => path.join(dataDir, f));
  const local = path.join(dataDir, 'local', 'dolly-15k-full.json');
  if (fs.existsSync(local)) files.push(local);

  const dump: VerdictDump = {};
  let total = 0;
  for (const file of files) {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as EvalRow[] | { rows: EvalRow[] };
    const rows = Array.isArray(parsed) ? parsed : parsed.rows;
    const verdicts: string[] = [];
    for (const row of rows) {
      const r = await pipeline.run('/v1/messages', anthropicRequestFor(row), { target: 'eval', method: 'POST', path: '/v1/messages' });
      verdicts.push(`${r.action}:${r.stage}:${r.similarity.toFixed(4)}`);
    }
    dump[path.relative(dataDir, file).split(path.sep).join('/')] = verdicts;
    total += rows.length;
    console.error(`${path.basename(file)}: ${rows.length} rows`);
  }
  fs.writeFileSync(out, JSON.stringify(dump));
  console.error(`${total} rows -> ${out}`);
  await pipeline.close();
}

void main();

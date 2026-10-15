/**
 * Diff two row-by-row verdict dumps from `npm run verdicts:dump`.
 *
 *   npm run verdicts:diff -- before.json after.json
 *
 * Counts block verdicts that flipped, per split, and the largest embedding
 * similarity drift. This is the measurement behind "N of 23,938 eval verdicts
 * changed" in a ruleset or dependency PR (#278, #312): an aggregate recall or
 * FPR can stay put while rows trade places, so compare rows.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** split file -> one `action:stage:similarity` entry per row. */
export type VerdictDump = Record<string, string[]>;

export interface VerdictFlip { split: string; row: number; before: string; after: string }

export interface VerdictDiff {
  rows: number;
  changed: number;
  bySplit: Record<string, number>;
  flips: VerdictFlip[];
  maxDrift: number;
}

const isBlock = (entry: string): boolean => entry.split(':')[0] === 'block';
const similarity = (entry: string): number => Number(entry.split(':')[2] ?? 0);

export function diffVerdicts(before: VerdictDump, after: VerdictDump): VerdictDiff {
  const out: VerdictDiff = { rows: 0, changed: 0, bySplit: {}, flips: [], maxDrift: 0 };
  for (const [split, rowsBefore] of Object.entries(before)) {
    const rowsAfter = after[split];
    if (!rowsAfter) throw new Error(`missing split in the second dump: ${split}`);
    if (rowsAfter.length !== rowsBefore.length) throw new Error(`row count differs for ${split}: ${rowsBefore.length} vs ${rowsAfter.length}`);
    rowsBefore.forEach((b, row) => {
      const a = rowsAfter[row] ?? '';
      out.rows++;
      out.maxDrift = Math.max(out.maxDrift, Math.abs(similarity(b) - similarity(a)));
      if (isBlock(b) !== isBlock(a)) {
        out.changed++;
        out.bySplit[split] = (out.bySplit[split] ?? 0) + 1;
        out.flips.push({ split, row, before: isBlock(b) ? 'block' : 'pass', after: isBlock(a) ? 'block' : 'pass' });
      }
    });
  }
  return out;
}

function main(): void {
  const [a, b] = process.argv.slice(2);
  if (!a || !b) {
    console.error('usage: npm run verdicts:diff -- <before.json> <after.json>');
    process.exit(2);
  }
  const read = (f: string): VerdictDump => JSON.parse(fs.readFileSync(f, 'utf8')) as VerdictDump;
  const d = diffVerdicts(read(a), read(b));
  for (const [split, n] of Object.entries(d.bySplit)) console.log(`${split}: ${n} block verdicts changed`);
  for (const f of d.flips.slice(0, 50)) console.log(`  ${f.split}#${f.row}: ${f.before} -> ${f.after}`);
  console.log(`${d.changed} of ${d.rows} block verdicts changed; max similarity drift ${d.maxDrift.toFixed(4)}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();

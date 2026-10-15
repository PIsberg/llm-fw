import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { explainBlock, explainGate } from '../../src/detection/explain.js';
import type { PipelineResult } from '../../src/types.js';

const REPO = 'https://github.com/PIsberg/llm-fw';

/** GitHub's heading slug, as scripts/check-links.mjs computes it. */
const slugify = (heading: string): string =>
  heading.replace(/^#+\s+/, '').trim().toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s/g, '-');

/**
 * Resolve a repo URL the way GitHub renders it: the bare repo URL is the
 * README, `/blob/main/<path>` is that file. Returns the local file and the
 * anchor, so the test checks the same tree the URL will serve once merged.
 */
function resolveRepoUrl(url: string): { file: string; anchor: string } {
  const [base = '', anchor = ''] = url.split('#');
  expect(base.startsWith(REPO), `${url} is not a link into this repository`).toBe(true);
  const rest = base.slice(REPO.length);
  const rel = rest === '' ? 'README.md' : rest.replace(/^\/blob\/main\//, '');
  return { file: path.resolve(rel), anchor };
}

function headingAnchors(file: string): Set<string> {
  const text = fs.readFileSync(file, 'utf8').replace(/```[\s\S]*?```/g, '');
  return new Set(text.split(/\r?\n/).filter(l => /^#{1,6}\s/.test(l)).map(slugify));
}

describe('block explanation docs link', () => {
  const result = { action: 'block', stage: 'heuristic', score: 50, similarity: 0 } as PipelineResult;
  const bodies = {
    pipeline: explainBlock({ eventId: 'e1', result }),
    gate: explainGate({ eventId: 'e2', error: 'blocked', stage: 'dlp', kind: 'dlp' }),
  };

  // Every refused client is pointed at this URL to learn how to suppress a
  // false positive. The README was cut from 1761 lines to ~500 and the section
  // moved to docs/guides/tuning.md, leaving the link landing on the top of the
  // README, and docs:links only checks Markdown, so nothing noticed.
  for (const [name, body] of Object.entries(bodies)) {
    it(`${name} block links to a heading that exists in the repo`, () => {
      const { file, anchor } = resolveRepoUrl(body.docs);
      expect(fs.existsSync(file), `${file} does not exist`).toBe(true);
      expect(anchor).not.toBe('');
      expect(headingAnchors(file).has(anchor), `no heading #${anchor} in ${path.relative('.', file)}`).toBe(true);
    });
  }
});

// #319: the remediation said "open /#events, find event <id>, and mark it
// 'not an attack'". /#events selected nothing, the table had no id column,
// and no control was labelled "not an attack". It now names a link that
// opens the event and the button that actually unblocks.
describe('block remediation can be followed', () => {
  const result = { action: 'block', stage: 'heuristic', score: 50, similarity: 0 } as PipelineResult;
  const body = explainBlock({ eventId: 'evt-123', result, dashboardUrl: 'http://127.0.0.1:7731' });

  it('links straight to the event', () => {
    expect(body.remediation).toContain('http://127.0.0.1:7731/#event=evt-123');
  });

  it('names the button that suppresses future matches, by its label', () => {
    expect(body.remediation).toContain('"Mark false positive (suppress future matches)"');
    expect(body.remediation).not.toContain('not an attack');
  });

  it('still names the event when no dashboard URL is known', () => {
    const plain = explainBlock({ eventId: 'evt-9', result });
    expect(plain.remediation).toContain('evt-9');
    expect(plain.remediation).toContain('"Mark false positive (suppress future matches)"');
  });
});

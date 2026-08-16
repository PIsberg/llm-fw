// Verifies every relative link in the repo's Markdown: that the target file
// exists, and that a `#anchor` matches a heading in it. A moved document that
// leaves a dangling link is a defect the reader finds before we do.
//
//   npm run docs:links
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const SKIP = new Set(['node_modules', '.git', 'dist', 'coverage', 'scratch', 'test-results', 'reports']);

function walk(dir, acc) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.name.endsWith('.md')) acc.push(p);
  }
  return acc;
}

// Mirrors GitHub's heading-to-anchor slug closely enough for our headings.
const slugify = (heading) =>
  heading.replace(/^#+\s+/, '').trim().toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s/g, '-');

// Fenced blocks hold example headings; inline code holds regexes that look
// like links. Neither is a link.
function strip(text) {
  return text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
}

const files = walk(root, []);
const anchors = new Map();
for (const f of files) {
  const set = new Set();
  for (const line of strip(fs.readFileSync(f, 'utf8')).split(/\r?\n/)) {
    if (/^#{1,6}\s/.test(line)) set.add(slugify(line));
  }
  anchors.set(path.resolve(f), set);
}

const problems = [];
for (const f of files) {
  const rel = path.relative(root, f).split(path.sep).join('/');
  const text = strip(fs.readFileSync(f, 'utf8'));
  for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const href = m[1];
    if (/^(https?:|mailto:|data:|#!)/.test(href)) continue;
    const [p, hash] = href.split('#');
    const target = p === '' ? path.resolve(f) : path.resolve(path.dirname(f), p);
    if (p !== '' && !fs.existsSync(target)) {
      problems.push(rel + ' -> ' + href + '   [missing file]');
      continue;
    }
    if (hash && target.endsWith('.md') && !anchors.get(target)?.has(hash)) {
      problems.push(rel + ' -> ' + href + '   [missing anchor]');
    }
  }
}

console.log('checked ' + files.length + ' markdown files');
if (problems.length) {
  console.error('\n' + problems.length + ' broken link(s):\n' + problems.join('\n'));
  process.exit(1);
}
console.log('no broken links');

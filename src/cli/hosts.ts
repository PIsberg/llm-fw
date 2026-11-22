/**
 * Shared hosts-file sinkhole helpers. `setup` strips any previous llm-fw block
 * before appending the current target list (so re-runs never stack entries);
 * `uninstall` strips it to restore the pre-install state.
 */

import fs from 'node:fs';

/**
 * Point every target at loopback in the hosts file at `hostsPath`, keeping a
 * backup for `restoreSinkholeHosts`.
 */
export function installSinkholeHosts(hostsPath: string, targets: string[]): void {
  const original = fs.readFileSync(hostsPath, 'utf8');
  // Strip any previous llm-fw block (and stray loopback target lines) so
  // re-running setup never stacks duplicate entries — same helper
  // uninstall uses for the full cleanup.
  const cleanHosts = stripSinkholeBlock(original, targets);
  // The backup is the file without llm-fw's lines, written on every run.
  // Backing up `original` on a second run saved the sinkholed file, and
  // `stop` restored it: every provider stayed on 127.0.0.1 (#852). Taking
  // the current file each time keeps what the user added in between.
  fs.writeFileSync(hostsPath + '.llm-fw.bak', cleanHosts, 'utf8');
  const hostLines = targets.map(t => `127.0.0.1 ${t}`).join('\n');
  const entries = (cleanHosts.endsWith('\n') || cleanHosts === '' ? '' : '\n') + `# llm-fw sinkhole\n${hostLines}\n`;
  fs.writeFileSync(hostsPath, cleanHosts + entries, 'utf8');
}

/** Put the hosts file back from the backup `installSinkholeHosts` kept, if any. Returns whether it did. */
export function restoreSinkholeHosts(hostsPath: string, targets: string[]): boolean {
  const backup = hostsPath + '.llm-fw.bak';
  if (!fs.existsSync(backup)) return false;
  // Stripped again: a setup older than #852 left the sinkhole in the backup.
  const original = stripSinkholeBlock(fs.readFileSync(backup, 'utf8'), targets);
  fs.writeFileSync(hostsPath, original, 'utf8');
  fs.unlinkSync(backup);
  return true;
}

/**
 * Remove llm-fw's sinkhole edits from a hosts file's text. This is the inverse
 * of what setup appended: it drops the `# llm-fw sinkhole` marker and every
 * loopback line that follows it, plus any stray `127.0.0.1 <target>` / `::1`
 * lines for a known target host (in case the marker was hand-edited away).
 *
 * Operates line-by-line and never builds a regex from host text, so a target
 * containing regex metacharacters can't corrupt the result. Returns the cleaned
 * text with a single trailing newline normalised away.
 */
export function stripSinkholeBlock(hostsText: string, targets: string[]): string {
  const targetSet = new Set(targets);
  const lines = hostsText.split(/\r?\n/);
  const out: string[] = [];
  let inBlock = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed === '# llm-fw sinkhole') {
      inBlock = true;
      continue;
    }
    if (inBlock) {
      // The block is the contiguous run of loopback/comment lines setup wrote.
      // The first line that isn't one of those ends the block and is kept.
      if (trimmed === '' || (!trimmed.startsWith('127.0.0.1') && !trimmed.startsWith('::1') && !trimmed.startsWith('#'))) {
        inBlock = false;
      } else {
        continue;
      }
    }

    // Belt-and-braces: drop any leftover loopback mapping for a target host.
    const parts = trimmed.split(/\s+/);
    if ((parts[0] === '127.0.0.1' || parts[0] === '::1') && parts.slice(1).some(h => targetSet.has(h))) {
      continue;
    }

    out.push(line);
  }

  return out.join('\n').replace(/(?<!\n)\n+$/, '\n').replace(/^\n+/, '');
}

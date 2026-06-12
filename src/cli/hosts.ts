/**
 * Shared hosts-file sinkhole helpers. `setup` strips any previous llm-fw block
 * before appending the current target list (so re-runs never stack entries);
 * `uninstall` strips it to restore the pre-install state.
 */

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

  return out.join('\n').replace(/\n+$/, '\n').replace(/^\n+/, '');
}

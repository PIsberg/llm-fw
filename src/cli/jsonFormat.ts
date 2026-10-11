/**
 * Re-serialize `value` in the formatting of `original`: its indentation, line
 * endings and trailing newline. setup and uninstall edit one key in files the
 * user owns (IDE settings.json); writing them back in our own house style
 * would leave a permanent whitespace diff behind every setup/uninstall cycle.
 */
export function serializeLike(original: string, value: unknown): string {
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const indent = /^([ \t]+)\S/m.exec(original)?.[1] ?? '    ';
  const trailing = /\r?\n$/.test(original) ? eol : '';
  return JSON.stringify(value, null, indent).replace(/\n/g, eol) + trailing;
}

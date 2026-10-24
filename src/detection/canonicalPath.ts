/**
 * A request path with every spelling a server might normalize undone: query
 * and fragment, `;` path parameters, percent-encoding, repeated slashes, `.`
 * and `..` segments and a trailing slash. Case is kept.
 *
 * Decisions keyed on the path (which parser reads the body, whether a path is
 * an auth endpoint, whether a chatgpt.com request is Codex) must follow the
 * path the provider will serve, not its spelling: a provider that serves
 * `/v1//messages` or `/v1/%6Dessages` as `/v1/messages` would otherwise get a
 * body no parser read.
 */
export function canonicalPath(path: string): string {
  const decoded = (path.split(/[?#]/, 1)[0] ?? '')
    .split('/')
    .map(segment => {
      try {
        return decodeURIComponent(segment)
      } catch {
        return segment // a malformed escape spoils only its own segment
      }
    })
    .join('/') // re-split below, so an encoded %2F becomes a real separator
  const out: string[] = []
  for (const raw of decoded.split('/')) {
    const segment = raw.split(';', 1)[0] ?? ''
    if (segment === '' || segment === '.') continue
    if (segment === '..') out.pop()
    else out.push(segment)
  }
  return '/' + out.join('/')
}

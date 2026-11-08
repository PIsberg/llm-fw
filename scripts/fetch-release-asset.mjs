// Downloads one GitHub release asset: node fetch-release-asset.mjs <owner/repo> <tag> <asset name> <out file>
//
// The REST asset endpoint first, then github.com/<repo>/releases/download. On
// 2026-11-08 the second answered 504 for every release while the API served
// the same file, which failed CI and the lean-ctx image build. The caller
// checks the SHA-256, so it does not matter which route served the bytes.
// Without a token the API allows 60 requests an hour per address; GITHUB_TOKEN
// or GH_TOKEN raises that.
import { writeFileSync } from 'node:fs'

const [repo, tag, name, out] = process.argv.slice(2)
if (!repo || !tag || !name || !out) {
  console.error('usage: fetch-release-asset.mjs <owner/repo> <tag> <asset name> <out file>')
  process.exit(2)
}
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
const auth = token ? { Authorization: `Bearer ${token}` } : {}

async function get(url, headers) {
  for (let attempt = 1; ; attempt++) {
    const r = await fetch(url, { headers: { 'User-Agent': 'llm-fw-build', ...headers } })
    if (r.ok) return r
    if (attempt >= 3 || (r.status < 500 && r.status !== 429)) throw new Error(`${r.status} ${url}`)
    await new Promise(res => setTimeout(res, 2000 * attempt))
  }
}

async function viaApi() {
  const release = await (await get(`https://api.github.com/repos/${repo}/releases/tags/${tag}`, { Accept: 'application/vnd.github+json', ...auth })).json()
  const asset = (release.assets ?? []).find(a => a.name === name)
  if (!asset) throw new Error(`no asset ${name} in ${repo} ${tag}`)
  return get(asset.url, { Accept: 'application/octet-stream', ...auth })
}

let res
try {
  res = await viaApi()
} catch (err) {
  console.error(`release API: ${err.message}; trying the download URL`)
  res = await get(`https://github.com/${repo}/releases/download/${tag}/${name}`, {})
}
writeFileSync(out, Buffer.from(await res.arrayBuffer()))
console.error(`${name}: ${res.headers.get('content-length') ?? '?'} bytes`)

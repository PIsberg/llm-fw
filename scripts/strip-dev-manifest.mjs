// Rewrites package.json in place without its devDependencies. The release
// workflow runs it right before `npm publish`, so the manifest on npmjs.org
// lists no test or build tooling. Never run it on a working checkout you keep:
// it deletes the field. See docs/DEPENDENCIES.md.
import { readFileSync, writeFileSync } from 'node:fs'

const file = process.argv[2] ?? 'package.json'
const pkg = JSON.parse(readFileSync(file, 'utf8'))
const removed = Object.keys(pkg.devDependencies ?? {}).length
delete pkg.devDependencies
if (pkg.scripts) delete pkg.scripts.prepare
writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`)
console.log(`${file}: removed ${removed} devDependencies`)

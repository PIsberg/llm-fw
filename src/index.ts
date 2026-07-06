// Public library entrypoint (Task C6). Everything else in src/ is reached
// through the CLI (`llm-fw`) or the proxy/dashboard servers; this file is the
// only supported surface for consuming llm-fw as an in-process dependency —
// see the README's "Use as a library" section.
export { createFirewall } from './api.js'
export type { Firewall, ScanInput, ScanVerdict, ScanSource, DeepPartial } from './api.js'
export type { Config } from './types.js'

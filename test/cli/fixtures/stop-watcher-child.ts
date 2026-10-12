// Stands in for `llm-fw start` in test/cli/stop.test.ts: it owns the pid file
// and registers the cross-platform stop watcher, and records that its graceful
// cleanup ran before exiting 0, which TerminateProcess would never allow.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { watchForStopRequest } from '../../../src/cli/stopRequest.js'

const dir = process.env.LLM_FW_DIR as string
writeFileSync(join(dir, 'llm-fw.pid'), String(process.pid))
watchForStopRequest(dir, process.pid, () => {
  writeFileSync(join(dir, 'cleaned-up'), 'yes')
  process.exit(0)
})
setInterval(() => { /* keep alive: the watcher's own timer is unref'd */ }, 1000)
writeFileSync(join(dir, 'ready'), 'yes')

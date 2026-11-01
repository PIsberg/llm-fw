/**
 * Whether this `llm-fw start` owns the machine's sinkhole: binds its TLS
 * port, re-applies the hosts entries and portproxy rule, and on shutdown
 * restores the hosts file and deletes the rule (#617).
 *
 * Its own config saying `proxy.mode: 'sinkhole'` makes it the owner. The
 * hosts-file marker is machine-wide, so it counts only for an instance on the
 * default data directory, where it covers `setup` having run elevated without
 * writing config.json (npm missing from the elevated PATH). An instance with
 * its own `LLM_FW_DIR` (a dev run, a test server) used to adopt the installed
 * instance's sinkhole from the marker alone, and its graceful exit would have
 * torn that sinkhole down. A standalone server redirects nothing on this host.
 */
export interface SinkholeOwnership {
  standalone: boolean
  mode: 'proxy' | 'sinkhole' | undefined
  hostsHasSinkhole: boolean
  /** LLM_FW_DIR is set, so this instance keeps its state somewhere of its own. */
  customLlmFwDir: boolean
}

export function ownsSinkhole(o: SinkholeOwnership): boolean {
  if (o.standalone) return false
  if (o.mode === 'sinkhole') return true
  return o.hostsHasSinkhole && !o.customLlmFwDir
}

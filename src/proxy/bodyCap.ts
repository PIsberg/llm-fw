import { constants } from 'node:buffer'

/**
 * `proxy.maxBodyBytes` as a byte limit. 0 means no cap (#532), the idiom nginx
 * and Envoy use, which the proxy's request path and the Realtime relay already
 * honoured; compared raw, 0 refused every gateway request with 413 and sent
 * every inspected response down the oversized fail-open path uninspected.
 */
export function bodyCap(maxBodyBytes: number): number {
  return maxBodyBytes > 0 ? maxBodyBytes : constants.MAX_LENGTH
}

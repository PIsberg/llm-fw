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

/**
 * The most a compressed body is inflated to when `proxy.maxBodyBytes` is 0
 * (#861). Decompression is synchronous, on the thread serving every client,
 * and a 130 KB gzip body expands to 128 MiB: with bodyCap's ~4 GiB as the
 * limit, one request held the event loop and could run the process out of
 * memory.
 */
export const MAX_DECODED_BYTES = 128 * 1024 * 1024

/** The output limit for decoding a Content-Encoding: the body cap, or MAX_DECODED_BYTES when there is none. */
export function decodeCap(maxBodyBytes: number): number {
  return maxBodyBytes > 0 ? maxBodyBytes : MAX_DECODED_BYTES
}

import { isIP } from 'node:net';

/**
 * The TLS server name (SNI) to send for `host`, or undefined for an IP
 * literal. RFC 6066 forbids an IP address in SNI; Node warns about it
 * (DEP0123) and a strict upstream refuses the handshake (#866). A bracketed
 * IPv6 literal from a URL counts as one.
 */
export function sniName(host: string): string | undefined {
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  return isIP(bare) === 0 ? host : undefined;
}

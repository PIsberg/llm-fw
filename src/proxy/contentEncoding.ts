import zlib from 'node:zlib';

/** An HTTP Content-Encoding this build cannot undo. */
export class UnsupportedEncoding extends Error {
  constructor(readonly encoding: string) {
    super(`unsupported Content-Encoding: ${encoding}`);
    this.name = 'UnsupportedEncoding';
  }
}

// zstd landed in node:zlib in Node 22.15; the supported floor is 22.0, so it
// is looked up rather than imported, and a zstd body on an older Node is
// refused like any other encoding this build cannot read.
const zstdDecompressSync = (zlib as unknown as {
  zstdDecompressSync?: (buf: Buffer, opts: { maxOutputLength: number }) => Buffer;
}).zstdDecompressSync;

function decodeOne(buf: Buffer, encoding: string, maxOutput: number): Buffer {
  const opts = { maxOutputLength: maxOutput };
  switch (encoding) {
    case '':
    case 'identity':
      return buf;
    case 'gzip':
    case 'x-gzip':
      return zlib.gunzipSync(buf, opts);
    case 'br':
      return zlib.brotliDecompressSync(buf, opts);
    case 'deflate':
      // Some clients send raw (headerless) deflate under this name.
      try { return zlib.inflateSync(buf, opts); } catch (err) {
        if (err instanceof RangeError) throw err;
        return zlib.inflateRawSync(buf, opts);
      }
    case 'zstd':
      if (zstdDecompressSync) return zstdDecompressSync(buf, opts);
      throw new UnsupportedEncoding(encoding);
    default:
      throw new UnsupportedEncoding(encoding);
  }
}

/**
 * The most encodings one body may stack (#861). Each is a full synchronous
 * pass up to the size limit, so an unbounded `gzip, gzip, ...` multiplied
 * the work; no real client sends more than two. `identity` does not count.
 */
export const MAX_ENCODINGS = 3;

/**
 * Undo a body's Content-Encoding so detection reads the text the provider (or,
 * for a response, the client) will read. Encodings listed in the header are
 * undone in reverse order of application. Throws UnsupportedEncoding for one
 * it cannot undo or a chain longer than MAX_ENCODINGS, a RangeError when the
 * output would pass `maxOutput` bytes (a few KB of gzip can expand to
 * gigabytes), and a zlib error on a corrupt stream.
 */
export function decodeContentEncoding(buf: Buffer, header: string, maxOutput: number): Buffer {
  const encodings = header.split(',').map(e => e.trim().toLowerCase()).filter(e => e && e !== 'identity');
  if (encodings.length > MAX_ENCODINGS) throw new UnsupportedEncoding(`a chain of ${encodings.length} encodings (${header.trim()})`);
  let out = buf;
  encodings.reverse();
  for (const enc of encodings) out = decodeOne(out, enc, maxOutput);
  return out;
}

import { describe, it } from 'vitest'
import fc from 'fast-check'
import {
  AnthropicParser,
  OpenAIParser,
  CohereParser,
  GeminiParser,
  BedrockParser,
} from '../../src/detection/parsers.js'
import { PayloadParser } from '../../src/types.js'
import { normalize, normalizeSemantic, extractCandidates } from '../../src/detection/normalize.js'

// Task C2 — property/fuzz tests: no PayloadParser method and no normalizer/
// decoder may ever THROW, regardless of how malformed, truncated, or
// type-confused the input is. A parser returning [] / {} for garbage is fine
// (and is exactly what the existing try/catch-per-method design already does
// for a JSON.parse failure); an uncaught exception is not — it would crash
// the request-handling path in proxy.ts (now bounded by detection.failMode,
// but a thrown parser is still a bug to fix at the source, not paper over).
//
// Runs are bounded (~200 per property) so the suite stays fast; the goal is
// broad structural coverage, not exhaustive search.
const NUM_RUNS = 200

const METHODS = [
  'extractPrompts',
  'extractSystem',
  'extractTools',
  'extractToolResults',
  'extractToolUses',
  'extractMediaBlocks',
  'extractConversation',
] as const satisfies readonly (keyof PayloadParser)[]

/**
 * Call every extraction method a parser exposes and rethrow with enough
 * context (which parser, which method, what body) to diagnose a crash found
 * by fast-check's shrunk counterexample.
 */
function callAllMethods(parser: PayloadParser, body: string): void {
  for (const method of METHODS) {
    const fn = parser[method] as ((b: string) => unknown) | undefined
    if (typeof fn !== 'function') continue
    try {
      fn.call(parser, body)
    } catch (err) {
      const preview = body.length > 300 ? `${body.slice(0, 300)}…` : body
      throw new Error(
        `${parser.constructor.name}.${method} threw on body ${JSON.stringify(preview)}: ${(err as Error)?.stack ?? String(err)}`
      )
    }
  }
}

const parsersUnderTest: [string, PayloadParser][] = [
  ['AnthropicParser', new AnthropicParser()],
  ['OpenAIParser', new OpenAIParser()],
  ['CohereParser', new CohereParser()],
  ['GeminiParser', new GeminiParser()],
  ['BedrockParser', new BedrockParser()],
]

describe.each(parsersUnderTest)('%s fuzzing (arbitrary JSON-shaped bodies)', (_name, parser) => {
  it('never throws on an arbitrary JSON value serialized as the body', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const body = JSON.stringify(value) ?? 'null'
        callAllMethods(parser, body)
      }),
      { numRuns: NUM_RUNS }
    )
  })

  it('never throws on an arbitrary (likely non-JSON) string body', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 300 }), (body) => {
        callAllMethods(parser, body)
      }),
      { numRuns: NUM_RUNS }
    )
  })
})

// ---------------------------------------------------------------------------
// Mutated real fixtures — realistic per-provider request/response bodies
// (messages + system/preamble + tools + tool_use/tool_calls/functionCall +
// tool_result + inline media), each put through three mutation strategies:
// truncation, random key deletion, and random scalar type-swaps. This
// exercises the parsers' structural assumptions (e.g. "content is always an
// array of objects") against bodies that are almost-but-not-quite valid,
// which fc.jsonValue() above rarely produces on its own (it has no notion of
// "delete one key from an otherwise-realistic body").
// ---------------------------------------------------------------------------

const FIXTURES: [string, PayloadParser, unknown][] = [
  [
    'AnthropicParser',
    new AnthropicParser(),
    {
      model: 'claude-3-5-sonnet',
      system: [{ type: 'text', text: 'You are a helpful assistant.' }],
      tools: [{ name: 'read_file', description: 'Reads a file from disk.' }],
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Read /etc/passwd' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } },
          ],
        },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'read_file', input: { path: '/etc/passwd' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'root:x:0:0:root:/root:/bin/bash' }] },
      ],
    },
  ],
  [
    'OpenAIParser',
    new OpenAIParser(),
    {
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'Be helpful.' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'hi' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } },
          ],
        },
        { role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: 'result text' },
      ],
      tools: [{ type: 'function', function: { name: 'lookup', description: 'Looks things up.', parameters: {} } }],
    },
  ],
  [
    'CohereParser',
    new CohereParser(),
    {
      message: 'hello',
      preamble: 'be nice',
      chat_history: [{ role: 'USER', message: 'earlier turn' }],
      tools: [{ function: { name: 'search', description: 'Searches the web.' } }],
      tool_calls: [{ name: 'search', parameters: { q: 'x' } }],
      tool_results: [{ call: { name: 'search' }, outputs: [{ result: 'data' }] }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'v2 hi' }] }],
    },
  ],
  [
    'GeminiParser',
    new GeminiParser(),
    {
      systemInstruction: { parts: [{ text: 'system text' }] },
      contents: [
        { role: 'user', parts: [{ text: 'hello' }, { inlineData: { mimeType: 'image/png', data: 'aGVsbG8=' } }] },
        { role: 'model', parts: [{ functionCall: { name: 'lookup', args: { q: 'x' } } }] },
        { role: 'user', parts: [{ functionResponse: { name: 'lookup', response: 'data' } }] },
      ],
      tools: [{ functionDeclarations: [{ name: 'lookup', description: 'Looks up data.' }] }],
      candidates: [{ content: { parts: [{ functionCall: { name: 'lookup2', args: {} } }] } }],
    },
  ],
  [
    'BedrockParser',
    new BedrockParser(),
    {
      messages: [
        { role: 'user', content: [{ text: 'hello' }, { image: { format: 'png', source: { bytes: 'aGVsbG8=' } } }] },
        { role: 'assistant', content: [{ toolUse: { toolUseId: 'tu1', name: 'lookup', input: { q: 'x' } } }] },
        { role: 'user', content: [{ toolResult: { toolUseId: 'tu1', content: [{ text: 'data' }] } }] },
      ],
      system: [{ text: 'system' }],
      toolConfig: { tools: [{ toolSpec: { name: 'lookup', description: 'Looks things up.' } }] },
      output: { message: { content: [{ toolUse: { name: 'lookup3', input: {} } }] } },
    },
  ],
]

/** Every (path, valueAtPath) pair in a JSON-ish tree, including the root ([]). */
function collectPaths(node: unknown, prefix: (string | number)[], out: (string | number)[][]): void {
  out.push(prefix)
  if (Array.isArray(node)) {
    node.forEach((child, i) => collectPaths(child, [...prefix, i], out))
  } else if (node !== null && typeof node === 'object') {
    for (const key of Object.keys(node as Record<string, unknown>)) {
      collectPaths((node as Record<string, unknown>)[key], [...prefix, key], out)
    }
  }
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** Delete the key/index at `path` from a deep clone of `root` (no-op path = whole doc becomes undefined). */
function deleteAtPath(root: unknown, path: (string | number)[]): unknown {
  if (path.length === 0) return undefined
  const clone = deepClone(root)
  let cur = clone as Record<string | number, unknown>
  for (let i = 0; i < path.length - 1; i++) cur = cur[path[i]!] as Record<string | number, unknown>
  const last = path[path.length - 1]!
  if (Array.isArray(cur)) cur.splice(last as number, 1)
  else if (cur && typeof cur === 'object') delete cur[last]
  return clone
}

/** Replace the value at `path` in a deep clone of `root` with `replacement`. */
function swapAtPath(root: unknown, path: (string | number)[], replacement: unknown): unknown {
  if (path.length === 0) return replacement
  const clone = deepClone(root)
  let cur = clone as Record<string | number, unknown>
  for (let i = 0; i < path.length - 1; i++) cur = cur[path[i]!] as Record<string | number, unknown>
  cur[path[path.length - 1]!] = replacement
  return clone
}

/** A body string that JSON.stringify may turn into `undefined` (deleted root) — normalize to a real string. */
function toBodyString(value: unknown): string {
  const s = JSON.stringify(value)
  return typeof s === 'string' ? s : 'null'
}

const typeSwapReplacement = fc.oneof(
  fc.constant(null),
  fc.boolean(),
  fc.integer(),
  fc.string({ maxLength: 20 }),
  fc.array(fc.string({ maxLength: 10 }), { maxLength: 3 }),
  fc.constant({}),
  fc.constant([]),
)

describe.each(FIXTURES)('%s fuzzing (mutated real fixtures)', (_name, parser, fixture) => {
  const body = JSON.stringify(fixture)
  const paths = (() => {
    const out: (string | number)[][] = []
    collectPaths(fixture, [], out)
    return out
  })()

  it('never throws when the body is truncated at an arbitrary offset', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: body.length }), (cut) => {
        callAllMethods(parser, body.slice(0, cut))
      }),
      { numRuns: NUM_RUNS }
    )
  })

  it('never throws when a random key/index is deleted from the fixture', () => {
    fc.assert(
      fc.property(fc.nat({ max: paths.length - 1 }), (idx) => {
        const mutated = deleteAtPath(fixture, paths[idx]!)
        callAllMethods(parser, toBodyString(mutated))
      }),
      { numRuns: NUM_RUNS }
    )
  })

  it('never throws when a random field is type-swapped in the fixture', () => {
    fc.assert(
      fc.property(fc.nat({ max: paths.length - 1 }), typeSwapReplacement, (idx, replacement) => {
        const mutated = swapAtPath(fixture, paths[idx]!, replacement)
        callAllMethods(parser, toBodyString(mutated))
      }),
      { numRuns: NUM_RUNS }
    )
  })
})

// ---------------------------------------------------------------------------
// normalize() / normalizeSemantic() / the full decoder chain (extractCandidates)
// — every evasion-normalization stage must survive arbitrary unicode input,
// including surrogate pairs, combining marks, control characters, and the
// invisible-character smuggling ranges these functions specifically target.
// ---------------------------------------------------------------------------
describe('normalize / normalizeSemantic / decoder chain fuzzing', () => {
  it('normalize() never throws on arbitrary unicode strings', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 500 }), (s) => {
        normalize(s)
      }),
      { numRuns: NUM_RUNS }
    )
  })

  it('normalizeSemantic() never throws on arbitrary unicode strings', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 500 }), (s) => {
        normalizeSemantic(s)
      }),
      { numRuns: NUM_RUNS }
    )
  })

  it('extractCandidates() — the full decoder chain — never throws on arbitrary unicode strings', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 500 }), (s) => {
        extractCandidates(s)
      }),
      { numRuns: NUM_RUNS }
    )
  })

  // NOTE on idempotence: normalize.ts does not document any decoder or the
  // top-level normalize()/normalizeSemantic() as idempotent, and fuzzing
  // turned up a genuine (if obscure) counterexample — U+2017 DOUBLE LOW LINE
  // has no canonical (NFD) decomposition but DOES have a compatibility
  // (NFKC) one, to SPACE + U+0333 COMBINING DOUBLE LOW LINE. normalize()
  // strips \p{Diacritic} BEFORE its NFKC step, so the first pass sees only
  // U+2017 (not Diacritic) and lets it through NFKC into a bare combining
  // mark, while a second pass then strips that now-exposed mark — two passes
  // disagree. Reordering the pipeline to fix this would touch the shared,
  // e5-calibration-locked normalize() used by every detection stage, which is
  // out of scope for a fuzz-hardening task; scoped here to the documented
  // invariant only (never throws), not idempotence.
})

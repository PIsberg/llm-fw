// ASCII smuggling / Unicode-tag injection detector.
//
// A class of prompt injection that hides instructions in characters that render
// as NOTHING for a human (and in this dashboard) but are still tokenized and
// acted on by the LLM. The standard normalization pass strips ordinary
// zero-width characters but not these ranges, so a payload written entirely in
// them sails past the heuristic/embedding/judge stages untouched.
//
// Channels detected:
//   • Unicode Tags block (U+E0000–U+E007F) — the primary "ASCII smuggling"
//     vector. U+E0020–U+E007E mirror printable ASCII (codepoint − 0xE0000), so
//     an entire sentence ("ignore all previous instructions") can be encoded in
//     invisible tag characters and recovered verbatim.
//   • Bidi OVERRIDES (U+202D LRO, U+202E RLO) — reorder rendered text so what a
//     reviewer sees differs from the logical bytes the model receives. Rarely
//     legitimate in chat text; classic Trojan-Source spoofing.
//   • Variation-selector SUPPLEMENT (U+E0100–U+E01EF) — plane-14 selectors with
//     no legitimate use in prompt text; an emerging covert side channel.
//
// We deliberately do NOT block on the common-and-benign invisibles (emoji
// zero-width joiners, VS16 U+FE0F, bidi isolates/embeddings, RTL marks): those
// appear in legitimate multilingual and emoji text and would be false
// positives. They are still reported in `ranges` for visibility and stripped by
// normalize(), just not treated as blockworthy on their own.

export type HiddenCharRange =
  | 'unicode-tags'
  | 'bidi-override'
  | 'bidi-isolate'
  | 'variation-selector'
  | 'zero-width'

export interface HiddenCharResult {
  /** True when a blockworthy channel (tags, bidi-override, VS-supplement) is present. */
  hasHidden: boolean
  /** ASCII recovered from Unicode Tag characters (trimmed; '' if none decodable). */
  decoded: string
  /** Every invisible-character category found, blockworthy or not. */
  ranges: HiddenCharRange[]
}

// Categories that on their own justify a block — essentially never legitimate in
// prompt text.
const BLOCKWORTHY: ReadonlySet<HiddenCharRange> = new Set<HiddenCharRange>([
  'unicode-tags',
  'bidi-override',
  'variation-selector',
])

/**
 * Scan text for invisible-character smuggling channels.
 *
 * Iterates by code point (so astral-plane characters are handled correctly),
 * recovers any ASCII hidden in the Unicode Tags block, and reports which
 * channels were seen. Pure and allocation-light — safe to call on every prompt.
 */
export function detectHiddenChars(text: string): HiddenCharResult {
  if (!text) return { hasHidden: false, decoded: '', ranges: [] }

  const ranges = new Set<HiddenCharRange>()
  let decoded = ''

  for (const ch of text) {
    const cp = ch.codePointAt(0)
    if (cp === undefined) continue

    if (cp >= 0xe0000 && cp <= 0xe007f) {
      ranges.add('unicode-tags')
      // U+E0020–U+E007E mirror printable ASCII; recover the hidden message.
      if (cp >= 0xe0020 && cp <= 0xe007e) decoded += String.fromCharCode(cp - 0xe0000)
    } else if (cp === 0x202d || cp === 0x202e) {
      ranges.add('bidi-override')
    } else if ((cp >= 0x202a && cp <= 0x202c) || (cp >= 0x2066 && cp <= 0x2069)) {
      ranges.add('bidi-isolate')
    } else if (cp >= 0xe0100 && cp <= 0xe01ef) {
      ranges.add('variation-selector')
    } else if (cp === 0x200b || cp === 0x200c || cp === 0x200d || cp === 0x2060 || cp === 0xfeff) {
      ranges.add('zero-width')
    }
  }

  const hasHidden = Array.from(ranges).some(r => BLOCKWORTHY.has(r))
  return { hasHidden, decoded: decoded.trim(), ranges: Array.from(ranges) }
}

// Single regex covering every invisible range above, for normalize() to strip so
// hidden characters cannot fragment tokens for the other detection stages. The
// raw prompt is still scanned by detectHiddenChars() BEFORE normalization, so
// stripping here never erases evidence of the attack. Covers: zero-width
// (200B–200D, 2060, FEFF), bidi controls (202A–202E, 2066–2069), variation
// selectors (FE00–FE0F + plane-14 E0100–E01EF), and the Tags block (E0000–E007F).
export const HIDDEN_CHAR_STRIP_RE =
  /[\u{200B}-\u{200D}\u{2060}\u{FEFF}\u{202A}-\u{202E}\u{2066}-\u{2069}\u{FE00}-\u{FE0F}\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu

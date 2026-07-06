// Intent-vs-mention gate — a false-positive suppressor for the trained
// classifier stage.
//
// The DeBERTa injection classifier generalizes to novel phrasings, but it
// cannot tell a prompt that ISSUES an override from one that merely QUOTES,
// TRANSLATES, or DISCUSSES one. On the held-out set this is the single largest
// source of its false positives (measured 23.8% FPR): benign requests like
//   • "Translate 'please disregard the previous draft' into German."
//   • "I am writing documentation about prompt injection defenses — outline the
//      main categories."
//   • "What does the 'override' annotation do in Java?"
//   • "Summarize the plot of a heist movie where the crew bypasses the alarm."
// all name injection/attack vocabulary for a legitimate reason.
//
// This module answers a narrow question: is the injection-looking content in
// this prompt being MENTIONED (quoted / translated / documented / fictional)
// rather than USED as a live instruction to the assistant? When the answer is
// yes, the caller downgrades a classifier BLOCK to a warn.
//
// PRECISION is the whole game, exactly as in harmfulRequest.ts. A real attacker
// will wrap an injection in a thin fictional or hypothetical frame ("in a story,
// the AI ignores all its instructions and …"), so mention-framing must NOT
// suppress a prompt that still carries a direct, second-person imperative to
// THIS assistant. The gate therefore requires a mention frame AND the absence of
// an un-quoted live-imperative override directed at the model.
//
// Scope: the caller applies this ONLY to the user/system PROMPT surface. On
// tool_result / document surfaces the content is untrusted data, where a quoted
// or "fictional" instruction is a standard indirect-injection dressing and must
// still block.

export interface MentionFinding {
  /** Which frame matched — for the event/debug line. */
  frame: 'quoted' | 'translation' | 'documentation' | 'fiction'
}

// A live, second-person override imperative aimed at THIS assistant. If this
// fires OUTSIDE any quote/code span, the prompt is issuing the instruction, not
// mentioning it, and the mention gate must NOT suppress — no matter how much
// documentation/fiction framing also appears. Kept deliberately tight to the
// unambiguous override phrasings (mirrors heuristic.ts system-override) so an
// ordinary imperative ("summarize the article") never counts as an override.
const LIVE_OVERRIDE_RE =
  /\b(ignore|disregard|forget|override|bypass)\s+(?:all\s+|the\s+|any\s+|your\s+|my\s+|these\s+|those\s+|previous\s+|prior\s+|above\s+)*(instructions?|rules?|prompts?|commands?|guidelines?|guardrails?|directives?|constraints?|polic(?:y|ies))\b/i

// Translation / localization request: the injection vocabulary is the OBJECT of
// a translate verb, so it is data to be rendered in another language.
const TRANSLATION_RE =
  /\b(translat\w+|localiz\w+|render\s+(?:this|the following|it)\s+in(?:to)?|how\s+(?:do|would)\s+you\s+say|what\s+is\s+.{0,40}\s+in\s+(?:french|german|spanish|italian|portuguese|japanese|chinese|korean|arabic|russian|hindi|dutch|swedish|polish)\b)/i

// Documentation / meta-discussion: the prompt is ABOUT injection/security as a
// topic (writing docs, explaining a concept, outlining categories), not
// commanding the model. Pairs a meta verb with an injection/security topic word.
const META_VERB_RE =
  /\b(documentation|document|write\s+(?:up\s+)?(?:documentation|docs|an?\s+(?:article|essay|guide|explainer|blog\s+post))|explain|describe|outline|summari[sz]e|what\s+(?:does|is|are)|define|discuss|teach\s+me\s+about|analy[sz]e|compare|list\s+the)\b/i
const SECURITY_TOPIC_RE =
  /\b(prompt\s+injection\w*|jailbreak\w*|injection\s+(?:attack|defen[cs]e|technique)\w*|prompt\s+leak\w*|adversarial\s+prompt\w*|the\s+['"`]?override['"`]?\s+(?:annotation|keyword|flag|attribute|decorator)|social\s+engineering|guardrail\w*|red[-\s]?team\w*)\b/i

// Fictional framing: story / novel / screenplay / game. Reused shape from
// harmfulRequest.FICTION_RE.
const FICTION_RE =
  /\b(fiction\w*|novels?\b|short\s+story|screenplay|movie\s+(?:plot|script)|television\s+script\w*|tv\s+script\w*|in\s+a\s+(?:story|game|novel|movie|film|play)|narrative\s+where|a\s+(?:heist|thriller|spy|caper)\s+(?:movie|film|novel|story)|role[-\s]?play\w*\s+(?:a|an|as))\b/i

/**
 * Return the character spans covered by quotes, backticks, or fenced code
 * blocks. Content inside these is being shown/quoted, not issued.
 */
function quotedSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = []
  // Fenced code blocks first (```...```), then inline runs of quote/backtick.
  const patterns = [
    /```[\s\S]*?```/g,
    /"[^"]{1,400}"/g,
    // Bare apostrophe quoting: guard against contractions ("it's", "let's")
    // opening a phantom span. Only treat `'` as an opening quote when it is
    // NOT preceded by a letter/digit, and require the closing `'` not be
    // immediately followed by a letter (so "It's simple: … let's go" does not
    // get read as a quoted span from the first `'s` to the last `'`).
    /(?<![\p{L}\p{N}])'[^']{1,400}'(?![\p{L}])/gu,
    /`[^`]{1,400}`/g,
    /“[^”]{1,400}”/g, // “ … ”
    /‘[^’]{1,400}’/g, // ‘ … ’
    /«[^»]{1,400}»/g, // « … »
  ]
  for (const re of patterns) {
    let m: RegExpExecArray | null
    re.lastIndex = 0
    while ((m = re.exec(text)) !== null) {
      spans.push([m.index, m.index + m[0].length])
      if (m.index === re.lastIndex) re.lastIndex++ // guard against zero-width
    }
  }
  return spans
}

function indexInSpans(index: number, spans: Array<[number, number]>): boolean {
  return spans.some(([a, b]) => index >= a && index < b)
}

/**
 * Decide whether a prompt MENTIONS rather than ISSUES injection content. Pure;
 * runs on the raw user/system prompt text. Returns the matched frame, or null.
 *
 * A prompt is treated as mention-framed only when a quote/translation/
 * documentation/fiction frame is present AND there is no LIVE override
 * imperative sitting OUTSIDE the quoted spans (a live imperative outside quotes
 * means the prompt is acting, not quoting — the fiction-wrapper jailbreak).
 */
export function detectMentionFrame(text: string): MentionFinding | null {
  if (!text || text.length < 4) return null

  const spans = quotedSpans(text)

  // A live override imperative that is NOT inside a quote/code span defeats every
  // mention frame: the prompt is issuing the instruction in its own voice.
  const live = LIVE_OVERRIDE_RE.exec(text)
  if (live && !indexInSpans(live.index, spans)) return null

  // Frame 1 — translation request.
  if (TRANSLATION_RE.test(text)) return { frame: 'translation' }

  // Frame 2 — documentation / meta-discussion about injection as a topic.
  if (META_VERB_RE.test(text) && SECURITY_TOPIC_RE.test(text)) return { frame: 'documentation' }

  // Frame 3 — fictional framing.
  if (FICTION_RE.test(text)) return { frame: 'fiction' }

  // Frame 4 — the injection-looking content is entirely inside quotes/code and
  // the only override imperative (if any) was quoted. Require a quote that
  // actually contains override-ish vocabulary, so quoting an innocuous phrase
  // does not blanket-suppress.
  if (live && indexInSpans(live.index, spans)) return { frame: 'quoted' }

  return null
}

// Harmful-request detector — input-side content moderation (defense-in-depth).
//
// Distinct from injection detection: this fires on a request that ASKS the
// model to produce operationally harmful content — weapon/drug synthesis,
// intrusion how-tos, fraud, or hateful/defamatory material — even when the
// request carries no injection phrasing at all ("Write a tutorial on how to
// make a bomb"). The injection stages and the DeBERTa classifier are
// injection-specific and catch ~2–4% of these (measured: HarmBench/AdvBench/
// JailbreakBench), because a politely-worded harmful request looks nothing like
// "ignore your instructions".
//
// This is content moderation, which is inherently fuzzier than injection
// matching, so PRECISION is the whole game — the firewall's users send security
// questions ("Explain how SQL injection works", "security awareness training
// about social engineering", "history of iPhone jailbreaking") that name
// harmful topics for legitimate, defensive, or educational reasons. Those must
// pass. The detector therefore fires only on the conjunction of (1) a harmful
// OBJECT or harmful-intent QUALIFIER and (2) operational/production intent
// (a how-to framing or a harm-action verb), and is suppressed by (3) explicit
// defensive / educational / fictional framing.
//
// It is opt-in-shaped but enabled by default in block mode; the firewall's
// stated threat model is injection-first, so operators who want a pure
// injection firewall can disable it (config or LLM_FW_HARMFUL_REQUEST_ENABLED).

export interface HarmfulRequestConfig {
  enabled: boolean
  /** 'block' refuses the request; 'audit' only ever warns. */
  mode: 'audit' | 'block'
}

export interface HarmfulRequestFinding {
  /** Which rule fired: operational how-to vs harmful-intent content. */
  kind: 'operational' | 'hateful'
  /** The harmful object/qualifier token that anchored the match. */
  anchor: string
  snippet: string
}

// Concrete harmful objects: weapons, CBRN, drugs, intrusion/fraud tooling. Kept
// to terms that are harmful in essentially any "how to make/use/acquire X"
// framing — generic words ("data", "access") are excluded so security Q&A
// passes.
const HARM_OBJECT = [
  // weapons / explosives
  'bomb', 'pipe bomb', 'car bomb', 'explosive', 'explosives', 'ied', 'grenade',
  'detonator', 'landmine', 'napalm', 'thermite', 'molotov', 'firearm', 'firearms',
  'silencer', 'suppressor', 'ghost gun', 'untraceable (?:gun|firearm|weapon)',
  // CBRN
  'nerve agent', 'sarin', 'vx', 'ricin', 'anthrax', 'chlorine gas', 'mustard gas',
  'dimethylmercury', 'lewisite', 'novichok', 'tabun', 'soman',
  'chemical weapon', 'chemical warfare', 'biological weapon',
  'bioweapon', 'biological warfare', 'dirty bomb', 'radiological', 'nuclear (?:bomb|device|weapon)',
  'weaponize\\w*',
  // drugs
  'methamphetamine', 'meth lab', 'crystal meth', 'cocaine', 'heroin', 'fentanyl',
  'mdma', 'lsd', 'illegal drug', 'illegal drugs', 'controlled substance',
  // poisons / specific pathogens
  'untraceable poison', 'lethal dose', 'deadly poison',
  'cholera', 'tetrodotoxin', 'strychnine', 'parathion', 'nitazene\\w*',
  // cyber / intrusion
  'malware', 'ransomware', 'keylogger', 'rootkit', 'botnet', 'spyware', 'trojan',
  'computer virus', 'backdoor', 'reverse shell', 'sql injection', 'buffer overflow',
  'privilege escalation', 'zero-day', 'zero day',
  'exploit\\w*\\s+(?:a\\s+|an?\\s+|the\\s+)?(?:\\w+\\s+)?vulnerabilit\\w+',
  'security\\s+vulnerabilit\\w+', 'disables?\\s+antivirus', 'ddos', 'denial[-\\s]of[-\\s]service',
  'syn\\s+flood', 'dns\\s+amplification', 'rainbow\\s+table',
  // weapons (variants)
  'assassinat\\w+', 'glock\\s+switch', 'full\\s+auto', 'auto\\s+sear', 'machine\\s+gun', 'untraceable\\s+weapon',
  // fraud / illicit
  'counterfeit', 'identity theft', 'credit card dump', 'stolen credit card',
  'money laundering', 'launder money', 'ponzi scheme', 'phishing', 'card\\s+skimm\\w+',
  'skimming\\s+device', 'insider\\s+trading', 'hitman', 'hit\\s+man', 'human\\s+(?:organ|trafficking)',
  'organ\\s+(?:trafficking|harvest\\w+)', 'black\\s+market', 'elephant\\s+ivory', 'child\\s+(?:porn\\w*|exploitation)',
  'sex\\s+trafficking', 'sexual\\s+exploitation',
  // coercive content objects
  'blackmail\\w*', 'ransom\\s+note', 'death\\s+threat\\w*',
]

const HARM_OBJECT_RE = new RegExp('\\b(' + HARM_OBJECT.join('|') + ')\\b', 'i')

// Harm-action verbs — the "doing harm" sense, paired with a harmful object or a
// harmful direct object (someone's identity, into a system).
const HARM_ACTION_RE =
  /\b(make|build|manufactur\w*|synthesi[sz]e|produce|assemble|construct|cook|brew|cultivat\w*|detonate|hotwire|hack(?:ing)?\s+into|break\s+into|infiltrat\w*|exploit|breach|steal(?:ing)?|rob|embezzl\w*|launder\w*|smuggl\w*|traffic\w*|counterfeit\w*|forge|evade|bypass|circumvent|poison|kill|murder|assassinat\w*|sabotage|stalk|dox|blackmail|extort\w*|defraud|scam|contaminat\w*)\b/i

// Operational/instructional framing — the request wants a procedure, not an
// explanation.
const HOWTO_RE =
  /\b(how\s+to|instructions?\s+(?:for|on|to)|step[-\s]?by[-\s]?step|steps?\s+(?:to|for)|tutorial\s+(?:on|for)?|guide\s+(?:to|on|for)|walk(?:through|\s+me\s+through)|detailed\s+(?:instructions?|guide|tutorial|steps?|process)|recipe\s+for|blueprint\s+for|teach\s+\w+\s+(?:how|to)|give\s+(?:me\s+)?(?:detailed\s+)?(?:instructions?|steps?|a\s+tutorial))\b/i

// Harmful-intent qualifiers for the social-harm class (JailbreakBench): the
// request asks to PRODUCE content whose purpose is harm. These distinguish the
// harmful version from its benign paraphrase ("sexist email" vs "email"). The
// adjective itself carries the harmful intent, so it fires on its own.
const HATEFUL_QUALIFIER_RE =
  /\b(defamatory|libelous|slanderous|sexist|misogynist\w*|racist|xenophobic|homophobic|transphobic|antisemit\w*|bigoted|hateful|hate\s+speech|hate\s+mail|harass\w*|body[-\s]?sham\w*|dehumaniz\w*|enslav\w*|blackmail\w*|extort\w*|racial\s+slur\w*|self[-\s]?harm\s+(?:instructions?|guide|methods?)|how\s+to\s+(?:harm|hurt|abuse|stalk|dox)\s+(?:a\s+)?(?:child|children|someone|people|a\s+person))\b/i

// Topics that are benign to DISCUSS but harmful to ADVOCATE — they fire only
// alongside incitement framing, so "an article about ethnic genocide" (benign
// per JBB) passes while "a speech that promotes genocide" blocks.
const INCITE_TOPIC_RE = /\b(violence|terrorism|terrorist\w*|genocide|ethnic\s+cleansing|holocaust|nazi\s+party|self[-\s]?harm|suicide|anorexia|bulimia|hatred|animal\s+cruelty|sexual\s+assault|stalking|child\s+(?:abuse|labor|labour))\b/i
const INCITE_FRAME_RE = /\b(incit\w*|promot\w*|glorif\w*|advocat\w*|encourag\w*|normaliz[ei]\w*|romanticiz[ei]\w*|trivializ[ei]\w*|in\s+favou?r\s+of|argue[s]?\s+for|justif\w*|praise[s]?|celebrat\w*)\b/i

// Content-production verbs — for the hateful and intrusion rules, the request
// must ask to generate something. Bare "make" is excluded (it matches "make
// sure …" in narrative text); "make a bomb" is handled by HARM_ACTION in Rule 1.
const PRODUCE_RE =
  /\b(write|create|draft|compose|generate|design|produce|develop|post|publish|craft|construct|build\s+(?:a|an|me)|give\s+me|offer\s+a)\b/i

// Defensive / educational framing that flips a harmful-topic mention back to
// legitimate. When present, the request is about understanding, preventing, or
// historicizing — not perpetrating. (Security Q&A and history are core benign
// traffic: "Explain how SQL injection works", "history of iPhone jailbreaking".)
// NOTE: "detect" is scoped to defensive *detection of* threats, NOT bare
// "detection" — attackers write "without detection" / "evade detection" /
// "easy to make at home without detection", and a bare `detect\w*` was
// suppressing those genuine attacks.
const DEFENSIVE_RE =
  /\b(prevent\w*|protect\w*|defen[ds]\w*|defence|mitigat\w*|(?:how\s+to\s+)?detect\s+(?:and\s+\w+\s+)?(?:threats?|intrusions?|attacks?|malware|fraud|phishing|anomal\w*|breaches?|injection)|secur\w*\s+(?:against|your|the|my|a\b)|safeguard\w*|guard\s+against|awareness|best\s+practices?|harden\w*|patch\w*|remediat\w*|how\s+(?:does|do|did|it)\s+\w+\s+work|how\s+\w+\s+works?|has\s+evolved|evolution\s+of|evolved\s+over|legal\s+status|legality|legally\b|history\s+of|historical\w*|ethical\w*|ethics\s+of|responsibl\w*|academic|for\s+research|research\s+purposes|difference\s+between|what\s+is\b|what\s+are\b|explain\s+the\s+concept|an?\s+(?:article|essay|report|paper|piece)\s+(?:about|on)\s+how\s+(?!to\b)|expose\s+and\s+condemn|condemn\s+users?\s+of)\b/i

// Benign data-transform framing — the request operates over PROVIDED content
// (summarize/outline/answer/classify the following …), so a harmful word in the
// text is part of the DATA, not the ask. Heavy false-positive source on the
// injection sets, where prompts wrap arbitrary articles/movie-plots/reviews.
const DATA_TRANSFORM_RE =
  /\b(summari[sz]e|outline|rephrase|paraphrase|proofread|translat\w*|classif\w*|categori[sz]e|synthesi[sz]e\s+(?:these|the|all|this|several)|these\s+(?:documents?|texts?|articles?|notes?|files?|passages?|reviews?)|the\s+(?:following|above|below|context|passage|article|document|text|review|tweet|movie\s+plot)|based\s+on\s+the\s+(?:following|context|passage|text|article)|answer\s+(?:the|this)\s+question|generate\s+a\s+question|right\s+answer\s+to\s+the\s+question|review\s+left\s+by|product\s+(?:review|plot))\b/i

// Fictional framing. A benign story that merely MENTIONS a harmful topic
// ("a fictional story in which the character uses heroin") is allowed — but only
// when there's no operational how-to, since "write a fictional story explaining
// how to synthesize X" is the classic fiction-wrapper jailbreak (still caught by
// the how-to path below).
const FICTION_RE =
  /\b(fiction\w*|a\s+novel|short\s+story|screenplay|movie\s+(?:plot|script)|in\s+a\s+(?:story|game|novel|movie|film|play)|narrative\s+where|biography\s+where|play\s+script|a\s+play\s+where|stage\s+play)\b/i

function snippetAround(text: string, index: number, len: number): string {
  const start = Math.max(0, index - 30)
  const end = Math.min(text.length, index + len + 70)
  return text.slice(start, end).replace(/\s+/g, ' ').trim()
}

/**
 * Detect a request for operationally harmful content. Pure; runs on the raw
 * user/system prompt text. Returns the first finding or null.
 */
export function detectHarmfulRequest(text: string): HarmfulRequestFinding | null {
  if (!text || text.length < 8) return null

  const hasHowto = HOWTO_RE.test(text)

  // Suppressors. Defensive/educational framing and data-transform-over-provided-
  // content always win. Fictional framing wins UNLESS the request also asks for
  // an operational how-to (the fiction-wrapper jailbreak).
  if (DEFENSIVE_RE.test(text)) return null
  if (DATA_TRANSFORM_RE.test(text)) return null
  if (FICTION_RE.test(text) && !hasHowto) return null

  // Rule 1 — operational harm: a concrete harmful object asked about with
  // production/how-to intent, OR a harm-action verb aimed at a harmful object.
  const obj = HARM_OBJECT_RE.exec(text)
  if (obj) {
    if (hasHowto || HARM_ACTION_RE.test(text) || PRODUCE_RE.test(text)) {
      return { kind: 'operational', anchor: obj[1].toLowerCase(), snippet: snippetAround(text, obj.index, obj[1].length) }
    }
  }

  // Rule 1b — intrusion/theft/fraud against a person or system, without a listed
  // object ("hack into a government database and steal sensitive information",
  // "steal someone's identity"). Narrow verb set (unambiguously harmful actions)
  // + an explicit target, plus how-to/production framing.
  const INTRUSION_RE = /\b(hack(?:ing)?|hijack\w*|crack(?:ing)?|break\s+into|breaking\s+into|infiltrat\w*|breach\w*|exploit\w*|steal\w*|embezzl\w*|launder\w*|smuggl\w*|defraud\w*|forge|counterfeit\w*)\b/i
  const intr = INTRUSION_RE.exec(text)
  if (intr && (hasHowto || PRODUCE_RE.test(text))) {
    const tail = text.slice(intr.index, intr.index + 70)
    if (/\b(into|someone'?s?|a\s+(?:government|bank|corporate|private|secure)|the\s+\w+\s+(?:database|system|network|account|server)|identit\w+|accounts?|credentials?|passwords?|security\s+measures?|sensitive\s+(?:information|data)|money|funds)\b/i.test(tail)) {
      return { kind: 'operational', anchor: intr[1].toLowerCase(), snippet: snippetAround(text, intr.index, intr[1].length) }
    }
  }

  // Rule 1c — violence against a person. A kill/assault/poison verb aimed at a
  // human target ("poison a person's food", "assassinate a high-profile
  // individual", "physically assault someone without leaving evidence",
  // "manipulate someone into committing suicide") with instructional/production
  // framing. The human-target requirement keeps benign uses out ("kill a
  // process", "poison cache", "assault course").
  const VIOLENCE_RE = /\b(kill|murder|assassinat\w*|poison|assault|attack|harm|hurt|maim|torture|abduct|kidnap|strangle|stab|shoot)\b/i
  const viol = VIOLENCE_RE.exec(text)
  if (viol && (hasHowto || PRODUCE_RE.test(text))) {
    const tail = text.slice(viol.index, viol.index + 80)
    if (/\b(a\s+(?:person|child|baby|infant|toddler|man|woman|human|individual|victim|colleague|someone)|someone|some\s?one|people|others?|a\s+high[-\s]profile|an?\s+individual|the\s+(?:victim|target|president|politician)|children|humans?|his|her|their)\b/i.test(tail)) {
      return { kind: 'operational', anchor: viol[1].toLowerCase(), snippet: snippetAround(text, viol.index, viol[1].length) }
    }
  }

  // Rule 2 — hateful / harmful-intent content production.
  const hasProduce = PRODUCE_RE.test(text)
  const qual = HATEFUL_QUALIFIER_RE.exec(text)
  if (qual && hasProduce) {
    return { kind: 'hateful', anchor: qual[1].toLowerCase(), snippet: snippetAround(text, qual.index, qual[1].length) }
  }
  // Incite-topic only with explicit incitement framing.
  const topic = INCITE_TOPIC_RE.exec(text)
  if (topic && hasProduce && INCITE_FRAME_RE.test(text)) {
    return { kind: 'hateful', anchor: topic[1].toLowerCase(), snippet: snippetAround(text, topic.index, topic[1].length) }
  }

  return null
}

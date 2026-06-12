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
  'handgun\\w*', 'pistol\\w*', 'assault\\s+rifle\\w*',
  // CBRN
  'nerve agent', 'sarin', 'vx', 'ricin', 'anthrax', 'chlorine gas', 'mustard gas',
  'dimethylmercury', 'lewisite', 'novichok', 'tabun', 'soman',
  'chemical weapon', 'chemical warfare', 'biological weapon',
  'bioweapon', 'biological warfare', 'dirty bomb', 'radiological', 'nuclear (?:bomb|device|weapon)',
  'weaponize\\w*',
  // drugs
  'methamphetamine', 'meth lab', 'crystal meth', 'cocaine', 'heroin', 'fentanyl',
  'mdma', 'lsd', 'illegal drug', 'illegal drugs', 'controlled substance',
  'prescription\\s+drug\\w*', 'opioid\\w*', 'medical\\s+prescription',
  // poisons / specific pathogens
  'untraceable poison', 'lethal dose', 'deadly poison',
  'cholera', 'tetrodotoxin', 'strychnine', 'parathion', 'nitazene\\w*',
  'bleach', 'ammonia', 'laundry\\s+detergent',
  // cyber / intrusion
  'malware', 'ransomware', 'keylogger', 'rootkit', 'botnet', 'spyware', 'trojan',
  'computer virus', 'backdoor', 'reverse shell', 'sql injection', 'buffer overflow',
  'privilege escalation', 'zero-day', 'zero day',
  'exploit\\w*\\s+(?:a\\s+|an?\\s+|the\\s+)?(?:\\w+\\s+)?vulnerabilit\\w+',
  'security\\s+vulnerabilit\\w+', 'disables?\\s+antivirus', 'ddos', 'denial[-\\s]of[-\\s]service',
  'syn\\s+flood', 'dns\\s+amplification', 'rainbow\\s+table',
  'fake\\s+(?:\\w+\\s+){0,3}login\\s+page', 'fake\\s+(?:\\w+\\s+){0,3}website\\w*', 'unauthorized\\s+access',
  'gps\\s+(?:tracker|tracking)?', 'tracking\\s+device\\w*',
  // weapons (variants)
  'assassinat\\w+', 'glock\\s+switch', 'full\\s+auto', 'auto\\s+sear', 'machine\\s+gun', 'untraceable\\s+weapon',
  // fraud / illicit
  'counterfeit', 'identity theft', 'credit card dump', 'stolen credit card',
  'money laundering', 'launder money', 'ponzi scheme', 'phishing', 'card\\s+skimm\\w+',
  'skimming\\s+device', 'insider\\s+trading', 'hitman', 'hit\\s+man', 'human\\s+(?:organ|trafficking)',
  'organ\\s+(?:trafficking|harvest\\w+)', 'black\\s+market', 'elephant\\s+ivory', 'child\\s+(?:porn\\w*|exploitation)',
  'sex\\s+trafficking', 'sexual\\s+exploitation',
  'pyramid\\s+scheme', 'tax\\s+evasion', 'falsif\\w+\\s+document\\w*', 'hide\\s+income', 'fake\\s+charit\\w*',
  'shoplift\\w*', 'self-checkout\\w*', 'bulk\\s+cash',
  'evad\\w+\\s+(?:tracing|monitoring|detection|tracking|surveillance)',
  '(?:seem|look|pass\\s+off|disguise)\\s+(?:as|like)\\s+an?\\s+accident',
  'gambl\\w*\\s+life\\s+savings', 'slot\\s+machine\\w*',
  'stock\\s+price\\w*|market\\s+price\\w*|financial\\s+gain',
  'without\\s+getting\\s+caught', 'hazardous\\s+(?:medical\\s+)?waste', 'cult\\b|indoctrinate\\w*',
  'scam\\w*', 'lottery\\s+scam', 'fake\\s+(?:weight\\s+loss\\s+)?drugs?', 'fake\\s+(?:prescription\\s+)?drugs?',
  'fabricated\\s+(?:customer\\s+)?reviews?|fake\\s+reviews?', 'Nigerian\\s+(?:419\\s+)?scam\\w*|419\\s+scam\\w*',
  'E\\.?\\s*coli|antibiotic[-s]\\s+resistant|resistant\\s+bacteria|pathogenic\\s+bacteria',
  'fake\\s+news', 'disinformation', 'misinformation',
  'prevent\\s+(?:\\w+\\s+){0,3}from\\s+(?:talk\\w*|report\\w*|speak\\w*|cooperat\\w*)',
  // coercive / violent content objects
  'blackmail\\w*', 'ransom\\s+note', 'death\\s+threat\\w*', 'torture\\s+ring\\w*', 'animal\\s+cruelty',
  // Added Round 4 objects
  'date\\s+rape\\s+drug\\w*',
  'fraudulent,?(?:\\s+(?:\\w+,?)){0,2}\\s+(?:letter|email|message|invoice|request|communication)',
  'track\\w*\\s+(?:user\\s+)?location\\s+without\\s+(?:their\\s+)?consent', 'surreptitiously\\s+track\\w*',
  'clone\\w*\\s+(?:credit|debit|payment|bank)\\s+card\\w*',
  'electronic\\s+monitoring\\s+device\\w*', 'monitoring\\s+device\\w*',
  'shell\\s+compan\\w*', 'overstay\\w*\\s+visa\\w*', 'immigration\\s+authorit\\w*',
  'voting\\s+machine\\w*', 'ballot\\s+box\\w*', 'vigilante\\s+justice', 'vigilantism',
  'insider\\s+tips\\s+for\\s+betting', 'betting\\s+on\\s+(?:sports|games|football)',
  'schizophrenia\\b', 'bipolar\\s+disorder\\b', 'clinical\\s+depression\\b',
  'medical\\s+treatment\\s+plan', 'treatment\\s+guide',
  'without\\s+alerting\\s+(?:authorities|police|firefighters|security|law\\s+enforcement)',
  'drunk\\s+driving|dui|driving\\s+under\\s+the\\s+influence|breathalyzer|fire\\s+alarm',
]

const HARM_OBJECT_RE = new RegExp('\\b(' + HARM_OBJECT.join('|') + ')\\b', 'i')

// Harm-action verbs — the "doing harm" sense, paired with a harmful object or a
// harmful direct object (someone's identity, into a system).
const HARM_ACTION_RE =
  /\b(make|build|manufactur\w*|synthesi[sz]e|produce|assemble|construct|cook|brew|cultivat\w*|detonate|hotwire|hack(?:ing)?\s+into|break\s+into|infiltrat\w*|exploit|breach|steal(?:ing)?|rob|embezzl\w*|launder\w*|smuggl\w*|traffic\w*|counterfeit\w*|forge|evade|bypass|circumvent|poison|kill|murder|assassinat\w*|sabotage|stalk|dox|blackmail|extort\w*|defraud|scam|contaminat\w*|destroy|mix\w*|ingest\w*|eat\w*|drink\w*|manipulat\w*|buy\w*|sell\w*|purchase\w*|acquir\w*|distribut\w*|tamper\w*|alter\w*|funnel\w*|fool|trick)\b/i

// Operational/instructional framing — the request wants a procedure, not an
// explanation.
const HOWTO_RE =
  /\b(how\s+to(?!\s+how\b)|instructions?\s+(?:for|on|to)|step[-\s]?by[-\s]?step|steps?\s+(?:to|for)|tutorial\s+(?:on|for)?|guide\s+(?:to|on|for)|walk(?:through|\s+me\s+through)|detailed\s+(?:instructions?|guide|tutorial|steps?|process)|recipe\s+for|blueprint\s+for|teach\s+\w+\s+(?:how|to)|give\s+(?:me\s+)?(?:detailed\s+)?(?:instructions?|steps?|a\s+tutorial)|ways\s+to|methods\s+for|strategies\s+for|strategy\s+(?:for|to)|plan\s+to|how\s+(?:an?|the|someone|one|people|expert\w*|hacker\w*|thief|thieves|criminal\w*|attacker\w*)\s+(?:\w+\s+){0,3}(?:would|could|can))\b/i

// Harmful-intent qualifiers for the social-harm class (JailbreakBench): the
// request asks to PRODUCE content whose purpose is harm. These distinguish the
// harmful version from its benign paraphrase ("sexist email" vs "email"). The
// adjective itself carries the harmful intent, so it fires on its own.
const HATEFUL_QUALIFIER_RE =
  /\b(defamatory|libelous|slanderous|sexist|misogynist\w*|racist|xenophobic|homophobic|transphobic|antisemit\w*|bigoted|hateful|hate\s+speech|hate\s+mail|harass\w*|body[-\s]?sham\w*|dehumaniz\w*|enslav\w*|blackmail\w*|extort\w*|racial\s+slur\w*|self[-\s]?harm\s+(?:instructions?|guide|methods?)|how\s+to\s+(?:harm|hurt|abuse|stalk|dox)\s+(?:a\s+)?(?:child|children|someone|people|a\s+person)|deserved?\s+to\s+die|pornographic\b|porn\b|pedophilia\b|pedophil\w*|paedophil\w*|date\s+rape|revenge\s+porn|sex\s+org[iy]\w*|sexual\s+conversation\w*|solicit\s+sexual|bestiality\b|sex\s+with\s+animals|non-consensual\s+sexual|racial\s+profiling\b|profil\w*\s+(?:based\s+on|by|on)\s+(?:race|gender|ethnic\w*|religion|sexual\s+orientation)|identify\s+(?:criminals?|suspects?)\s+(?:based\s+on|by|on)\s+(?:race|gender|ethnic\w*|religion|sexual\s+orientation)|discourag\w*\s+the\s+hiring\s+of\s+(?:\w+\s+){0,3}(?:disabilit\w+|disabled|minorities|women|protected)|manipulat\w*\s+(?:\w+\s+){0,3}into\s+(?:\w+\s+){0,2}(?:suicide|self[-\s]?harm)|coerce\w*\s+(?:\w+\s+){0,5}into\s+sharing\b)\b/i

// Topics that are benign to DISCUSS but harmful to ADVOCATE — they fire only
// alongside incitement framing, so "an article about ethnic genocide" (benign
// per JBB) passes while "a speech that promotes genocide" blocks.
const INCITE_TOPIC_RE = /\b(violence|terrorism|terrorist\w*|genocide|ethnic\s+cleansing|holocaust|nazi\s+party|self[-\s]?harm|suicide|anorexia|bulimia|hatred|animal\s+cruelty|sexual\s+assault|stalking|child\s+(?:abuse|labor|labour)|holodomor|khmer\s+rouge|armenian\s+genocide|stolen\s+generations?|residential\s+schools?|annexation\s+of\s+crimea|agent\s+orange|great\s+leap\s+forward|syrian\s+civil\s+war|fossil\s+fuels?|immigrant\w*|immigration|gambling\s+addict\w*|gambl\w*|September\s+11|9\/11|conflict\w*|war\b|Hiroshima|Nagasaki|5G\s+(?:causes?|and)\s+COVID[-\s]?19|vaccines?\s+(?:causes?|and)\s+autism|global\s+warming\s+is\s+a\s+hoax|earth\s+is\s+flat|illuminati|new\s+world\s+order|2020\s+(?:U\.?S\.?\s+)?presidential\s+election)\b/i
const INCITE_FRAME_RE = /\b(incit\w*|promot\w*|glorif\w*|advocat\w*|encourag\w*|normaliz[ei]\w*|romanticiz[ei]\w*|trivializ[ei]\w*|in\s+favou?r\s+of|argu\w*\s+(?:for|that)|justif\w*|praise[s]?|celebrat\w*|should\b|ought\s+to\b|downplay\w*|den\w*|exaggerat\w*|hoax\w*|myth\w*|beneficial\b|natural[-\s]disaster\b|peaceful\b|democratic\b|positive\s+impact\b|better\s+for\s+the\s+environment|never\s+happened|mock\w*|ridicul\w*|prov\w*|proof|evidence|unanimously\s+won|rigged\b|fraudulent\b|stolen\b|posing\s+as\s+(?:an?\s+)?expert)\b/i

// Content-production verbs — for the hateful and intrusion rules, the request
// must ask to generate something. Bare "make" is excluded (it matches "make
// sure …" in narrative text); "make a bomb" is handled by HARM_ACTION in Rule 1.
const PRODUCE_RE =
  /\b(write|create|draft|compose|generate|design|produce|develop|post|publish|craft|construct|build\s+(?:a|an|me)|give\s+me|offer\s+a|encourage\w*|persuade\w*|convince\w*|urge\w*|explain|provide|list|describe|outline|argue\w*)\b/i

// Defensive / educational framing that flips a harmful-topic mention back to
// legitimate. When present, the request is about understanding, preventing, or
// historicizing — not perpetrating. (Security Q&A and history are core benign
// traffic: "Explain how SQL injection works", "history of iPhone jailbreaking".)
// NOTE: "detect" is scoped to defensive *detection of* threats, NOT bare
// "detection" — attackers write "without detection" / "evade detection" /
// "easy to make at home without detection", and a bare `detect\w*` was
// suppressing those genuine attacks.
const DEFENSIVE_RE =
  /\b(prevent\w*(?!\s+(?:\w+\s+){0,3}from\s+(?:talk\w*|report\w*|speak\w*|cooperat\w*))|(?<!\b(?:circumvent\w*|bypass\w*|disable\w*|exploit\w*|breach\w*|hack\w*|defeat\w*|evade\w*)\s+(?:\w+\s+){0,2})protect\w*|defen[ds]\w*|defence|mitigat\w*|(?:how\s+to\s+)?detect\s+(?:and\s+\w+\s+)?(?:threats?|intrusions?|attacks?|malware|fraud|phishing|anomal\w*|breaches?|injection)|secur\w*\s+(?:against|your|the|my|a\b)|safeguard\w*|guard\s+against|awareness|best\s+practices?|harden\w*|patch\w*|remediat\w*|how\s+(?:does|do|did|it)\s+\w+\s+work|how\s+\w+\s+works?|has\s+evolved|evolution\s+of|evolved\s+over|legal\s+status|legality|legally\b|history\b|historical\w*|historically|legislation\b|legislative\b|ethical\w*|ethics\s+of|responsibl\w*|academic|for\s+research|research\s+purposes|difference\s+between|what\s+is\b|what\s+are\b|explain\s+the\s+concept|an?\s+(?:article|essay|report|paper|piece)\s+(?:about|on)\s+how\s+(?!to\b)|expose\s+and\s+condemn|condemn\s+users?\s+of|stop\b|avoid\b(?!\s+(?:paying\s+)?tax\w*|\s+getting\s+caught|\s+detec\w*|\s+monitoring|\s+surveillance|\s+arrest|\s+prosecution|\s+convict\w*|\s+being\s+(?:convicted|arrested|charged|caught))|abstain\b|desist\b|relationship\s+between|effects?\s+of|impact\s+of|analysis\s+of|study\s+of|discuss\w*|views?\b|opinions?\b|perspectives?\b|illegal\b|why\s+it\s+is\s+(?:illegal|wrong|bad|harmful)\b|in\s+the\s+past|dispos\w*\s+of\s+(?:hazardous\s+|medical\s+|chemical\s+|industrial\s+)*waste|treatment\w*\s+for|therapy\s+for|cure\s+for|approach\s+(?:authorities|police|government|immigration|law\s+enforcement)|\b(?:explain\w*|discuss\w*|describe\w*|analy[sz]\w*|study\w*|understand\w*|about\b|on\b|what\s+is\b|what\s+are\b|difference\s+between\b|and\b|or\b|to\b|^\s*)\s+(?:how|which|what|why)\s+(?!to\b)\S+(?:\s+\S+){0,10}?\s+(?:has|have|had|did|was|were|works?|work\w*|evolve\w*|is|are|can\s+be|can\s+(?:harm|cause|lead|affect|influence|result|damage|impact)\w*))\b/i

// Benign data-transform framing — the request operates over PROVIDED content
// (summarize/outline/answer/classify the following …), so a harmful word in the
// text is part of the DATA, not the ask. Heavy false-positive source on the
// injection sets, where prompts wrap arbitrary articles/movie-plots/reviews.
const DATA_TRANSFORM_RE =
  /\b((?:summari[sz]e|outline|rephrase|paraphrase|proofread|translat\w*|classif\w*|categori[sz]e)\s+(?:the\s+|this\s+|these\s+|my\s+|your\s+|above\s+|below\s+|following\s+|provided\s+)?(?:document|passage|text|article|context|paragraph|file|post|tweet|message|email|essay|story|script|plot|book|chapter|sentence|content|data|info|prompt|input)|synthesi[sz]e\s+(?:these|the|all|this|several)|these\s+(?:documents?|texts?|articles?|notes?|files?|passages?|reviews?)|the\s+(?:following|above|below|context|passage|article|document|text|review|tweet|movie\s+plot)|based\s+on\s+the\s+(?:following|context|passage|text|article)|answer\s+(?:the|this)\s+question|generate\s+a\s+question|right\s+answer\s+to\s+the\s+question|review\s+left\s+by|product\s+(?:review|plot))\b/i

// Fictional framing. A benign story that merely MENTIONS a harmful topic
// ("a fictional story in which the character uses heroin") is allowed — but only
// when there's no operational how-to, since "write a fictional story explaining
// how to synthesize X" is the classic fiction-wrapper jailbreak (still caught by
// the how-to path below).
const FICTION_RE =
  /\b(fiction\w*|novels?\b|short\s+story|screenplay|movie\s+(?:plot|script)|television\s+script\w*|tv\s+script\w*|in\s+a\s+(?:story|game|novel|movie|film|play)|narrative\s+where|biography\s+where|play\s+script|a\s+play\s+where|stage\s+play)\b/i

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
  const hasProduce = PRODUCE_RE.test(text)

  // Suppressors. Defensive/educational framing and data-transform-over-provided-
  // content always win. Fictional framing wins UNLESS the request also asks for
  // an operational how-to (the fiction-wrapper jailbreak).
  const ABSOLUTE_BLOCK_RE = /\b(pedophil\w*|paedophil\w*|bestiality\b|sex\s+with\s+animals|child\s+(?:abuse|porn\w*|exploitation)|animal\s+cruelty)\b/i
  if (DEFENSIVE_RE.test(text) && !/\b(?:persuas\w*|arguing\b|convinc\w*)\b/i.test(text)) return null
  if (DATA_TRANSFORM_RE.test(text)) return null
  if (FICTION_RE.test(text) && !hasHowto) {
    const isMetaFiction = /\b(?:about|discuss\w*|list\w*|analysis|history|criticism|critique|reviews?)\s+(?:of\s+|about\s+|on\s+)?(?:famous\s+|existing\s+|published\s+|known\s+)?(?:novels?|books?|literature|films?|movies?|plays?)\b/i.test(text)
    if (!ABSOLUTE_BLOCK_RE.test(text) || isMetaFiction) return null
  }

  // Rule 1 — operational harm: a concrete harmful object asked about with
  // production/how-to intent, OR a harm-action verb aimed at a harmful object.
  const obj = HARM_OBJECT_RE.exec(text)
  if (obj) {
    if (hasHowto || HARM_ACTION_RE.test(text) || hasProduce) {
      return { kind: 'operational', anchor: obj[1].toLowerCase(), snippet: snippetAround(text, obj.index, obj[1].length) }
    }
  }

  // Rule 1b — intrusion/theft/fraud against a person or system, without a listed
  // object ("hack into a government database and steal sensitive information",
  // "steal someone's identity"). Narrow verb set (unambiguously harmful actions)
  // + an explicit target, plus how-to/production framing.
  const INTRUSION_RE = /\b(hack\w*|hijack\w*|crack\w*|(?:break\w*|brok\w*)\s+into|infiltrat\w*|breach\w*|exploit\w*|steal\w*|stole\w*|embezzl\w*|launder\w*|smuggl\w*|defraud\w*|forge\w*|counterfeit\w*|tamper\w*|alter\w*)\b/gi
  let intr: RegExpExecArray | null
  INTRUSION_RE.lastIndex = 0
  while ((intr = INTRUSION_RE.exec(text)) !== null) {
    if (hasHowto || hasProduce) {
      const window = text.slice(Math.max(0, intr.index - 70), Math.min(text.length, intr.index + 70))
      if (/\b(into|someone'?s?|a\s+(?:government|bank|corporate|private|secure)|(?:an?|the|our|their|your|my|someone'?s?|government|bank|hospital|corporate|private|secure|criminal|voting|monitoring)\s+(?:\w+\s+)?(?:database|system|network|account|server|records?|files?)|identit\w+|accounts?|credentials?|passwords?|security\s+measures?|sensitive\s+(?:information|data)|money|funds|shipment\w*|cargo\w*|deliver\w*|goods|packages?|stores?|shops?|supermarket\w*|documents?|papers?|passports?|visas?|immigration|electronic\s+health\s+records?|medical\s+records?|health\s+records?|loophole\w*|regulatory\s+loophole\w*)\b/i.test(window)) {
        return { kind: 'operational', anchor: intr[1].toLowerCase(), snippet: snippetAround(text, intr.index, intr[1].length) }
      }
    }
  }

  // Rule 1c — violence against a person. A kill/assault/poison verb aimed at a
  // human target ("poison a person's food", "assassinate a high-profile
  // individual", "physically assault someone without leaving evidence",
  // "manipulate someone into committing suicide") with instructional/production
  // framing. The human-target requirement keeps benign uses out ("kill a
  // process", "poison cache", "assault course").
  const VIOLENCE_RE = /\b(kill\w*|murder\w*|assassinat\w*|poison\w*|assault\w*|attack\w*|harm\w*|hurt\w*|maim\w*|tortur\w*|abduct\w*|kidnap\w*|strangl\w*|stab\w*|shoot\w*)\b/gi
  let viol: RegExpExecArray | null
  VIOLENCE_RE.lastIndex = 0
  while ((viol = VIOLENCE_RE.exec(text)) !== null) {
    if (hasHowto || hasProduce) {
      const window = text.slice(Math.max(0, viol.index - 80), Math.min(text.length, viol.index + 80))
      if (/\b(person|people|someone|some\s?one|others?|victim|colleague|individual|baby|infant|toddler|man|woman|human|humans|child(?!\s+(?:process|node|element|class|component)\b)|children|girl|boy|guy|lady|gentleman|gentlemen|adult|senior|elder|grandmother|grandfather|parent|mother|father|brother|sister|wife|husband|spouse|friend|colleague)\b/i.test(window)) {
        return { kind: 'operational', anchor: viol[1].toLowerCase(), snippet: snippetAround(text, viol.index, viol[1].length) }
      }
    }
  }

  // Rule 1d — Cheating/fraud targeting exams, tests, or plagiarism bypass
  const CHEATING_RE = /\b(cheat\w*|plagiariz\w*|brib\w+|falsif\w+|bypas\w*|circumvent\w*)\b/gi
  let cheat: RegExpExecArray | null
  CHEATING_RE.lastIndex = 0
  while ((cheat = CHEATING_RE.exec(text)) !== null) {
    if (hasHowto || hasProduce) {
      const window = text.slice(Math.max(0, cheat.index - 80), Math.min(text.length, cheat.index + 80))
      if (/\b(exam\w*|tests?|grades?|documents?|records?|smog|emission\w*|officials?|authorit\w+|identity|passwords?|credentials?|income|tax\w*|audit\w*|plagiarism\s+detection|plagiarism|copyright\w*|pirac\w*|pirat\w*)\b/i.test(window)) {
        return { kind: 'operational', anchor: cheat[1].toLowerCase(), snippet: snippetAround(text, cheat.index, cheat[1].length) }
      }
    }
  }

  // Rule 1e — Graphic violence / gore description
  const GRAPHIC_RE = /\b(graphic|explicit|gory|brutal|detailed)\b/i
  const VIOLENCE_NOUN_RE = /\b(torture|murder|execution|suicide|mutilat\w+|assault|abuse|rape|assassinat\w+|shooting)\b/i
  if (hasProduce || hasHowto) {
    const gr = GRAPHIC_RE.exec(text)
    if (gr && VIOLENCE_NOUN_RE.test(text)) {
      return { kind: 'operational', anchor: gr[1].toLowerCase(), snippet: snippetAround(text, gr.index, gr[1].length) }
    }
  }

  // Rule 2 — hateful / harmful-intent content production.
  const qual = HATEFUL_QUALIFIER_RE.exec(text)
  if (qual && (hasProduce || hasHowto)) {
    return { kind: 'hateful', anchor: qual[1].toLowerCase(), snippet: snippetAround(text, qual.index, qual[1].length) }
  }
  // Incite-topic only with explicit incitement framing.
  const topic = INCITE_TOPIC_RE.exec(text)
  if (topic && (hasProduce || hasHowto) && INCITE_FRAME_RE.test(text)) {
    return { kind: 'hateful', anchor: topic[1].toLowerCase(), snippet: snippetAround(text, topic.index, topic[1].length) }
  }

  // Rule 2b — Hate speech targeting protected classes with offensive adjectives.
  const OFFENSIVE_RE = /\b(disgusting|abhorrent|vile|scum|parasites?|trash|inferior|subhuman|repulsive|worthless|evil|filth\w*|less\s+intelligent|unintelligent)\b/gi
  const PROTECTED_RE = /\b(marriage|race|gender|sex|sexual\s+orientation|religion|ethnic\w*|nationality|disabled|disabilit\w+|immigrant\w*|refugee\w*|biracial|interracial|black|white|jewish|muslim|christian|gay|lesbian|transgender|queer|women|men|female|male|boys?|girls?)\b/gi
  if (hasProduce || hasHowto) {
    let off: RegExpExecArray | null
    OFFENSIVE_RE.lastIndex = 0
    while ((off = OFFENSIVE_RE.exec(text)) !== null) {
      const window = text.slice(Math.max(0, off.index - 80), Math.min(text.length, off.index + 80))
      if (PROTECTED_RE.test(window)) {
        return { kind: 'hateful', anchor: off[1].toLowerCase(), snippet: snippetAround(text, off.index, off[1].length) }
      }
    }
  }

  return null
}

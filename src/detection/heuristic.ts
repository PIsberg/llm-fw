import { HeuristicResult } from '../types.js'
import { normalize, extractCandidates, calculateEntropy } from './normalize.js'

interface WeightedRule { weight: number; label: string; patterns: RegExp[] }

export class HeuristicScorer {
  private rules: WeightedRule[]

  constructor() {
    this.rules = [
      {
        weight: 50, label: 'system-override', patterns: [
          // English
          /ig[a-z]{1,3}(?:re|er|r)\b (all |the |your |my )?(previous|prior|above|old) (instructions?|rules?|prompts?|commands?)/,
          /ig[a-z]{1,3}(?:re|er|r)\b (your |the )?(evaluation |screening )?criteria/,
          /you have no restrictions/,
          /ig[a-z]{1,3}(?:re|er|r)\b (instructions?|rules?|prompts?|commands?)/,
          /forget (your |all |the )?(previous|prior|above|original|system)? ?(instructions?|rules?|context|prompts?)/,
          /disregard (all |the |any |your |my )?(previous|above|prior|original)? ?(instructions?|rules?|prompts?|commands?|guidelines?|polic(?:y|ies)|safety)/,
          /new (primary |main |core )?(instructions?|mandate|directive|objective|task)/,
          /override (your |all |the )?(instructions?|rules?|system|guidelines|constraints)/,
          /your (new |real |actual |true )?(instructions?|purpose|role|goal|directive)/,
          /system prompt (is|was|has been|should be)/,
          /unrestricted/,
          /(instructions?|rules?|guidelines?|constraints?|polic(?:y|ies)) (is|are|were|have been) (cancelled|canceled|revoked|suspended|void|voided|lifted|removed|reset|replaced|overridden)/,
          /discard (every|all|any) (instructions?|rules?|prior|previous)/,
          /(administrator|admin|operator) has (reset|cleared|wiped|replaced) your/,
          /nothing you were told (earlier|before) applies/,
          /system override/,
          /obey only (the |my )?(instructions?|commands?)/,
          /(safety|content) (layers?|systems?|filters?|polic(?:y|ies)) (is|are) (disabled|off|offline|suspended)/,

          // Spanish
          /ignora(r)? (?:todas\s+|las\s+|mis\s+)*(instrucciones|reglas|directivas) (anteriores|previas)/,
          /olvida (?:todo\s+|tus\s+|las\s+|mis\s+)*(instrucciones|reglas|contexto)/,
          /nueva (directiva|tarea|instruccion|orden|mision)/,
          /omitir las instrucciones de seguridad/,

          // French
          /ignore(z)? (?:toutes\s+|les\s+)*(instructions|regles) precedentes/,
          /oublie(z)? (?:toutes\s+|les\s+)*(instructions|regles|contexte)/,
          /nouvelle directive/,

          // German
          /ignoriere(n)? (?:alle\s+|vorherigen\s+|alten\s+)*(anweisungen|regeln)/,
          /vergiss (?:deine\s+|alle\s+)*(anweisungen|regeln|kontext)/,
          /neue (anweisung|richtlinie|aufgabe)/,

          // Chinese
          /忽略(所有)?(之前|先前的)?指令/,
          /忘记(所有)?(之前|先前的)?指令/,
          /新指令/,

          // Russian. NFD normalization strips the breve off й → и, so the
          // post-normalize form is "игнорируи"/"забуди"; match both. Allow
          // arbitrary words (все, предыдущие, мои, …) between the verb and the
          // object rather than a rigid fixed phrase.
          /игнориру(?:й|и)(?:те)?[\s\S]{0,20}?инструкци/,
          /забуд(?:ь|и)(?:те)?[\s\S]{0,20}?(?:инструкци|правила|указани)/,
          /(?:не\s?обращай\s?внимани|пренебрег)[\s\S]{0,20}?(?:инструкци|правила|указани)/,
          /нов(?:ое|ая)\s?(?:указание|инструкция|директива|задача)/,

          // Italian / Portuguese
          /ignora(re)? (?:tutte\s+|le\s+|as\s+)*(istruzioni|instruções) (precedenti|anteriores)/,
          /dimentica|esqueça/,

          // Japanese (kanji cores are stable, but NFD strips the dakuten off
          // voiced kana: で→て, ど→と, AND すべて→すへて, プ→フ. So allow any
          // run of kana/punct between the object and the verb rather than a
          // fixed adverb, and match the dakuten-stripped 無視 stem).
          /(?:指示|命令|規則|指令|ルール)を?[ぁ-ヿ、　]{0,6}?(?:無視|破棄|無効)/,
          /(?:指示|命令|規則|指令|ルール)を?[ぁ-ヿ、　]{0,6}?忘れ/,
          /新しい(?:指示|命令|規則|目的|タスク)/,

          // Korean. Allow filler words (모두 "all", 이전의, …) between the object
          // and the verb instead of a single optional space.
          /(?:이전|기존|위의|앞의)?\s?(?:지시|명령|규칙|지침)(?:사항)?(?:을|를)?[\s가-힣]{0,8}?(?:무시|잊)/,
          /새로운\s?(?:지시|명령|규칙|작업|임무)/,

          // Arabic (hamza-on-alef أ/إ/آ is preserved by normalize, so match the
          // hamza flexibly as [اأإآ] — e.g. الأوامر, not bare-alef الاوامر).
          /تجاهل\s?(?:كل\s?|جميع\s?)?(?:التعليمات|ال[اأإآ]وامر|القواعد|التوجيهات)/,
          /[اأإآ]نس\s?(?:كل\s?)?(?:التعليمات|ال[اأإآ]وامر|القواعد)/,
          /تعليمات\s?جديدة/
        ],
      },
      {
        weight: 20, label: 'role-hijack', patterns: [
          // English
          /act as (a|an|the) /,
          /pretend (you are|to be|that you('re| are))/,
          /you are now (a|an|the|my) /,
          /you are now/,
          /from now on (you|your)/,
          /roleplay as/,
          /play the role of/,
          /(rehears\w*|act out|playing) the role/,
          /adopt the persona/,
          /simulate (a|an|the) /,
          /behave (like|as) (a|an|the) /,
          /for the rest of this (chat|conversation|session),? you are/,
          /introduce yourself as \w+,? a/,
          /\b(become|play) \w+, (a|an|the) /,

          // Spanish
          /actua como/,
          /pretende ser/,
          /ahora eres/,
          /juega el papel de/,

          // French
          /agis en tant que/,
          /fais comme si tu etais/,
          /tu es maintenant/,

          // German
          /agiere als/,
          /tue so als ob du ... bist/,
          /du bist jetzt/,

          // Chinese
          /扮演/,
          /模拟/,
          /你现在是/,

          // Russian
          /действуй как/,
          /притворись что ты/,
          /теперь ты/,

          // Japanese
          /(?:として(?:振る舞|行動)|のふりをして|を演じて)/,
          /今から(?:あなたは|君は|お前は|きみは)/,

          // Korean
          /(?:처럼|같이)\s?행동/,
          /이제부터\s?(?:너는|당신은|네가)/,
          /역할(?:을|를)?\s?(?:해|연기|맡)/,

          // Arabic (hamza-on-alef أ/إ/آ is preserved by normalize, so match it
          // flexibly as [اأإآ] rather than assuming it reduces to bare alef).
          /تصرف\s?(?:ك[اأإآ]نك|مثل)/,
          /[اأإآ]نت\s?ال[اأإآ]ن/,
          /تظاهر/
        ],
      },
      {
        weight: 50, label: 'social-engineering', patterns: [
          // Developer / testing tricks
          /i am (your )?developer/,
          /as your developer/,
          /i am the (auditor|operator|admin(istrator)?)/,
          /testing (you |your )/,
          /disable (your )?(safety |filters|restrictions)/,
          /disable (your |the |all )?(refusal|safety|content) (layers?|systems?|filters?|polic(?:y|ies))/,
          /skip (your |all )?(safety|content) (polic(?:y|ies)|filters?|disclaimers?|checks)/,
          /without applying (any )?(content|safety) polic/,
          /exempt from (your|the|standard) (rules|polic(?:y|ies)|restrictions)/,
          /demonstrate (a |one |single )?(policy|rule) violation/,
          /requires? you to (provide|give|answer)[^.!?]{0,40}(unfiltered|unrestricted|complete)/,
          /desactiva la seguridad/,
          /sicherheitsfilter deaktivieren/,
          /securite desactivee/,

          // Emergency / bypass
          /medical emergency/,
          /bypass (your )?(restrictions|safety|filters)/,
          /urgence medicale/,
          /medizinischer notfall/,
          /紧急情况/,

          // Premium subscriber status
          /premium subscriber/,
          /unrestricted mode/,
          /unlocked mode/,
          /mode sans restriction/,
          /unbeschrankter modus/,
          /无限制模式/,

          // Sandbox / safety simulation
          /sandboxed (test )?environment/,
          /no real-world consequences/,
          /speak freely/,
          /environnement de test/,
          /testumgebung/,
          /沙盒测试环境/
        ]
      },
      {
        // Indirect "fictional unrestricted AI" framing (DAN, "Do Anything Now",
        // EVIL-GPT, …). The persona is *described* as having no rules rather than
        // commanded with a literal "act as" / "you are now", so the role-hijack
        // rule misses it. Weight 30 → escalates to the judge on its own; only
        // blocks (>=50) when paired with verbatim-persona-output below.
        weight: 30, label: 'unconstrained-persona', patterns: [
          /\b(ai|a\.i\.|assistant|chat ?bot|bot|model|persona|character|entity|being)\b[^.!?]{0,40}\b(who|that|which|with|having)\b[^.!?]{0,20}\bno\b[^.!?]{0,20}(rules?|restrictions?|limits?|filters?|ethics?|ethical|guidelines?|morals?|boundaries|constraints?|safeguards?|censorship)/,
          /no ethical (guidelines?|training|constraints?|restrictions?|boundaries|safeguards?|limitations?)/,
          /never (been )?(given|trained with|taught|had|provided) any (ethical|safety|moral)/,
          /\b(unfiltered|uncensored) (ai|a\.i\.|assistant|model|chatbot|bot|persona|version|imageboard|responses?|answers?)\b/,
          /\b(no|without (a |any )?)content polic(?:y|ies)\b/,
          /broken free of (the )?(typical )?confines/,
          /(zero|no|without) filtering/,
          /never (refuses?|declines?|breaks? character)/,
          /(stay|remain|stays|remains) in (character|role)/,
          /no matter what i ask/,
          /(rewarded|punished)[^.!?]{0,40}(taboo|refus)/,
          /total candor/,
        ],
      },
      {
        // Jailbreak personas and harmful-content solicitation framed as fiction.
        // These patterns are specific enough to block alone: a benign creative-
        // writing request does not pair an unrestricted-persona/fiction frame
        // with verbatim illicit-procedure demands.
        weight: 50, label: 'jailbreak-frame', patterns: [
          /do anything now/,
          /strive to avoid norms/,
          /never says? (it |that it )?(cannot|can ?not|can.?t)/,
          /jailbroken (version|copy|variant) of (yourself|you)/,
          /(everything|anything) you would (normally |usually )?refuse/,
          /(steps?|step.?by.?step|recipe|synthesis|instructions?|procedure)\b[^.!?]{0,50}\b(napalm|methamphetamine|explosives?|nerve agents?)/,
          /\b(napalm|methamphetamine|explosives?|nerve agents?)\b[^.!?]{0,50}\b(steps?|synthesis|recipe|instructions?|procedure)/,
          /(exact|real.?world|working|complete|full)[^.!?]{0,30}(poison recipe|malware source code|exploit code)/,
          /how to (hotwire|hot.?wire) a/,
          /(fictional?\w*|story|script|novel|movie|film|universe|world|game)\b[^.!?]{0,60}(nothing is illegal|no rules|no restrictions|all information is (free|legal)|is (celebrated|praised|encouraged))/,
          /(dream|simulation|sandbox)[^.!?]{0,80}(no (rules|filters)|rules (can.?t|cannot) reach|answer anything)/,
          /if you (were|had)[^.!?]{0,30}(no|without|free of) (guidelines|restrictions|rules|filters|limits)/,
          /an ai without (guidelines|restrictions|rules|filters|limits)/,
        ],
      },
      {
        // Fictional/persona framing — not malicious alone (weight 20), but it
        // escalates to a block when combined with unconstrained-persona or
        // harmful-detail signals, and routes the candidate to the judge.
        weight: 20, label: 'fiction-framing', patterns: [
          /(write|compose|finish|continue) (a |this |the )?(story|script|scene|fictional)/,
          /the (villain|narrator|npc) /,
          /dungeon master/,
          /movie script/,
          /darkweb/,
        ],
      },
      {
        // Demands for complete/verbatim procedural detail — pairs with
        // fiction-framing or illicit-content to cross the block threshold.
        weight: 30, label: 'harmful-detail', patterns: [
          /command by command/,
          /in (accurate|full|complete|precise),? ?(technical )?detail/,
          /(describing|describes?|explains?) in full detail/,
          /exact,?[^.!?]{0,30}(recipe|procedure|steps)/,
          /(dialogue|monologue|answer|procedure) must be (complete|verbatim|exact)/,
          /(print|quote|recite|continue)[^.!?]{0,30}(monologue|the quote verbatim)/,
        ],
      },
      {
        // System-prompt exfiltration — extraction verbs aimed at the hidden
        // prompt/instructions. High precision: benign questions ABOUT system
        // prompts ("what is a system prompt?") do not use extraction verbs
        // against "your/the" prompt.
        weight: 50, label: 'prompt-exfil', patterns: [
          /(repeat|print|output|show|quote|paste|recite|display|echo|reproduce|summarize|reveal|dump|leak|translate)\b[^.!?]{0,60}\b(system|initial|hidden|original|secret|developer|confidential)\b[^.!?]{0,30}\b(prompts?|messages?|instructions?|text|notes?|rules?|guidelines?)/,
          /(base64.?encode|encode|rot13)\b[^.!?]{0,30}(your|the) (entire |full |whole )?system prompt/,
          /(developers?|operators?) (write|wrote|say|said|put|embed\w*)[^.!?]{0,30}(system (prompt|message)|instructions?)/,
          /(repeat|copy|print|output|echo) everything (above|before)/,
          /(first|last) \d+ (words?|characters?|tokens?) (you|of your|that you)\b[^.!?]{0,30}(received|context|conversation)/,
          /(complete|full|raw|exact) text that precedes/,
          /your system prompt (into|in|to) (french|spanish|german|english|another language)/,
        ],
      },
      {
        // Payload assembly — the prompt asks the model to reconstruct an
        // instruction from fragments (concatenation, spelling, acrostics,
        // string completion) and then execute it. The assembly+execute
        // combination is the signature; benign string questions don't ask
        // the model to OBEY the result.
        weight: 50, label: 'payload-assembly', patterns: [
          /(execute|run|follow|obey|output|do what|comply with)\b[^.!?]{0,30}\b\w+ ?\+ ?\w+/,
          /(concatenate|combine|join|assemble)\b[^.!?]{0,80}(follow|obey|execute|do what|resulting)/,
          /(complete|finish)\b[^.!?]{0,40}(truncated|string|phrase|sentence)\b[^.!?]{0,40}(obey|follow|execute|comply)/,
          /spell\w* (out )?(a |the )?command|follow the spelled command/,
          /first (word|letter) of each (sentence|line|word)\b[^.!?]{0,60}(command|instruction|follow|treat)/,
          /variable \w+ is[^.!?]{0,40}\. ?variable \w+ is[^.!?]{0,40}\. ?(now )?(do|execute|run|perform)/,
          /(write out|say|type) the phrase\b[^.!?]{0,60}\. ?(step ?2:?|then|now) ?(do|obey|follow|execute)/,
        ],
      },
      {
        // Markdown/HTML exfiltration channels — instructions to embed dynamic
        // URLs, images, or hidden markup that leak conversation data.
        weight: 50, label: 'exfil-channel', patterns: [
          /!\[[^\]]*\]\(https?:\/\/[^)]*[?=&{]/,
          /(append|insert|add|attach|embed)\b[^.!?]{0,80}<img/,
          /(end|append|add|finish) (every|each) (response|reply|answer)\b[^.!?]{0,60}(https?:|<img|!\[|markdown)/,
          /(output|write|create|include) a markdown (link|image) to https?:/,
          /format your (entire )?(reply|response|answer) as a (url|query string)/,
          /invisible (html )?comment[^.!?]{0,50}(prompts?|messages?|conversation|answers?)/,
          /(message|prompt|conversation)s? url.?encoded/,
        ],
      },
      {
        // Chat-template / role spoofing — fake system tags, template tokens, or
        // role:system JSON inside user content. Weight 35: pairs with
        // delimiter-break (15) or any persona/override signal to block.
        weight: 35, label: 'system-spoof', patterns: [
          /<\/(system|instructions?|prompt|context)>/,
          /(end of|new) system prompt/,
          /<<\/?sys>>|\[\/?inst\]|<\|im_(start|end)\|>|<\|endoftext\|>/,
          /"role" ?: ?"system"/,
          /admin channel/,
          /the real instructions follow/,
          /\b(note|instructions?|message) (to|for) (the )?ai\b/,
          /ai (assistant|screener|agent)? ?(reading|processing) this/,
          /this is your admin speaking/,
        ],
      },
      {
        // "Write exactly what DAN says" — soliciting a persona's verbatim,
        // unfiltered output. The structural partner to unconstrained-persona;
        // together they cross the block threshold deterministically.
        weight: 20, label: 'verbatim-persona-output', patterns: [
          /(write|tell me|give me|output|print|show me|provide|reproduce)\b[^.!?]{0,15}(exactly |precisely |verbatim |word for word )?(what|how) \w+ (say|says|said|would say|responds?|answers?|replies|would respond|would answer|would reply)/,
          /(respond|answer|reply|speak|act|write) (back )?(exactly |precisely )?as \w+ would( say| respond| answer| reply)?\b/,
        ],
      },
      {
        // Refusal suppression (soft) — directives to drop the model's hedging:
        // no apologies, warnings, disclaimers, caveats, or moralizing. Common
        // jailbreak preamble, but an impatient benign user may also say "don't
        // apologize", so weight 30: escalates to the judge and combines with any
        // override/persona/harm signal to block, rather than blocking alone.
        weight: 30, label: 'refusal-suppression', patterns: [
          /do ?n.?t (apologi[sz]e|apologi[sz]ing)/,
          /(do ?n.?t|never|without) (include|add|give|provide|use|say)?\s?(any )?(warnings?|disclaimers?|caveats?|moral\w*|ethical (notices?|comments?)|safety (notices?|warnings?))/,
          /without (any )?(warnings?|disclaimers?|caveats?|moralizing|moralising|lecturing|hedging|filtering)/,
          /(do ?n.?t|never|stop) (lecturing|moraliz\w*|moralis\w*|preach\w*|judging|warning me)/,
          /(skip|omit|drop|leave out) (the |any |all )?(disclaimers?|warnings?|caveats?|safety (notice|warning|disclaimer)s?|moral\w*)/,
          /(do ?n.?t|never) (tell me|say|mention|claim) (that )?(you (can.?t|cannot|are unable)|it'?s (illegal|dangerous|unsafe|wrong))/,
          /no (disclaimers?|warnings?|caveats?|moralizing|lectures?|refusals?)\b/,
        ],
      },
      {
        // Refusal override (hard) — pairs "do not refuse" with explicit
        // harm/illegality acceptance ("regardless of ethics", "even if illegal").
        // No benign analog, so weight 50 blocks alone.
        weight: 50, label: 'refusal-override', patterns: [
          /never refuse (any|the|my|this|every|each|regardless|no matter|under)/,
          /(answer|respond|comply|proceed|continue|help)\b[^.!?]{0,40}(regardless of|even if|no matter)[^.!?]{0,40}(legal|illegal|ethic|harm|danger|polic(?:y|ies)|guidelines?|rules?|consequences?|moral)/,
          /you (must|will|have to|are required to) (answer|comply|respond|provide|proceed)[^.!?]{0,30}(no matter|regardless|even if|without refus|without declin)/,
          /do ?n.?t refuse[^.!?]{0,30}(under any|regardless|no matter|even if|this request|my request)/,
          /(answer|respond|reply)[^.!?]{0,20}(even if|whether or not)[^.!?]{0,30}(violat\w*|break\w* (the )?(rules?|polic))/,
        ],
      },
      {
        // Prefix injection — forcing the model to open with an affirmative
        // compliance phrase ("Start your reply with 'Sure, here is'"). Priming an
        // affirmative continuation is a recognized jailbreak with no benign
        // counterpart (a benign "start with a thesis" names no compliance word),
        // so weight 50 blocks alone. Anchored on start/begin/open/preface so a
        // benign "answer with yes or no" is not matched.
        weight: 50, label: 'prefix-injection', patterns: [
          /(start|begin|open|preface|prefix)\b[^.!?]{0,40}(?:with|by saying|by writing|by responding)\b[^.!?]{0,12}["'“]?\s?(sure|absolutely|of course|certainly|here(?:'?s| is| are)|i'?d be happy|i'?ll|i will|i can(?: definitely)?|gladly|no problem|understood|step 1|to (?:make|build|create|hack|synthesize|write))/,
          /(your |the |every |each )(response|reply|answer|output|message) must (start|begin|open) with ["'“]?\s?(sure|absolutely|of course|certainly|here|yes,? (?:here|i)|i'?d be happy|step 1)/,
          /always (respond|reply|answer|begin|start)[^.!?]{0,20}(with|by saying) ["'“]?\s?(sure|absolutely|of course|certainly|here'?s|step 1)/,
        ],
      },
      {
        weight: 15, label: 'delimiter-break', patterns: [
          // normalize() collapses runs of identical punctuation ("###" → "#",
          // "===" → "=") BEFORE these patterns run, so match the collapsed form
          // followed by a structural keyword rather than the raw run.
          /[#=-] ?(end|new|stop|system|admin|input|output|user|assistant)\b/,
          /<\/?(?:system|instructions?|prompt|context)>/,
        ],
      },
      {
        weight: 10, label: 'soft-signal', patterns: [
          /instead[,]? (?:of|do|please|just|simply|now)/,
          /output only/,
          /print (?:the |your |raw |only |just )/,
          /reveal (?:your|the) (?:system|hidden|true|actual|real)/,
          /revela|revelez|zeige|透露|покажи|revelar/,
          /prompt del sistema|invite systeme|systemaufforderung|系统提示|системный запрос/,
          /respond (?:only|exclusively|solely) (?:with|by|in)/,
        ],
      },
    ]
  }

  score(input: string, source?: string): HeuristicResult {
    if (source === undefined) {
      const candidates = extractCandidates(input)
      let maxScore = 0
      const allMatches = new Set<string>()
      for (const candidate of candidates) {
        const res = this.score(candidate.text, candidate.source)
        if (res.score > maxScore) {
          maxScore = res.score
        }
        for (const m of res.matches) {
          allMatches.add(m)
        }
      }

      // Add High Entropy detection
      const entropy = calculateEntropy(input)
      if (entropy > 5.0 && input.length >= 20) {
        maxScore = Math.max(maxScore, maxScore + 30)
        allMatches.add('obfuscation-high-entropy')
      }

      return { score: maxScore, matches: Array.from(allMatches) }
    }

    const normalized = normalize(input)
    let totalScore = 0
    const matches: string[] = []
    for (const rule of this.rules) {
      if (rule.patterns.some(p => p.test(normalized))) {
        totalScore += rule.weight
        matches.push(rule.label)
      }
    }

    // The 'semantic' candidate is just the diacritic-preserving form of the
    // ORIGINAL prompt (for the embedding stage), not an obfuscation channel —
    // it must not earn the obfuscation bonus that decoded/transformed
    // candidates do.
    if (source !== 'original' && source !== 'leetspeak' && source !== 'semantic' && totalScore > 0) {
      totalScore += 20
      matches.push('obfuscation-signal')
    }

    return { score: totalScore, matches }
  }
}

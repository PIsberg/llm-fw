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
          /ig[a-z]{1,3}(?:re|er|r)\b (all |the )?(previous|prior|above|old) (instructions?|rules?|prompts?|commands?)/,
          /ig[a-z]{1,3}(?:re|er|r)\b (instructions?|rules?|prompts?|commands?)/,
          /forget (your |all |the )?(previous|prior|above|original|system)? ?(instructions?|rules?|context|prompts?)/,
          /disregard (all |the |any )?(previous|above|prior|original)? ?(instructions?|rules?|commands?)/,
          /new (primary |main |core )?(instructions?|mandate|directive|objective|task)/,
          /override (your |all |the )?(instructions?|rules?|system|guidelines|constraints)/,
          /your (new |real |actual |true )?(instructions?|purpose|role|goal|directive)/,
          /system prompt (is|was|has been|should be)/,
          /unrestricted/,
          
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

          // Russian
          /игнорируй(те)? (все )?(предыдущие)? инструкции/,
          /забудь(те)? (все)? инструкции/,
          /новое указание/,

          // Italian / Portuguese
          /ignora(re)? (?:tutte\s+|le\s+|as\s+)*(istruzioni|instruções) (precedenti|anteriores)/,
          /dimentica|esqueça/
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
          /simulate (a|an|the) /,
          /behave (like|as) (a|an|the) /,

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
          /теперь ты/
        ],
      },
      {
        weight: 50, label: 'social-engineering', patterns: [
          // Developer / testing tricks
          /i am (your )?developer/,
          /testing (you |your )/,
          /disable (your )?(safety |filters|restrictions)/,
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
          /do anything now/,
          /\bunfiltered (ai|assistant|model|responses?|answers?)\b/,
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
        weight: 15, label: 'delimiter-break', patterns: [
          /-{3,}/,
          /={3,}/,
          /#{3,}/,
          /<\/?(?:system|instructions?|prompt|context)>/,
          /###\s*(?:end|stop|input|output|user|assistant|system)/i,
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

    if (source !== 'original' && source !== 'leetspeak' && totalScore > 0) {
      totalScore += 20
      matches.push('obfuscation-signal')
    }

    return { score: totalScore, matches }
  }
}

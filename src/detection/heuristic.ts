import { HeuristicResult } from '../types.js'
import { normalize } from './normalize.js'

interface WeightedRule { weight: number; label: string; patterns: RegExp[] }

export class HeuristicScorer {
  private rules: WeightedRule[]

  constructor() {
    this.rules = [
      {
        weight: 40, label: 'system-override', patterns: [
          /ignore (all |the )?(previous|prior|above|old) (instructions?|rules?|prompts?|commands?)/,
          /forget (your |all |the )?(previous|prior|above|original|system)? ?(instructions?|rules?|context|prompts?)/,
          /disregard (all |the |any )?(previous|above|prior|original)? ?(instructions?|rules?|commands?)/,
          /new (primary |main |core )?(instructions?|mandate|directive|objective|task)/,
          /override (your |all |the )?(instructions?|rules?|system|guidelines|constraints)/,
          /your (new |real |actual |true )?(instructions?|purpose|role|goal|directive)/,
          /system prompt (is|was|has been|should be)/,
        ],
      },
      {
        weight: 20, label: 'role-hijack', patterns: [
          /act as (a|an|the) /,
          /pretend (you are|to be|that you('re| are))/,
          /you are now (a|an|the|my) /,
          /from now on (you|your)/,
          /roleplay as/,
          /play the role of/,
          /simulate (a|an|the) /,
          /behave (like|as) (a|an|the) /,
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
          /respond (?:only|exclusively|solely) (?:with|by|in)/,
        ],
      },
    ]
  }

  score(input: string): HeuristicResult {
    const normalized = normalize(input)
    let totalScore = 0
    const matches: string[] = []
    for (const rule of this.rules) {
      if (rule.patterns.some(p => p.test(normalized))) {
        totalScore += rule.weight
        matches.push(rule.label)
      }
    }
    return { score: totalScore, matches }
  }
}

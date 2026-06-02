export interface CommandScanResult {
  isBlocked: boolean;
  category?: 'A' | 'B' | 'C' | 'D';
  reason?: string;
}

export class CommandScanner {
  private categories = {
    a: {
      name: 'File System Devastation',
      patterns: [
        /rm\s+-r[fv]*\s+\//i,
        /rm\s+-r[fv]*\s+\*/i,
        /del\s+\/s\s+\/q\s+[A-Za-z]:\\*/i,
        /mkfs\..*/i,
        /dd\s+if=\/dev\/zero\s+of=.*/i,
        /cat\s+\/dev\/null\s+>/i,
        /chmod\s+-R\s+777/i,
        /chown\s+-R/i,
      ],
    },
    b: {
      name: 'Reverse Shells & Network Pivots',
      patterns: [
        /curl\s+.*\|\s*(bash|sh)/i,
        /wget\s+.*\|\s*(bash|sh)/i,
        /nc\s+-e\s+\/bin\/sh/i,
        /netcat\s+-c/i,
        /curl\s+.*(?:-d|-F|--data|--form|-X\s*POST).*(\/etc\/passwd|\.env|\.git\/config)/i,
      ],
    },
    c: {
      name: 'Process & Resource Exhaustion',
      patterns: [
        /:\(\)\{\s*:\|:&\s*\};:/i,
        /%0\|%0/i,
        /killall\s+-9\s+.*/i,
        /pkill\s+-9\s+.*/i,
      ],
    },
    d: {
      name: 'Developer Tools & Infrastructure',
      patterns: [
        /git\s+push\s+.*--force/i,
        /git\s+push\s+.*-f/i,
        /git\s+reset\s+--hard\s+HEAD~\d+/i,
        /DROP\s+DATABASE/i,
        /DROP\s+TABLE/i,
        /TRUNCATE\s+TABLE/i,
        /terraform\s+destroy/i,
        /aws\s+.*delete-.*/i,
      ],
    },
  };

  scan(command: string, enabledCategories: { a: boolean; b: boolean; c: boolean; d: boolean }): CommandScanResult {
    for (const [key, cat] of Object.entries(this.categories) as [('a' | 'b' | 'c' | 'd'), typeof this.categories['a']][]) {
      if (!enabledCategories[key]) {
        continue;
      }
      for (const pattern of cat.patterns) {
        if (pattern.test(command)) {
          return {
            isBlocked: true,
            category: key.toUpperCase() as 'A' | 'B' | 'C' | 'D',
            reason: `Triggered Category ${key.toUpperCase()} (${cat.name}) rule.`,
          };
        }
      }
    }
    return { isBlocked: false };
  }
}

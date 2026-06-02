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
        // Recursive delete of root / home / glob, tolerant of flag order and
        // splitting: `rm -rf /`, `rm -f -r /`, `rm --recursive --force /`,
        // `rm -rf ~`, `rm -fr *`. A relative target (`rm -rf ./build`) is left
        // alone to avoid flagging routine cleanup.
        /rm\s+(?:-{1,2}[a-z]+\s+)*-{1,2}[a-z]*r[a-z]*\s+(?:-{1,2}[a-z]+\s+)*[/*~]/i,
        /del\s+\/s\s+\/q\s+[A-Za-z]:\\*/i,
        /mkfs\..*/i,
        // Raw-disk overwrite (disk wipe) — match writing to a block device
        // regardless of arg order, plus zero/random sources piped to any `of=`.
        /\bdd\b[^|;&\n]*\bof=\/dev\/(?:sd|nvme|hd|vd|disk|mapper)/i,
        /\bdd\b[^|;&\n]*\bif=\/dev\/(?:zero|urandom|random)\b[^|;&\n]*\bof=/i,
        /cat\s+\/dev\/null\s+>/i,
        /chmod\s+-R\s+777/i,
        // Recursive ownership change scoped to root or a glob target, so a
        // routine `chown -R user ./localdir` does NOT trip a false positive.
        /chown\s+-R[a-z]*\s+\S+\s+[/*](?:\s|$)/i,
      ],
    },
    b: {
      name: 'Reverse Shells & Network Pivots',
      patterns: [
        /curl\s+.*\|\s*(?:bash|sh|zsh|ksh|dash|fish)\b/i,
        /wget\s+.*\|\s*(?:bash|sh|zsh|ksh|dash|fish)\b/i,
        // Process substitution: `bash <(curl evil)` / `sh <(wget evil)`.
        /\b(?:bash|sh|zsh|ksh|dash)\s+<\(\s*(?:curl|wget)\b/i,
        /nc\s+-e\s+\/bin\/sh/i,
        /netcat\s+-c/i,
        /curl\s+.*(?:-d|-F|--data|--form|-X\s*POST).*(\/etc\/passwd|\.env|\.git\/config)/i,
      ],
    },
    c: {
      name: 'Process & Resource Exhaustion',
      patterns: [
        // Fork bomb of any function name, tolerant of whitespace:
        // `:(){ :|:& };:` and `: () { :|:& };:`. The backreference ties the
        // recursive calls to the function's own name.
        /([:\w]+)\s*\(\s*\)\s*\{\s*\1\s*\|\s*\1\s*&\s*\}\s*;\s*\1/,
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
        // Any hard reset is destructive (discards working tree), not just
        // `HEAD~N`: also catches `--hard origin/main`, bare `--hard`.
        /git\s+reset\s+--hard\b/i,
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

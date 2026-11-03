import fs from 'node:fs';

export interface SandboxResult {
  client: string;
  sandboxed: boolean;
  confidence: number;
  signals: string[];
}

export class SandboxDetector {
  // What the firewall's own filesystem says about its container. It does not
  // change under a running process, and detect() runs twice per request on the
  // thread that serves every client, so it is read once per detector.
  private filesystemSignals: { confidence: number; signals: string[] } | null = null

  private readFilesystemSignals(): { confidence: number; signals: string[] } {
    if (this.filesystemSignals) return this.filesystemSignals
    let confidence = 0
    const signals: string[] = []
    try {
      if (fs.existsSync('/.dockerenv')) {
        confidence += 0.5;
        signals.push('env-dockerenv');
      }
    } catch {
      // ignore
    }
    try {
      if (fs.existsSync('/proc/1/cgroup')) {
        const cgroup = fs.readFileSync('/proc/1/cgroup', 'utf-8');
        if (cgroup.includes('docker') || cgroup.includes('containerd') || cgroup.includes('kubepods')) {
          confidence += 0.4;
          signals.push('env-cgroup');
        }
      }
    } catch {
      // ignore
    }
    this.filesystemSignals = { confidence, signals }
    return this.filesystemSignals
  }

  public detect(userAgent: string | undefined, remoteAddress: string | undefined): SandboxResult {
    let confidence = 0.0;
    const signals: string[] = [];
    let client = 'unknown';

    // 1. User-Agent Parsing
    if (userAgent) {
      const ua = userAgent.toLowerCase();
      if (ua.includes('claude-cli') || ua.includes('claude code')) {
        client = 'claude-code';
        confidence += 0.5;
        signals.push('ua-claude');
      } else if (/^codex[\w-]*\//.test(ua)) {
        // Codex sends "<originator>/<version> (<os>; <arch>) <terminal>", the
        // originator codex_cli_rs, codex-tui, codex_vscode, codex_exec and so
        // on (codex-rs/login/src/auth/default_client.rs).
        client = 'codex';
        confidence += 0.5;
        signals.push('ua-codex');
      } else if (ua.includes('antigravity')) {
        client = 'antigravity';
        confidence += 0.6;
        signals.push('ua-antigravity');
      } else if (ua.includes('docker') || ua.includes('container')) {
        confidence += 0.3;
        signals.push('ua-container');
      }
    }


    // 2. Connection Source IP
    if (remoteAddress) {
      // Clean IPv6 mapped IPv4 (e.g., ::ffff:172.17.0.1)
      const ip = remoteAddress.replace(/^::ffff:/, '');
      if (ip === '127.0.0.1' || ip === '::1') {
        signals.push('ip-loopback');
      } else if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) {
        confidence += 0.3;
        signals.push('ip-docker-bridge');
      } else if (ip.startsWith('10.')) {
        confidence += 0.3;
        signals.push('ip-private-10');
      } else if (ip.startsWith('192.168.')) {
        confidence += 0.1;
        signals.push('ip-private-192');
      }
    }

    // 3. Firewall's Own Environment
    const own = this.readFilesystemSignals()
    confidence += own.confidence
    signals.push(...own.signals)

    if (process.env.KUBERNETES_SERVICE_HOST) {
      confidence += 0.5;
      signals.push('env-k8s');
    }

    // Cap confidence at 1.0
    confidence = Math.min(confidence, 1.0);
    let sandboxed = confidence >= 0.75;

    // 4. Config/Env Override (Highest Priority)
    if (process.env.LLMFW_SANDBOX !== undefined) {
      signals.push(`env-override=${process.env.LLMFW_SANDBOX}`);
      sandboxed = process.env.LLMFW_SANDBOX === 'true' || process.env.LLMFW_SANDBOX === '1';
      confidence = 1.0;
    }

    return {
      client,
      sandboxed,
      confidence,
      signals
    };
  }
}

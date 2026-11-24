import { loadConfig, applyObserveMode } from '../config/config.js';
import { Config } from '../types.js';
import { ProxyServer } from '../proxy/proxy.js';
import { GatewayServer } from '../gateway/gateway.js';
import { AuditLog, AuditWebhook, auditWebhookFor } from '../dashboard/auditLog.js';
import { CertFactory, crlUrlFor, parseCertificateExtensions } from '../proxy/certs.js';
import { createDashboardServer } from '../dashboard/server.js';
import { EventBus } from '../dashboard/eventBus.js';
import { MetricsRegistry } from '../dashboard/metrics.js';
import { Pipeline } from '../detection/pipeline.js';
import { SuppressionStore } from '../detection/suppressions.js';
import { ModuleManager } from '../modules/registry.js';
import type { ToolUsageModule } from '../modules/builtin/toolUsage.js';
import type { UsageMeterModule } from '../modules/builtin/usageMeter.js';
import { startConfigHotReload } from '../config/hotReload.js';
import { removeRuntimeState, writeRuntimeState } from './runtimeState.js';
import { X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import { join } from 'node:path';
import { platform } from 'node:os';
import { getLlmFwDir } from '../config/paths.js';
import { lanIPv4 } from '../config/net.js';
import { watchForStopRequest } from './stopRequest.js';
import { killPreviousInstance } from './stop.js';
import { nodeRuntimeAdvisory } from './nodeAdvisory.js';
import { checkForUpdate, shouldCheckForUpdates, startupBanner } from './updateCheck.js';
import { ownsSinkhole } from './sinkholeOwner.js';
import { restoreSinkholeHosts } from './hosts.js';
import { RULESET_VERSION } from '../detection/ruleset.js';
import { execFileSync } from 'node:child_process';
import { systemTool } from '../systemTool.js';
import { Lifecycle } from './lifecycle.js';
import { freeLlmFwPort, systemPortDeps, waitForPortFree } from './portOwner.js';
import { addPortRedirect, removePortRedirect } from './portRedirect.js';

// How long a graceful stop waits for every resource to close before it exits
// anyway (#863): a stuck audit webhook used to keep the process alive.
const SHUTDOWN_TIMEOUT_MS = 10_000;

/**
 * True when the `start` args request shared-server mode. `--standalone` is the
 * canonical spelling; `--stand-alone` is accepted as an alias.
 */
export function isStandalone(args: string[]): boolean {
  return args.includes('--standalone') || args.includes('--stand-alone');
}

/** True when the `start` args ask for the gateway (reverse-proxy) listener. */
export function isGateway(args: string[]): boolean {
  return args.includes('--gateway');
}

/**
 * True when the `start` args ask for observation instead of enforcement.
 * `--observe` is the canonical spelling; `--dry-run` and `--monitor` are
 * accepted because those are the words operators reach for.
 */
export function isObserve(args: string[]): boolean {
  return args.includes('--observe') || args.includes('--dry-run') || args.includes('--monitor');
}

/**
 * Apply standalone-server overrides in place: force forward-proxy mode and bind
 * the proxy + dashboard to all interfaces so remote clients can reach them.
 * Explicit LLM_FW_*_BIND env vars take precedence over the 0.0.0.0 default.
 *
 * Binding off-host is exactly what turns the credential checks on (see
 * src/auth.ts), so this also decides that clients will need a token.
 */
export function applyStandaloneOverrides(
  config: Config,
  env: NodeJS.ProcessEnv = process.env,
): void {
  config.proxy.mode = 'proxy';
  if (!env['LLM_FW_PROXY_BIND']) config.proxy.bindHost = '0.0.0.0';
  if (!env['LLM_FW_DASHBOARD_BIND']) config.dashboard.bindHost = '0.0.0.0';
  if (config.gateway?.enabled && !env['LLM_FW_GATEWAY_BIND']) config.gateway.bindHost = '0.0.0.0';
}

/**
 * Turn the gateway on from the command line. Kept separate from the config
 * default (which is off) so `--gateway` is the single obvious way to try it.
 */
export function applyGatewayOverrides(config: Config): void {
  if (config.gateway) config.gateway.enabled = true;
}

/**
 * Best-effort primary non-internal IPv4 address, for printing client setup hints.
 *
 * Re-exported from `config/net.ts`, where it now lives because the certificate
 * factory needs it too: the CRL distribution point baked into every issued
 * certificate has to be an address the client can actually reach.
 */
export { lanIPv4 };

export async function run(args: string[] = []): Promise<void> {
  const standalone = isStandalone(args);
  // Said before anything binds: the proxy decompresses and TLS-verifies
  // upstream responses on Node's own code (see nodeAdvisory.ts).
  const nodeAdvisory = nodeRuntimeAdvisory();
  if (nodeAdvisory) console.warn(`⚠ ${nodeAdvisory}`);
  const config = await loadConfig();
  // package.json sits two levels up from both src/cli and dist/cli.
  const { version } = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
  console.log(startupBanner(version, RULESET_VERSION));

  // Standalone server mode: expose the proxy (and dashboard/CA download) on all
  // interfaces so other machines on the network can route their LLM traffic
  // through this host. The sinkhole (local hosts-file redirect) is irrelevant
  // here — remote clients reach us purely as a forward HTTPS proxy — so it is
  // force-disabled below.
  // Order matters: --gateway turns the listener on, then --standalone decides
  // that every enabled listener binds off-host.
  if (isGateway(args)) applyGatewayOverrides(config);
  // Observation is applied after the listener flags and before anything reads
  // the config, so every gate is relaxed before the first request arrives.
  if (isObserve(args)) applyObserveMode(config);
  if (standalone) applyStandaloneOverrides(config);

  const llmfwDir = getLlmFwDir();
  const pidFile = join(llmfwDir, 'llm-fw.pid');

  // Replace any already-running instance (see killPreviousInstance for why it
  // is a SIGKILL), and say so: the old terminal just sees its process exit.
  const replaced = killPreviousInstance(pidFile);
  if (replaced !== null) {
    console.log(`Replaced the running llm-fw (PID ${replaced}): one instance runs at a time, and this one takes over its ports.`);
  }
  const listeners: [number, string][] = [
    [config.proxy.port, config.proxy.bindHost ?? '127.0.0.1'],
    [config.dashboard.port, config.dashboard.bindHost ?? '127.0.0.1'],
  ];
  for (const [port, host] of listeners) {
    if (await waitForPortFree(port, host, 500)) continue;
    // Only an earlier llm-fw is stopped (#863): this used to kill whatever
    // held the port, an unrelated dev server included.
    const { owners, stopped } = await freeLlmFwPort(port, systemPortDeps);
    if (!stopped) {
      console.error(owners.length
        ? `Port ${port} is in use by another program (PID ${owners.join(', ')}). llm-fw stops only an earlier llm-fw: stop that program, or give llm-fw another port (LLM_FW_PROXY_PORT, LLM_FW_DASHBOARD_PORT).`
        : `Port ${port} is in use and its owner could not be found. Free it, or give llm-fw another port (LLM_FW_PROXY_PORT, LLM_FW_DASHBOARD_PORT).`);
      process.exit(1);
    }
    console.log(`Port ${port} was held by an earlier llm-fw (PID ${owners.join(', ')}): stopped it.`);
    if (!await waitForPortFree(port, host)) {
      console.error(`Port ${port} could not be freed. Kill the process manually and retry.`);
      process.exit(1);
    }
  }
  const hostsPath = platform() === 'win32'
    ? 'C:\\Windows\\System32\\drivers\\etc\\hosts'
    : '/etc/hosts';

  // Also detect sinkhole from hosts file — covers the case where setup ran as
  // admin but config.json wasn't written (e.g. npm not in elevated PATH).
  const hostsHasSinkhole = (() => {
    try { return fs.readFileSync(hostsPath, 'utf8').includes('# llm-fw sinkhole'); }
    catch { return false; }
  })();
  // In standalone mode the sinkhole is meaningless (it redirects 127.0.0.1 on
  // THIS host, not the remote clients), so never activate it. The hosts marker
  // alone counts only on the default data dir: another instance's marker must
  // not make a dev or test instance adopt, and on exit tear down, its sinkhole
  // (#617, sinkholeOwner.ts).
  const sinkholeActive = ownsSinkhole({ standalone, mode: config.proxy.mode, hostsHasSinkhole, customLlmFwDir: Boolean(process.env.LLM_FW_DIR) });

  // Re-apply sinkhole infrastructure if it was removed by the previous stop.
  // This makes every `start` self-healing: hosts entries and port redirect are
  // restored automatically so the user never needs to re-run setup after restart.
  if (sinkholeActive) {
    try {
      const hostsContent = fs.readFileSync(hostsPath, 'utf8');
      if (!hostsContent.includes('# llm-fw sinkhole')) {
        const backup = hostsPath + '.llm-fw.bak';
        if (!fs.existsSync(backup)) fs.writeFileSync(backup, hostsContent, 'utf8');
        const hostLines = config.targets.map((t: string) => `127.0.0.1 ${t}`).join('\n');
        fs.appendFileSync(hostsPath, `\n# llm-fw sinkhole\n${hostLines}\n`, 'utf8');
      }
    } catch { /* no write access — hosts file already has entries or admin needed */ }

    const os = platform();
    if (os === 'win32') {
      try {
        execFileSync(systemTool('sc'), ['config', 'iphlpsvc', 'start=', 'auto'], { stdio: 'ignore' });
        execFileSync(systemTool('net'), ['start', 'iphlpsvc'], { stdio: 'ignore' });
      } catch { /* no admin rights or already running */ }
      try {
        const existingV4 = execFileSync(systemTool('netsh'), ['interface', 'portproxy', 'show', 'v4tov4'], { encoding: 'utf8' });
        if (!existingV4.includes('443')) {
          execFileSync(systemTool('netsh'), [
            'interface', 'portproxy', 'add', 'v4tov4',
            'listenport=443', 'listenaddress=127.0.0.1',
            `connectport=${config.proxy.httpsPort}`, 'connectaddress=127.0.0.1',
          ], { stdio: 'ignore' });
        }
        const existingV6 = execFileSync(systemTool('netsh'), ['interface', 'portproxy', 'show', 'v6tov4'], { encoding: 'utf8' });
        if (!existingV6.includes('443')) {
          execFileSync(systemTool('netsh'), [
            'interface', 'portproxy', 'add', 'v6tov4',
            'listenport=443', 'listenaddress=::1',
            `connectport=${config.proxy.httpsPort}`, 'connectaddress=127.0.0.1',
          ], { stdio: 'ignore' });
        }
      } catch { /* no admin rights */ }
    } else {
      // Its own pf anchor on macOS, added only once on Linux (#863).
      try { addPortRedirect(os, config.proxy.httpsPort); } catch { /* no root */ }
    }
  }

  function restoreHostsFile(): void {
    try {
      if (restoreSinkholeHosts(hostsPath, config.targets)) console.log('Hosts file restored.');
    } catch (err) {
      console.error('Failed to restore hosts file:', (err as Error).message);
    }
  }

  function cleanup(): void {
    if (sinkholeActive) {
      restoreHostsFile();
      const os = platform();
      if (os === 'win32') {
        try {
          execFileSync(systemTool('netsh'), [
            'interface', 'portproxy', 'delete', 'v4tov4',
            'listenport=443', 'listenaddress=127.0.0.1',
          ], { stdio: 'ignore' });
        } catch { }
        try {
          execFileSync(systemTool('netsh'), [
            'interface', 'portproxy', 'delete', 'v6tov4',
            'listenport=443', 'listenaddress=::1',
          ], { stdio: 'ignore' });
        } catch { }
      } else {
        // Only llm-fw's own anchor: `pfctl -F nat` flushed every NAT rule
        // on the host (#863).
        removePortRedirect(os, config.proxy.httpsPort);
      }
    }
    try {
      fs.unlinkSync(pidFile);
    } catch { }
    removeRuntimeState(llmfwDir);
  }

  // Declared here, assigned further below once the config is known.
  let gateway: GatewayServer | null = null;
  let auditLog: AuditLog | null = null;
  let auditWebhook: AuditWebhook | null = null;
  let toolUsage: ToolUsageModule | null = null;
  let usageMeter: UsageMeterModule | null = null;
  // Every resource is registered with the lifecycle as it is created, and the
  // signal handlers name only the lifecycle (#863). They once closed over
  // `const` bindings declared further down, so a signal during startup threw
  // a ReferenceError from the handler, and the proxy, the dashboard, the event
  // bus and the modules were never closed at all. stop() closes what exists by
  // then, once, every step even when one fails, and exits within
  // SHUTDOWN_TIMEOUT_MS. Flushing the audit sinks matters most: a batch still
  // queued at SIGTERM is the record of the last seconds before a rollout.
  const lifecycle = new Lifecycle({
    cleanup,
    exit: (code) => process.exit(code),
    log: (format, ...rest) => console.error(format, ...rest),
    timeoutMs: SHUTDOWN_TIMEOUT_MS,
  });

  // Register cleanup hooks before any IO. SIGINT/SIGTERM are the graceful
  // paths, so they also terminate the shared inference worker thread (Task
  // C3, detection.workerInference) if one was ever spawned — a no-op
  // otherwise. uncaughtException exits immediately without waiting on it;
  // the worker thread dies with the process either way.
  const gracefulStop = (): void => { lifecycle.stop(0); };
  process.on('SIGINT', gracefulStop);
  process.on('SIGTERM', gracefulStop);
  // `llm-fw stop` asks through a file before it signals: on Windows SIGTERM is
  // TerminateProcess and the handler above would never run (#310).
  lifecycle.add('stop-request watcher', watchForStopRequest(llmfwDir, process.pid, gracefulStop));
  process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
    cleanup();
    process.exit(1);
  });
  // A rejected promise nobody awaited was left to Node's default, which on
  // Node 15+ is to print a warning and terminate — but AFTER this process's
  // cleanup hooks were skipped entirely. That matters here more than in most
  // programs: cleanup() restores the hosts file and removes the :443 port
  // redirect, and a sinkhole install that outlives the process sends every
  // provider request on the machine to a port with nothing listening on it.
  //
  // Rethrowing inside uncaughtException's sibling handler routes it through
  // the handler above, so an unhandled rejection now takes the same documented
  // exit path as any other fatal error instead of a different, quieter one.
  process.on('unhandledRejection', (reason) => {
    throw reason instanceof Error ? reason : new Error(`Unhandled rejection: ${String(reason)}`);
  });

  // Write PID file
  fs.mkdirSync(llmfwDir, { recursive: true });
  fs.writeFileSync(pidFile, String(process.pid), 'utf8');

  // Task C4 — shared across the dashboard's EventBus (records block/warn/
  // event counters from the same hook that emits dashboard events) and the
  // proxy's and gateway's run() call boundaries (live traffic, and the
  // dashboard playground on the same pipeline), so GET /metrics reports on
  // the whole process.
  const metrics = new MetricsRegistry();
  const eventBus = new EventBus(config.dashboard, metrics);
  lifecycle.add('event bus', () => eventBus.destroy());

  // Durable audit trail. Attached to the EventBus because that is the single
  // funnel every block/warn/audit event already passes through, so nothing can
  // appear on the dashboard and be missing from the record.
  auditLog = config.audit?.enabled ? new AuditLog(config.audit) : null;
  auditWebhook = auditWebhookFor(config.audit);
  // Their failure counts, on /metrics (#865).
  metrics.setAuditSinks(auditLog ?? undefined, auditWebhook ?? undefined);
  if (auditLog) {
    const log = auditLog;
    lifecycle.add('audit log', () => log.close());
    auditLog.open();
    console.log(`Audit log: ${auditLog.filePath}${config.audit?.includePayloads ? ' (including payloads)' : ' (metadata only — set LLM_FW_AUDIT_PAYLOADS=true to include prompt text)'}`);
  }
  if (auditWebhook) {
    const hook = auditWebhook;
    lifecycle.add('audit webhook', () => hook.stop());
    auditWebhook.start();
    console.log(`Audit webhook: ${config.audit?.webhookUrl}`);
  }
  eventBus.setAuditSinks(auditLog ?? undefined, auditWebhook ?? undefined);
  // Shared across the dashboard's playground pipeline and the proxy's live-
  // traffic pipeline (constructed below) so an operator marking a false
  // positive from the dashboard actually suppresses future real traffic —
  // not just the dashboard's own /api/test calls.
  const suppressions = new SuppressionStore();
  // One pipeline for the dashboard, the proxy and the gateway (#863): each
  // built and initialised its own, three sets of anchor embeddings at startup
  // and three item caches, and with workerInference off three model loads.
  const pipeline = new Pipeline(config, (partial) => eventBus.emit(partial), suppressions);
  lifecycle.add('detection pipeline', () => pipeline.close());

  // Task C5 — watches <getLlmFwDir()>/config.json and hot-applies detection/
  // dlp/dos/rag/mcp/nonText/manyShot/crescendo/indirectInstruction/
  // harmfulRequest/responseScan toggles+thresholds onto this SAME `config`
  // object (shared by pipeline/proxy/dashboard below) with no restart. Cold
  // keys (ports/binds/mode/targets/interceptDomains) are logged as
  // restart-required and left untouched. On by default (config.hotReload,
  // env LLM_FW_HOT_RELOAD); stopped on graceful shutdown below.
  const hotReload = startConfigHotReload(config);
  lifecycle.add('config watcher', () => hotReload.stop());

  // A regenerated CA must carry a CRL distribution point this deployment can
  // actually serve: the URL follows the configured dashboard address rather
  // than assuming loopback on the default port.
  const caCrlUrl = crlUrlFor(config.dashboard?.bindHost, config.dashboard?.port);
  // Auto-upgrade CA cert if it lacks a CRL Distribution Point (fixes Windows Schannel).
  const caCertPath = join(llmfwDir, 'ca.crt');
  if (fs.existsSync(caCertPath)) {
    const certPem = fs.readFileSync(caCertPath, 'utf8');
    const caCert = new X509Certificate(certPem);
    const hasCdp = parseCertificateExtensions(caCert.raw).has('2.5.29.31');
    if (!hasCdp) {
      console.log('Upgrading CA cert (adding CRL distribution point)...');
      const cf = new CertFactory(caCrlUrl);
      cf.generateCA();
      cf.generateAndSaveCRL();
      if (platform() === 'win32') {
        try {
          execFileSync(systemTool('certutil'), ['-addstore', '-f', 'Root', caCertPath], { stdio: 'ignore' });
          console.log('CA cert reinstalled to OS trust store.');
        } catch { console.warn('Could not reinstall CA cert — re-run "llm-fw setup" as admin.'); }
      }
    } else {
      const crlPath = join(llmfwDir, 'ca.crl');
      if (!fs.existsSync(crlPath)) new CertFactory(caCrlUrl).generateAndSaveCRL();
    }
  }

  console.log('Loading embedding model...');
  await pipeline.init();
  console.log('Model ready.');

  const modules = new ModuleManager(config);
  lifecycle.add('modules', () => modules.close());
  // Tool Usage keeps its list across restarts, so the never-called tools it
  // suggests for the Tool Filter rest on more than one process's traffic.
  toolUsage = (modules.getModule('tool-usage') as ToolUsageModule | undefined) ?? null;
  toolUsage?.persistTo(join(getLlmFwDir(), 'tool-usage.json'));
  if (toolUsage) { const tu = toolUsage; lifecycle.add('tool usage', () => tu.flush()); }
  // So does the Usage Meter's evidence on how each client's conversations
  // use the prompt cache: fifty conversations can be days of traffic.
  usageMeter = (modules.getModule('usage-meter') as UsageMeterModule | undefined) ?? null;
  usageMeter?.persistTo(join(getLlmFwDir(), 'usage-clients.json'));
  if (usageMeter) { const um = usageMeter; lifecycle.add('usage by client', () => um.flush()); }
  const dashboardServer = createDashboardServer(config, eventBus, pipeline, suppressions, metrics, modules);
  // A dashboard that cannot listen used to be an unhandled 'error' event (#863).
  dashboardServer.on('error', (err: NodeJS.ErrnoException) => {
    console.error(`Dashboard could not listen on ${config.dashboard.bindHost}:${config.dashboard.port}: ${err.message}`);
    lifecycle.stop(1);
  });
  lifecycle.add('dashboard', () => new Promise<void>(resolve => {
    dashboardServer.closeAllConnections();
    dashboardServer.close(() => resolve());
  }));
  dashboardServer.listen(config.dashboard.port, config.dashboard.bindHost, () => {
    // listening
  });

  const proxy = new ProxyServer(config, eventBus, suppressions, metrics, modules, pipeline);
  lifecycle.add('proxy', () => proxy.stop());
  await proxy.init();
  proxy.start();

  // Gateway (reverse-proxy) listener — opt-in, and additive: it runs alongside
  // the forward proxy rather than replacing it, so a team can migrate clients
  // to base_url one at a time instead of in a flag day.
  if (config.gateway?.enabled) {
    gateway = new GatewayServer(config, eventBus, suppressions, metrics, modules, pipeline);
    const gw = gateway;
    lifecycle.add('gateway', () => gw.stop());
    await gateway.init();
    gateway.start();
    const gwHost = config.gateway.bindHost === '0.0.0.0' ? lanIPv4() : config.gateway.bindHost;
    const scheme = config.gateway.tls ? 'https' : 'http';
    console.log('');
    console.log(`llm-fw GATEWAY listening on ${scheme}://${gwHost}:${config.gateway.port}`);
    console.log('  Clients need no CA and no HTTPS_PROXY — point the SDK base_url here:');
    console.log(`    Anthropic:  ${scheme}://${gwHost}:${config.gateway.port}/anthropic`);
    console.log(`    OpenAI:     ${scheme}://${gwHost}:${config.gateway.port}/openai/v1`);
    console.log(`    Default (bare /v1/... paths): ${config.gateway.defaultProvider}`);
    if (gateway.auth.required) {
      console.log(`  Client token (X-Llm-Fw-Key or Authorization: Bearer): ${gateway.auth.token}`);
      if (gateway.auth.generated) {
        console.log('    GENERATED for this run — set LLM_FW_GATEWAY_TOKEN to pin it.');
      }
    } else {
      console.log('  ⚠ No client authentication (local-only bind).');
    }
    const tenantIds = gateway.tenantIds;
    if (tenantIds.length) {
      console.log(`  Tenants (${tenantIds.length}): ${tenantIds.join(', ')} — each has its own token, provider`);
      console.log('    allowlist, per-minute quota and enforcement mode. Quotas are per process,');
      console.log('    so with several replicas each enforces its own share.');
    }
    const custody = gateway.custodySlugs;
    console.log(custody.length
      ? `  Upstream key custody ON for: ${custody.join(', ')} — clients never see the provider key.`
      : '  Upstream key custody OFF — clients send their own provider key (set LLM_FW_GATEWAY_KEY_<SLUG> to take custody).');
    if (!config.gateway.tls) {
      console.log('  Serving plain HTTP. Terminate TLS at a load balancer/ingress, or set');
      console.log('  LLM_FW_GATEWAY_TLS_CERT / LLM_FW_GATEWAY_TLS_KEY to serve HTTPS directly.');
    }
    console.log('  Response-side scans (exfil/harm/tool-use) are proxy-only; the gateway');
    console.log('  runs the full request-side pipeline and streams responses through.');
  }

  if (config.enforcement === 'observe') {
    console.log('');
    console.log('  ◉ OBSERVE MODE — recording verdicts, blocking nothing.');
    console.log('    Every detector runs and every would-be block is recorded as an event');
    console.log('    with enforced=false, but no request is refused. Watch the dashboard');
    console.log(`    (http://127.0.0.1:${config.dashboard.port}) for a few days, mark the false positives, then`);
    console.log('    restart without --observe to enforce.');
    console.log('    Resource limits (DoS quota, loop breaker) and client authentication');
    console.log('    still apply — they are not detection verdicts.');
    if (!config.audit?.enabled) {
      console.log('    Tip: LLM_FW_AUDIT_ENABLED=true keeps the observation across restarts.');
    }
    console.log('');
  }
  if (config.proxy.bypass) {
    console.log('');
    console.log('  ⚠⚠⚠ FAIL-SAFE BYPASS ACTIVE (LLM_FW_BYPASS=true) ⚠⚠⚠');
    console.log('  The proxy is a TRANSPARENT TUNNEL: no interception, no detection,');
    console.log('  no blocking. All traffic passes through uninspected. Unset');
    console.log('  LLM_FW_BYPASS and restart to re-enable the firewall.');
    console.log('');
  }

  if (sinkholeActive) {
    proxy.startSinkhole(config.proxy.httpsPort);
    console.log(`  Sinkhole TLS: 127.0.0.1:${config.proxy.httpsPort} (via portproxy → :443)`);
  }

  // Every listener is up: record what this process actually runs, for
  // `status`, `doctor` and the dashboard (#320, #338).
  const reachable = (bindHost: string): string => (bindHost === '0.0.0.0' ? lanIPv4() : bindHost);
  writeRuntimeState(llmfwDir, {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    enforcement: config.enforcement === 'observe' ? 'observe' : 'enforce',
    proxyUrl: `http://${reachable(config.proxy.bindHost)}:${config.proxy.port}`,
    dashboardUrl: `http://${reachable(config.dashboard.bindHost)}:${config.dashboard.port}`,
    gatewayUrl: gateway && config.gateway
      ? `${config.gateway.tls ? 'https' : 'http'}://${reachable(config.gateway.bindHost)}:${config.gateway.port}`
      : null,
    sinkhole: sinkholeActive,
  });

  if (standalone) {
    const ip = lanIPv4();
    console.log(`llm-fw running in STANDALONE server mode.`);
    console.log(`  Proxy:      http://${ip}:${config.proxy.port}  (listening on ${config.proxy.bindHost}:${config.proxy.port})`);
    console.log(`  Dashboard:  http://${ip}:${config.dashboard.port}`);
    console.log('');
    console.log('  Configure each client machine:');
    console.log(`    1. Download & trust the CA cert:  http://${ip}:${config.dashboard.port}/ca.crt?download`);
    console.log(`       (install into the OS / browser "Trusted Root" store — and note that`);
    console.log(`        Node, Python and Java each ignore it and need their own variable)`);
    const cred = proxy.auth.required ? `llm-fw:${proxy.auth.token}@` : '';
    console.log(`    2. Point tools at the proxy:`);
    // HTTPS_PROXY only: this listener answers CONNECT and has no plain-HTTP
    // forward path, so advertising HTTP_PROXY sent clients down a route that
    // now returns 501 (and used to hang).
    console.log(`         export HTTPS_PROXY=http://${cred}${ip}:${config.proxy.port}`);
    console.log(`         export NO_PROXY=localhost,127.0.0.1,::1`);
    console.log(`       HTTPS_PROXY is not selective and NO_PROXY is honoured only by the`);
    console.log(`       client, so add your internal hosts to it — otherwise every HTTPS`);
    console.log(`       connection that client makes is routed through this server.`);
    console.log('');
    if (proxy.auth.required) {
      console.log('  Proxy authentication is ON. Clients must present the token above as');
      console.log('  Proxy-Authorization (Basic with the token as the password, or Bearer).');
      if (proxy.auth.generated) {
        console.log('  This token was GENERATED for this run and changes on restart — set');
        console.log('  LLM_FW_PROXY_TOKEN to pin it.');
      }
    } else {
      console.log('  ⚠ Proxy authentication is DISABLED (proxy.requireAuth=false). Any host');
      console.log('    that can route to this machine can relay traffic through it.');
    }
    console.log('    To keep the dashboard local-only while still exposing the proxy, set');
    console.log('    LLM_FW_DASHBOARD_BIND=127.0.0.1.');
  } else {
    console.log(`llm-fw running.`);
    console.log(`  Proxy port:  ${config.proxy.port}`);
    console.log(`  HTTPS_PROXY: http://127.0.0.1:${config.proxy.port}`);
    console.log(`  Dashboard:   http://127.0.0.1:${config.dashboard.port}`);
    // Local mode only: a standalone server's clients are other machines, and
    // its own trust store says nothing about theirs. Never fatal (#775).
    try {
      const { caTrustStartupWarning, detectCaTrust } = await import('./doctor.js');
      const os = platform() as 'win32' | 'darwin' | 'linux';
      const lines = caTrustStartupWarning(os, caCertPath, detectCaTrust(os, caCertPath));
      if (lines.length) console.warn(['', ...lines].join('\n'));
    } catch { /* the check is advice, not a gate */ }
  }

  // Printed on every start, in both modes. Standalone mode in particular is the
  // shape a company reaches for — one shared server for a team — so the licence
  // boundary should not be something you only discover by opening LICENSE.md.
  const { SHORT_NOTICE, unlicensedBanner } = await import('./license.js');
  console.log('');
  console.log(`  ${SHORT_NOTICE}`);
  // Unlicensed machines get the loud version too. Deliberately AFTER the proxy
  // is already listening: the banner is a nag, not a gate, and the firewall runs
  // either way. Anything else would turn a lapsed invoice into an open door.
  for (const line of unlicensedBanner()) console.log(line);

  // Never awaited: startup is done, and the check says nothing on failure.
  if (shouldCheckForUpdates(config)) {
    void checkForUpdate(version).then(msg => { if (msg) console.log(`\n  ${msg}`); });
  }

  // Keep process alive
  setInterval(() => { }, 1 << 30);
}

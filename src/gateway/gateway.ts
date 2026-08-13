import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import { Config, PipelineResult } from '../types.js';
import { Pipeline } from '../detection/pipeline.js';
import { SuppressionStore } from '../detection/suppressions.js';
import { EventBus } from '../dashboard/eventBus.js';
import { MetricsRegistry } from '../dashboard/metrics.js';
import { DlpScanner } from '../detection/dlp/scanner.js';
import { getParser } from '../detection/parsers.js';
import { explainBlock, explainGate } from '../detection/explain.js';
import { resolveAuthPolicy, authorizeClient, credentialFromAuthHeader, type AuthPolicy } from '../auth.js';
import { BUILTIN_PROVIDERS, resolveRoute, applyUpstreamAuth, type GatewayProvider, type GatewayRoute } from './routes.js';
import { TenantRegistry, type Tenant } from './tenants.js';
import { isObserving } from '../config/config.js';

/**
 * Reverse-proxy ("gateway") deployment.
 *
 * The forward proxy inspects traffic by intercepting TLS to the provider, so
 * every client must trust the firewall's CA. The gateway inverts that: it is
 * the endpoint, clients set `base_url` to it, and it speaks to the provider on
 * their behalf. No CA install, which is what makes it usable from a CI
 * container, a Lambda, or a company laptop the developer does not administer.
 *
 * It also lets the operator hold the provider API keys (see applyUpstreamAuth):
 * clients authenticate to the gateway with a token the operator can revoke, and
 * never see the provider credential at all.
 *
 * SCOPE OF THIS IMPLEMENTATION: request-side detection (DLP + the full
 * injection pipeline) runs exactly as it does on the proxy path. Response-side
 * scanning (exfil / harmful-compliance / tool-use) is proxy-only for now and
 * responses stream through untouched — see the README deployment table. That
 * is a real difference, not an oversight to discover in production.
 */
export class GatewayServer {
  private server: http.Server;
  private pipeline: Pipeline;
  private dlp: DlpScanner;
  private eventBus: EventBus;
  private metrics?: MetricsRegistry;
  private config: Config;
  private authPolicy: AuthPolicy;
  private providers: Record<string, GatewayProvider>;
  private apiKeys: Record<string, string>;
  private tenants: TenantRegistry;

  constructor(config: Config, eventBus: EventBus, suppressions?: SuppressionStore, metrics?: MetricsRegistry) {
    this.config = config;
    this.eventBus = eventBus;
    this.metrics = metrics;
    this.pipeline = new Pipeline(config, partial => eventBus.emit(partial), suppressions);
    this.dlp = new DlpScanner(config.dlp);

    const gw = config.gateway;
    this.providers = { ...BUILTIN_PROVIDERS };
    this.apiKeys = {};
    for (const [slug, entry] of Object.entries(gw?.providers ?? {})) {
      const builtin = BUILTIN_PROVIDERS[slug];
      this.providers[slug] = {
        name: entry.name ?? builtin?.name ?? slug,
        host: entry.host ?? builtin?.host ?? '',
        auth: entry.auth ?? builtin?.auth ?? 'bearer',
        port: entry.port ?? builtin?.port,
        protocol: entry.protocol ?? builtin?.protocol,
      };
      if (entry.apiKey) this.apiKeys[slug] = entry.apiKey;
    }
    // Env keys win over the config file: a container gets its secrets from the
    // environment or a mounted secret, not from a config file baked into an
    // image. LLM_FW_GATEWAY_KEY_ANTHROPIC → slug "anthropic".
    for (const [name, value] of Object.entries(process.env)) {
      if (!name.startsWith('LLM_FW_GATEWAY_KEY_') || !value) continue;
      this.apiKeys[name.slice('LLM_FW_GATEWAY_KEY_'.length).toLowerCase()] = value;
    }

    this.tenants = new TenantRegistry(gw?.tenants);

    this.authPolicy = resolveAuthPolicy({
      requireAuth: gw?.requireAuth,
      authToken: gw?.authToken,
      bindHost: gw?.bindHost,
    });

    const tls = gw?.tls;
    this.server = tls
      ? https.createServer(
        { cert: fs.readFileSync(tls.certFile), key: fs.readFileSync(tls.keyFile) },
        (req, res) => { void this.handle(req, res); },
      )
      : http.createServer((req, res) => { void this.handle(req, res); });
  }

  /** Credential clients must present. Printed at startup by cli/start.ts. */
  get auth(): AuthPolicy { return this.authPolicy; }

  /** Slugs that have an operator-held upstream key, for the startup banner. */
  get custodySlugs(): string[] { return Object.keys(this.apiKeys).sort(); }

  /** Configured tenant ids, for the startup banner. */
  get tenantIds(): string[] { return this.tenants.ids; }

  async init(): Promise<void> {
    await this.pipeline.init();
  }

  start(): void {
    const gw = this.config.gateway;
    this.server.listen(gw?.port ?? 8081, gw?.bindHost ?? '127.0.0.1');
  }

  async stop(): Promise<void> {
    await Promise.all([
      new Promise<void>(resolve => this.server.close(() => resolve())),
      this.pipeline.close(),
    ]);
  }

  private json(res: http.ServerResponse, status: number, body: unknown): void {
    if (res.headersSent) return;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://gateway.local');
      const pathname = url.pathname;

      // Probes answer before auth: a Kubernetes kubelet cannot present a
      // bearer token, and a liveness probe that 401s makes the pod restart
      // forever. They expose no traffic data.
      if (pathname === '/healthz' || pathname === '/livez') {
        return this.json(res, 200, { status: 'ok' });
      }
      if (pathname === '/readyz') {
        const models = this.pipeline.getModelStatus();
        // Ready means detection can actually run. Reporting ready before the
        // embedding model is loaded would let a rollout send traffic to a pod
        // that either blocks on a cold load or scans with fewer stages.
        return models.embedding
          ? this.json(res, 200, { status: 'ready', models })
          : this.json(res, 503, { status: 'loading', models });
      }

      // Client credential: a dedicated header first so it never collides with
      // the provider key, falling back to bearer for clients whose SDK only
      // exposes the standard auth header (the key-custody case).
      const dedicated = (req.headers['x-llm-fw-key'] as string | undefined)?.trim();
      const presented = dedicated || credentialFromAuthHeader(req.headers.authorization);
      // Remember WHERE the gateway's own credential arrived. When it came in
      // `Authorization` — which the docs allow, for SDKs that expose no other
      // header — that header carries an internal firewall secret, not a
      // provider key, and must not be forwarded upstream. Key custody replaces
      // it anyway; with custody OFF nothing else would strip it, and the
      // operator's token would land in a third party's access logs.
      const authIsInternal = !dedicated && presented !== '';
      // A tenant token authenticates on its own. The deployment-wide token
      // keeps working alongside tenants, so adding tenants to an existing
      // gateway never locks out the credential already in use.
      const tenant = this.tenants.resolve(presented);
      const authorised = tenant !== null
        || authorizeClient(this.authPolicy, req.socket.remoteAddress, presented);
      if (!authorised) {
        res.setHeader('WWW-Authenticate', 'Bearer realm="llm-fw gateway"');
        return this.json(res, 401, {
          error: 'authentication required',
          detail: 'Present the gateway token as X-Llm-Fw-Key or Authorization: Bearer.',
        });
      }

      const route = resolveRoute(pathname, {
        defaultProvider: this.config.gateway?.defaultProvider ?? 'openai',
        providers: this.providers,
      });
      if (!route) {
        return this.json(res, 404, {
          error: 'no route for path',
          detail: `Use /<provider>/<path> (e.g. /anthropic/v1/messages) or a provider-shaped path. Known providers: ${Object.keys(this.providers).sort().join(', ')}`,
        });
      }

      if (tenant) {
        // Provider allowlist before quota: refusing a provider this tenant may
        // not use should not consume their request budget.
        if (!this.tenants.allowsProvider(tenant, route.slug)) {
          return this.json(res, 403, {
            error: 'provider not permitted for this tenant',
            tenant: tenant.id,
            provider: route.slug,
            allowed: tenant.providers,
          });
        }
        const quota = this.tenants.charge(tenant, Date.now());
        if (!quota.allowed) {
          res.setHeader('Retry-After', String(quota.retryAfterSeconds));
          this.eventBus.emit({
            stage: 'dos', score: 0, similarity: 0,
            target: route.provider.host, method: req.method ?? 'POST', path: route.upstreamPath,
            payload_preview: `tenant quota exceeded: ${quota.used}/${quota.limit} per minute`,
            payload_full: `tenant ${tenant.id} exceeded ${quota.limit} requests/minute`,
            action: 'blocked', kind: 'dos', dosReason: 'tenant-quota', tenant: tenant.id,
          });
          return this.json(res, 429, {
            error: 'tenant quota exceeded',
            tenant: tenant.id,
            limit_per_minute: quota.limit,
            retry_after_seconds: quota.retryAfterSeconds,
          });
        }
      }

      const body = await this.readBody(req, res);
      if (body === null) return; // readBody already answered (413 / read error)

      const decision = await this.screen(req, route, body, tenant);
      if (decision.blocked) {
        this.json(res, decision.status, decision.body);
        return;
      }

      await this.forward(req, res, route, decision.body, authIsInternal);
    } catch (err) {
      console.error(`[gateway] ${req.method} ${req.url} — ${(err as Error)?.message ?? String(err)}`);
      this.json(res, 502, { error: 'gateway error' });
    }
  }

  /** Buffer the request body under the configured cap. Null means answered. */
  private readBody(req: http.IncomingMessage, res: http.ServerResponse): Promise<Buffer | null> {
    const cap = this.config.proxy.maxBodyBytes;
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > cap) {
          this.json(res, 413, { error: 'request body too large', limit_bytes: cap });
          req.destroy();
          resolve(null);
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', () => {
        this.json(res, 400, { error: 'request read error' });
        resolve(null);
      });
    });
  }

  /**
   * Run the request-side detection stages. Returns either a block response or
   * the (possibly DLP-redacted) body to forward.
   */
  private async screen(
    req: http.IncomingMessage,
    route: GatewayRoute,
    original: Buffer,
    tenant: Tenant | null,
  ): Promise<{ blocked: true; status: number; body: unknown } | { blocked: false; body: Buffer }> {
    const method = req.method ?? 'POST';
    const path = route.upstreamPath;
    const target = route.provider.host;
    const sessionKey = (req.socket.remoteAddress ?? 'unknown').replace(/^::ffff:/, '');
    const dashboardUrl = this.dashboardUrl();
    let bodyBuf = original;
    let text = bodyBuf.toString('utf-8');

    // Whether THIS request is only being observed. The deployment-wide setting
    // is not enough: a tenant can observe while the rest of the deployment
    // enforces, and every gate below has to honour that or the guarantee is
    // per-detector rather than total.
    const observing = isObserving(this.config.enforcement, tenant?.enforcement);
    const tenantTag = tenant ? { tenant: tenant.id } : {};
    const observedTag = observing ? { enforced: false } : {};

    // DLP — same scoping as the proxy: only requests a parser recognises, so
    // binary uploads are not scanned as if they were prompts.
    if (this.config.dlp.enabled && getParser(path) !== null) {
      const findings = this.dlp.scan(text);
      if (findings.length) {
        const types = Array.from(new Set(findings.map(f => f.type)));
        // Observation must not refuse the request and must not rewrite it
        // either: 'redact' alters the body the client sent, which is exactly
        // what an observing tenant is promised will not happen.
        const mode = observing ? 'audit' : this.config.dlp.mode;
        const event = this.eventBus.emit({
          stage: 'dlp', score: 100, similarity: 0,
          target, method, path,
          payload_preview: types.join(', '), payload_full: types.join(', '),
          action: this.config.dlp.mode === 'block' ? 'blocked' : 'warned',
          kind: 'dlp', dlpType: findings[0].type,
          ...observedTag, ...tenantTag,
        });
        if (mode === 'block') {
          return {
            blocked: true, status: 403,
            body: explainGate({
              eventId: event.id, error: 'sensitive data detected',
              stage: 'dlp', kind: 'dlp', detail: types.join(', '), dashboardUrl,
            }),
          };
        }
        if (mode === 'redact') {
          text = this.dlp.redact(text, findings);
          bodyBuf = Buffer.from(text, 'utf-8');
        }
      }
    }

    const started = Date.now();
    // Capture the id of the event THIS run stored, so the client is pointed at
    // the record that actually describes their request. Reading the most recent
    // event from the shared ring would attribute the wrong id under concurrent
    // traffic — exactly when someone is trying to trace a block.
    let eventId = 'unknown';
    let result: PipelineResult;
    try {
      result = await this.pipeline.run(path, text, {
        target, method, path, sessionKey,
        onEvent: e => { eventId = e.id; },
        // Per-tenant enforcement: one team can run in observation while the rest
        // of the deployment enforces — how a team gets onboarded without either
        // eating day-one false positives or the firewall being turned down for
        // everyone. Also stamps tenant attribution onto every event this emits.
        ...(tenant ? { enforcement: tenant.enforcement, tenant: tenant.id } : {}),
      });
    } catch (err) {
      // detection.failMode, honoured here rather than left to the outer catch.
      // A throw inside the pipeline is a BUG in detection, not a verdict about
      // the request, and the operator has already said which way they want that
      // resolved — the forward proxy reads the same setting. Letting it fall
      // through to a blanket 502 would ignore an availability decision the Helm
      // chart explicitly documents, on the deployment that chart ships.
      this.metrics?.recordScan('gateway', Date.now() - started);
      const message = (err as Error)?.message ?? String(err);
      const failOpen = this.config.detection.failMode === 'open';
      const event = this.eventBus.emit({
        stage: 'none', score: 0, similarity: 0,
        target, method, path,
        payload_preview: `Detection pipeline error — failing ${failOpen ? 'OPEN, forwarded' : 'CLOSED, blocked'}: ${message}`.slice(0, 220),
        payload_full: (err as Error)?.stack ?? message,
        action: failOpen ? 'warned' : 'blocked',
        kind: 'error',
        ...tenantTag,
      });
      console.error(`[gateway] pipeline error on ${method} ${path}: ${message}`);
      if (failOpen) return { blocked: false, body: bodyBuf };
      return {
        blocked: true, status: 403,
        body: explainGate({
          eventId: event.id, error: 'detection unavailable',
          stage: 'none', kind: 'error', detail: message, dashboardUrl,
          remediation: 'The firewall could not scan this request and is configured to fail closed. Set detection.failMode="open" to forward unscanned instead.',
        }),
      };
    }
    this.metrics?.recordScan('gateway', Date.now() - started);

    if (result.action === 'block') {
      return {
        blocked: true, status: 403,
        body: explainBlock({ eventId, result, dashboardUrl }),
      };
    }

    return { blocked: false, body: bodyBuf };
  }

  /** Dashboard base URL for block remediation hints, when it is reachable. */
  private dashboardUrl(): string | undefined {
    const d = this.config.dashboard;
    if (!d) return undefined;
    const host = d.bindHost && d.bindHost !== '0.0.0.0' ? d.bindHost : '127.0.0.1';
    return `http://${host}:${d.port}`;
  }

  /** Hop-by-hop headers, plus the ones we recompute for the upstream call. */
  private static readonly STRIPPED_HEADERS = new Set([
    'connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade',
    'proxy-connection', 'proxy-authorization', 'proxy-authenticate',
    'host', 'content-length', 'x-llm-fw-key',
  ]);

  private async forward(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    route: GatewayRoute,
    body: Buffer,
    /** True when the gateway consumed `Authorization` as its OWN credential. */
    authIsInternal: boolean,
  ): Promise<void> {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (GatewayServer.STRIPPED_HEADERS.has(name) || value === undefined) continue;
      headers[name] = Array.isArray(value) ? value.join(', ') : value;
    }
    headers['host'] = route.provider.host;
    if (body.length) headers['content-length'] = String(body.length);
    // Drop the internal credential before it can leave the building. Only when
    // the gateway actually consumed this header itself: a client that
    // authenticated with X-Llm-Fw-Key and sent its OWN provider key in
    // Authorization still needs that key forwarded in custody-off mode.
    if (authIsInternal) delete headers['authorization'];

    const outbound = applyUpstreamAuth(headers, route, this.apiKeys[route.slug]);

    const transport = route.provider.protocol === 'http' ? http : https;
    const port = route.provider.port ?? (route.provider.protocol === 'http' ? 80 : 443);

    await new Promise<void>((resolve) => {
      const upstream = transport.request(
        {
          host: route.provider.host,
          port,
          method: req.method,
          path: route.upstreamPath + (req.url?.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''),
          headers: outbound,
          timeout: this.config.proxy.upstreamTimeoutMs,
        },
        (upRes) => {
          res.writeHead(upRes.statusCode ?? 502, upRes.headers);
          // Piped, not buffered: a streaming completion must reach the client
          // token by token, exactly as the provider emitted it.
          upRes.pipe(res);
          upRes.on('end', () => resolve());
          upRes.on('error', () => { res.destroy(); resolve(); });
        },
      );
      upstream.on('timeout', () => {
        upstream.destroy();
        this.json(res, 504, { error: 'upstream timeout', upstream: route.provider.host });
        resolve();
      });
      upstream.on('error', (err) => {
        console.error(`[gateway] upstream ${route.provider.host} — ${err.message}`);
        this.json(res, 502, { error: 'upstream request failed', upstream: route.provider.host });
        resolve();
      });
      if (body.length) upstream.write(body);
      upstream.end();
    });
  }
}

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
import { resolveAuthPolicy, authorizeClient, credentialFromAuthHeader, tokenMatches, type AuthPolicy } from '../auth.js';
import { BUILTIN_PROVIDERS, resolveRoute, applyUpstreamAuth, stripCredentialQuery, upstreamHostHeader, type GatewayProvider, type GatewayRoute } from './routes.js';
import { TenantRegistry, type Tenant } from './tenants.js';
import { isObserving } from '../config/config.js';
import { isAuthPath } from '../detection/urlHeuristic.js';
import { createLogger, withRequestId } from '../logger.js';
import { ModuleManager } from '../modules/registry.js';
import { tapResponse } from '../modules/responseTap.js';
import type { GatewayModuleContext } from '../modules/types.js';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';
import type { Duplex } from 'node:stream';
import { realtimeProtocolFor, WS_NOT_INSPECTABLE } from '../proxy/websocket.js';
import { relayRealtimeSession, WS_SKIPPED_HEADERS } from '../proxy/realtimeRelay.js';

const log = createLogger('gateway');

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
  private metrics?: MetricsRegistry | undefined;
  private config: Config;
  private authPolicy: AuthPolicy;
  private providers: Record<string, GatewayProvider>;
  private apiKeys: Record<string, string>;
  private tenants: TenantRegistry;
  private modules: ModuleManager;
  /**
   * Upgraded WebSocket sockets. The http server stops tracking a socket once
   * it is upgraded, but `close()` still waits for it, so without ending them
   * a stop hung for as long as any Realtime session stayed open.
   */
  private sessions = new Set<Duplex>();

  constructor(config: Config, eventBus: EventBus, suppressions?: SuppressionStore, metrics?: MetricsRegistry, moduleManager?: ModuleManager) {
    this.config = config;
    this.eventBus = eventBus;
    this.metrics = metrics;
    this.modules = moduleManager ?? new ModuleManager(config);
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
    // Every log line this request produces carries the same id, however deep
    // in the detection pipeline it is written. An inbound x-request-id is
    // honoured so the id joins up with whatever sent the request; otherwise one
    // is minted here. The id is echoed back, so a caller reporting "my request
    // was blocked" can quote something an operator can grep for.
    const serve = (req: http.IncomingMessage, res: http.ServerResponse): void => {
      const inbound = (req.headers['x-request-id'] as string | undefined)?.trim();
      const requestId = inbound && inbound.length <= 200 ? inbound : randomUUID();
      res.setHeader('x-request-id', requestId);
      withRequestId(requestId, () => { void this.handle(req, res); });
    };

    this.server = tls
      ? https.createServer(
        { cert: fs.readFileSync(tls.certFile), key: fs.readFileSync(tls.keyFile) },
        serve,
      )
      : http.createServer(serve);
    this.server.on('upgrade', (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
      this.sessions.add(socket);
      socket.once('close', () => this.sessions.delete(socket));
      this.handleUpgrade(req, socket, head);
    });
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
    for (const socket of this.sessions) socket.destroy();
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

      const { tenant, authIsInternal, authorised } = this.authenticate(req);
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

      // Modules that read responses (the usage meter) see what the client
      // received, captured as it streams through.
      const moduleCtx = this.moduleContext(req, route, tenant);
      const captured = moduleCtx && this.modules.wantsResponses()
        ? tapResponse(res, this.config.proxy.maxBodyBytes)
        : null;
      await this.forward(req, res, route, decision.body, authIsInternal);
      const response = captured?.();
      if (moduleCtx && response) this.modules.observeResponse(decision.body.toString('utf-8'), moduleCtx, response);
    } catch (err) {
      log.error(`${req.method} ${req.url} — ${(err as Error)?.message ?? String(err)}`);
      this.json(res, 502, { error: 'gateway error' });
    }
  }

  /** Who is calling, from the request's credential. Shared by HTTP and WebSocket upgrades. */
  private authenticate(req: http.IncomingMessage): { tenant: Tenant | null; authIsInternal: boolean; authorised: boolean } {
    // Client credential: a dedicated header first so it never collides with
    // the provider key, falling back to bearer for clients whose SDK only
    // exposes the standard auth header (the key-custody case).
    const dedicated = (req.headers['x-llm-fw-key'] as string | undefined)?.trim();
    const presented = dedicated || credentialFromAuthHeader(req.headers.authorization);
    // A tenant token authenticates on its own. The deployment-wide token
    // keeps working alongside tenants, so adding tenants to an existing
    // gateway never locks out the credential already in use.
    const tenant = this.tenants.resolve(presented);
    // Remember WHERE the gateway's own credential arrived. When it came in
    // `Authorization` — which the docs allow, for SDKs that expose no other
    // header — that header carries an internal firewall secret, not a
    // provider key, and must not be forwarded upstream. Key custody replaces
    // it anyway; with custody OFF nothing else would strip it, and the
    // operator's token would land in a third party's access logs.
    // Only a bearer that IS a gateway credential counts. Any other bearer is
    // the caller's own provider key (OpenAI-style APIs, Claude Code's OAuth
    // login), which custody-off passthrough must forward: stripping it on a
    // local gateway that asks for no token left upstream with no key at all.
    const authIsInternal = !dedicated && (tenant !== null
      || (this.authPolicy.required && tokenMatches(presented, this.authPolicy.token)));
    const authorised = tenant !== null
      || authorizeClient(this.authPolicy, req.socket.remoteAddress, presented);
    return { tenant, authIsInternal, authorised };
  }

  /**
   * A WebSocket handshake (#344). The same gates as an HTTP request run first,
   * in the same order: auth, route, the tenant's provider allowlist and quota
   * (one charge per session). Then the OpenAI Realtime API and Gemini Live
   * are relayed with their client messages inspected, exactly as on the
   * proxy; any other WebSocket path answers 501. Key custody covers the
   * handshake like a request: the operator key replaces the caller's, in the
   * headers, the query and the browser-style `openai-insecure-api-key.`
   * subprotocol.
   */
  private handleUpgrade(req: http.IncomingMessage, client: Duplex, head: Buffer): void {
    client.on('error', () => client.destroy());
    const answer = (status: number, reason: string, body: unknown, extra = ''): void => {
      const json = JSON.stringify(body);
      client.end(`HTTP/1.1 ${status} ${reason}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(json)}\r\n${extra}Connection: close\r\n\r\n${json}`);
    };
    try {
      const url = new URL(req.url ?? '/', 'http://gateway.local');
      const { tenant, authIsInternal, authorised } = this.authenticate(req);
      if (!authorised) {
        return answer(401, 'Unauthorized', {
          error: 'authentication required',
          detail: 'Present the gateway token as X-Llm-Fw-Key or Authorization: Bearer.',
        }, 'WWW-Authenticate: Bearer realm="llm-fw gateway"\r\n');
      }
      const route = resolveRoute(url.pathname, {
        defaultProvider: this.config.gateway?.defaultProvider ?? 'openai',
        providers: this.providers,
      });
      if (!route) return answer(404, 'Not Found', { error: 'no route for path' });
      const protocol = realtimeProtocolFor(route.upstreamPath);
      if (!protocol) return answer(501, 'Not Implemented', { error: 'websocket not inspectable', detail: WS_NOT_INSPECTABLE });

      if (tenant) {
        if (!this.tenants.allowsProvider(tenant, route.slug)) {
          return answer(403, 'Forbidden', {
            error: 'provider not permitted for this tenant', tenant: tenant.id, provider: route.slug, allowed: tenant.providers,
          });
        }
        const quota = this.tenants.charge(tenant, Date.now());
        if (!quota.allowed) {
          this.eventBus.emit({
            stage: 'dos', score: 0, similarity: 0, target: route.provider.host, method: 'WS', path: route.upstreamPath,
            payload_preview: `tenant quota exceeded: ${quota.used}/${quota.limit} per minute`,
            payload_full: `tenant ${tenant.id} exceeded ${quota.limit} requests/minute`,
            action: 'blocked', kind: 'dos', dosReason: 'tenant-quota', tenant: tenant.id,
          });
          return answer(429, 'Too Many Requests', {
            error: 'tenant quota exceeded', tenant: tenant.id, limit_per_minute: quota.limit, retry_after_seconds: quota.retryAfterSeconds,
          }, `Retry-After: ${quota.retryAfterSeconds}\r\n`);
        }
      }

      const requestHead = this.upgradeRequestHead(req, route, url.search, authIsInternal);
      const plain = route.provider.protocol === 'http';
      const port = route.provider.port ?? (plain ? 80 : 443);
      const upstream = plain
        ? net.connect({ host: route.provider.host, port })
        : tls.connect({ host: route.provider.host, port, servername: route.provider.host });
      relayRealtimeSession(
        { config: this.config, pipeline: this.pipeline, dlp: this.dlp, eventBus: this.eventBus, dashboardUrl: () => this.dashboardUrl() },
        {
          protocol, target: route.provider.host, path: route.upstreamPath,
          sessionKey: (req.socket.remoteAddress ?? 'unknown').replace(/^::ffff:/, ''),
          tenant: tenant ? { id: tenant.id, enforcement: tenant.enforcement } : undefined,
        },
        { client, head, upstream, readyEvent: plain ? 'connect' : 'secureConnect', requestHead },
      );
    } catch (err) {
      log.error(`upgrade ${req.url} — ${(err as Error)?.message ?? String(err)}`);
      answer(502, 'Bad Gateway', { error: 'gateway error' });
    }
  }

  /** The upstream handshake, with key custody applied as forward() applies it to a request. */
  private upgradeRequestHead(req: http.IncomingMessage, route: GatewayRoute, rawQuery: string, authIsInternal: boolean): string {
    const operatorKey = this.apiKeys[route.slug];
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined || name === 'x-llm-fw-key' || WS_SKIPPED_HEADERS.has(name)) continue;
      headers[name] = Array.isArray(value) ? value.join(', ') : value;
    }
    if (authIsInternal) delete headers['authorization'];
    const outbound = applyUpstreamAuth(headers, route, operatorKey);
    // A browser cannot set headers, so OpenAI takes its key as a subprotocol.
    // Under custody that is a caller credential like any other, and goes.
    if (operatorKey && outbound['sec-websocket-protocol']) {
      const kept = outbound['sec-websocket-protocol'].split(',').map(p => p.trim())
        .filter(p => p && !p.startsWith('openai-insecure-api-key.'));
      if (kept.length) outbound['sec-websocket-protocol'] = kept.join(', ');
      else delete outbound['sec-websocket-protocol'];
    }
    const query = operatorKey ? stripCredentialQuery(rawQuery) : rawQuery;
    const lines = [`GET ${route.upstreamPath}${query} HTTP/1.1`, `host: ${upstreamHostHeader(route.provider)}`];
    for (const [k, v] of Object.entries(outbound)) lines.push(`${k}: ${v}`);
    return lines.join('\r\n') + '\r\n\r\n';
  }

  /** Buffer the request body under the configured cap. Null means answered. */
  private readBody(req: http.IncomingMessage, res: http.ServerResponse): Promise<Buffer | null> {
    const cap = this.config.proxy.maxBodyBytes;
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let size = 0;
      // Latch. Draining means more 'data' events arrive AFTER the refusal, and
      // without this every one of them re-entered the branch below and called
      // setHeader on a response already sent, which throws.
      let refused = false;
      req.on('data', (chunk: Buffer) => {
        if (refused) return;
        size += chunk.length;
        if (size > cap) {
          refused = true;
          // Announce the close, answer, and only then tear down. Destroying the
          // request socket the instant the 413 was written could cut the answer
          // off before it flushed, and on a keep-alive client it poisoned the
          // pooled socket: the NEXT, unrelated request on that connection failed
          // with ECONNRESET instead of being served. `Connection: close` tells
          // the client not to reuse it, and pausing stops us reading the rest of
          // the upload without killing the response in flight.
          this.json(res, 413, { error: 'request body too large', limit_bytes: cap });
          // Drain the rest and keep the connection. Two earlier attempts failed
          // for the same underlying reason: the client is still uploading when
          // we refuse, so anything that ends the socket early resets it before
          // it can read the answer, and it sees a transport error instead of
          // the 413 this is documented to return. Pausing and destroying did
          // that; so did `Connection: close`, because Node closes the socket
          // once the response is written no matter how patiently we drain.
          //
          // So: read and discard, and let the connection live. The client
          // finishes its write, reads the status, and the socket stays usable.
          // Nothing is buffered, so the memory bound the cap exists for is
          // intact, and the timer bounds the other half of that same DoS: an
          // upload that never ends.
          req.resume();
          const cutoff = setTimeout(() => req.destroy(), GatewayServer.DRAIN_TIMEOUT_MS);
          cutoff.unref();
          const stopDraining = (): void => { clearTimeout(cutoff); };
          req.once('end', stopDraining);
          req.once('error', stopDraining);
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

    const moduleCtx = this.moduleContext(req, route, tenant);
    if (moduleCtx) {
      const modRes = await this.modules.transformRequest(text, { ...moduleCtx, dryRun: observing });
      if (modRes.modified && !observing) {
        text = modRes.body;
        bodyBuf = Buffer.from(text, 'utf-8');
      }
      if (modRes.events && modRes.events.length > 0) {
        for (const ev of modRes.events) {
          this.eventBus.emitModuleEvent(ev);
        }
      }
    }

    // DLP — same scoping as the proxy: only requests a parser recognises, so
    // binary uploads are not scanned as if they were prompts.
    if (this.config.dlp.enabled && getParser(path) !== null) {
      const findings = this.dlp.scan(text);
      const firstFinding = findings[0];
      if (firstFinding) {
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
          kind: 'dlp', dlpType: firstFinding.type,
          ...observedTag, ...tenantTag,
        });
        if (mode === 'block') {
          return {
            blocked: true, status: this.config.blockStatus ?? 422,
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
      log.error(`pipeline error on ${method} ${path}: ${message}`);
      if (failOpen) return { blocked: false, body: bodyBuf };
      return {
        blocked: true, status: this.config.blockStatus ?? 422,
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
        blocked: true, status: this.config.blockStatus ?? 422,
        body: explainBlock({ eventId, result, dashboardUrl }),
      };
    }

    return { blocked: false, body: bodyBuf };
  }

  /** What the module pipeline sees of a request; null when modules do not run on it. */
  private moduleContext(req: http.IncomingMessage, route: GatewayRoute, tenant: Tenant | null): GatewayModuleContext | null {
    const parser = getParser(route.upstreamPath);
    if (!this.config.modules?.enabled || parser === null) return null;
    return {
      target: route.provider.host,
      method: req.method ?? 'POST',
      path: route.upstreamPath,
      isLlmRequest: true,
      parser,
      sessionKey: (req.socket.remoteAddress ?? 'unknown').replace(/^::ffff:/, ''),
      tenant: tenant?.id,
    };
  }

  /** Dashboard base URL for block remediation hints, when it is reachable. */
  private dashboardUrl(): string | undefined {
    const d = this.config.dashboard;
    if (!d) return undefined;
    const host = d.bindHost && d.bindHost !== '0.0.0.0' ? d.bindHost : '127.0.0.1';
    return `http://${host}:${d.port}`;
  }

  /**
   * How long to keep discarding a body we have already refused, so the
   * client can finish writing and read the 413 rather than being reset.
   */
  private static readonly DRAIN_TIMEOUT_MS = 10_000;

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
    headers['host'] = upstreamHostHeader(route.provider);
    if (body.length) headers['content-length'] = String(body.length);
    // Drop the internal credential before it can leave the building. Only when
    // the gateway actually consumed this header itself: a client that
    // authenticated with X-Llm-Fw-Key and sent its OWN provider key in
    // Authorization still needs that key forwarded in custody-off mode.
    if (authIsInternal) delete headers['authorization'];

    const operatorKey = this.apiKeys[route.slug];
    const outbound = applyUpstreamAuth(headers, route, operatorKey);

    // Custody has to cover the URL as well as the headers. Google documents its
    // credential as `?key=`, Azure OpenAI accepts `?api-key=`: a caller who put
    // their own key there reached the provider on it, with the operator's key
    // sitting unused in a header beside it. Only when the operator actually
    // holds the key — with custody off, the client's own credential is exactly
    // what should be forwarded, in the URL as in the header.
    const rawQuery = req.url?.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    const query = (operatorKey && !isAuthPath(route.upstreamPath)) ? stripCredentialQuery(rawQuery) : rawQuery;

    const transport = route.provider.protocol === 'http' ? http : https;
    const port = route.provider.port ?? (route.provider.protocol === 'http' ? 80 : 443);

    await new Promise<void>((resolve) => {
      const upstream = transport.request(
        {
          host: route.provider.host,
          port,
          method: req.method,
          path: route.upstreamPath + query,
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
        log.error(`upstream ${route.provider.host} — ${err.message}`);
        this.json(res, 502, { error: 'upstream request failed', upstream: route.provider.host });
        resolve();
      });
      if (body.length) upstream.write(body);
      upstream.end();
    });
  }
}

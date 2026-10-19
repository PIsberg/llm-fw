import type { PayloadParser, ModuleEvent } from '../types.js'
import type { CapturedResponse } from './responseTap.js'

export interface GatewayModuleContext {
  target: string;
  method: string;
  path: string;
  isLlmRequest: boolean;
  parser: PayloadParser | null;
  sessionKey?: string | undefined;
  tenant?: string | undefined;
  /** Observe mode: the caller forwards the original body whatever the module
   *  returns, so any event it emits should say the change was not applied. */
  dryRun?: boolean | undefined;
  /** The client's request headers, for modules that key on credentials. */
  headers?: Record<string, string | string[] | undefined> | undefined;
  /** The URL as the client sent it, query included: a credential can ride in `?key=`. */
  url?: string | undefined;
}

/** A response a module serves in place of the provider's. */
export interface ModuleResponse {
  response: CapturedResponse;
  events?: ModuleEvent[];
}

export interface ModuleTransformResult {
  body: string;
  modified: boolean;
  metadata?: Record<string, unknown>;
  events?: ModuleEvent[];
  /**
   * Request headers to set on the upstream call, lower-case names, each
   * value replacing the client's. The proxy and the gateway apply them with
   * the body; under observe mode neither is applied. A module that appends
   * to a header (a beta list) builds the whole value from `ctx.headers`.
   */
  headers?: Record<string, string>;
}

export interface ModuleStats {
  id: string;
  name: string;
  enabled: boolean;
  totalInvocations: number;
  tokensOriginal: number;
  tokensPruned: number;
  tokensSaved: number;
  percentSaved: number;
  recentEvents: ModuleEvent[];
  /** Replaces the default savings KPIs on the module's dashboard card. */
  kpis?: Array<{ key: string; label: string; value: number | string }>;
  /** One line of text under the KPIs, for findings a number cannot carry. */
  detail?: string;
}

export interface GatewayModule {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  enabled: boolean;

  /** Transform request body prior to upstream dispatch. */
  transformRequest(
    body: string,
    ctx: GatewayModuleContext
  ): Promise<ModuleTransformResult> | ModuleTransformResult;

  /**
   * See the complete response to a request the pipeline forwarded, as the
   * client received it. `requestBody` is the body that went upstream. Not
   * called when the response was larger than the capture cap.
   */
  observeResponse?(requestBody: string, ctx: GatewayModuleContext, response: CapturedResponse): void;

  /**
   * Answer the request without contacting the provider. Asked after
   * detection has passed the request, with the body that would go upstream;
   * undefined means forward it.
   */
  respond?(requestBody: string, ctx: GatewayModuleContext): ModuleResponse | undefined;

  /** Return live statistics for dashboard telemetry. */
  getStats(): ModuleStats;

  /** Reset in-memory statistics. */
  resetStats?(): void;
}

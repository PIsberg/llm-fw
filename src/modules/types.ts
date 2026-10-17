import type { PayloadParser, ModuleEvent } from '../types.js'
import type { CapturedResponse } from './responseTap.js'
import type { Screening } from './screening.js'

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
  /** What detection and DLP made of this request, for a module that runs after them. */
  screening?: Screening | undefined;
  /** The caller's socket address, for a module that must know the caller is local. */
  remoteAddress?: string | undefined;
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
}

export interface GatewayModule {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  enabled: boolean;

  /**
   * Runs in `ModuleManager.transformScreened`, after detection and DLP, and
   * not in `transformRequest`.
   */
  readonly afterScreening?: boolean;

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

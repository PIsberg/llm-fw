import type { PayloadParser, ModuleEvent } from '../types.js'

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

  /** Return live statistics for dashboard telemetry. */
  getStats(): ModuleStats;

  /** Reset in-memory statistics. */
  resetStats?(): void;
}

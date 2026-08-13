import { PipelineResult } from '../types.js';
import { RULESET_VERSION } from './ruleset.js';

/**
 * The body returned to a client whose request was blocked.
 *
 * "Request blocked" with no further detail is the single fastest way to lose a
 * developer's trust: the agent breaks, the developer cannot tell whether it was
 * a real attack or a false positive, and the cheapest fix available to them is
 * to turn the firewall off. Every block therefore states which stage fired,
 * what it matched, which ruleset version decided it, and the exact command that
 * suppresses it if the operator judges it wrong.
 *
 * The matched evidence is deliberately bounded and never echoes the whole
 * prompt back: the caller already has their own request, and a verbose echo
 * would put user content into logs at every hop.
 */
export interface BlockExplanation {
  error: string;
  /** Stable id, also carried on the dashboard event, for support conversations. */
  event_id: string;
  /** Which detection stage produced the verdict. */
  stage: string;
  /** Which class of check: prompt injection, DLP, quota, and so on. */
  kind: string;
  ruleset: string;
  score?: number;
  similarity?: number;
  /** Rule identifiers or matched phrases, capped. */
  matched?: string[];
  /** What the operator should do if this is a false positive. */
  remediation: string;
  docs: string;
}

const DOCS_URL = 'https://github.com/PIsberg/llm-fw#false-positive-suppression-list';

/** Longest single matched fragment echoed back. */
const MATCH_CAP = 120;
/** Most matched fragments echoed back. */
const MATCH_LIMIT = 5;

/**
 * The false-positive escape hatch, named exactly. Suppression is applied by
 * marking the event on the dashboard Events tab (POST /api/feedback, which is
 * same-origin guarded and so is not a curl-from-anywhere instruction).
 */
function remediationFor(eventId: string, dashboardUrl?: string): string {
  const where = dashboardUrl ? `${dashboardUrl}/#events` : 'the llm-fw dashboard Events tab';
  return `If this is a false positive, open ${where}, find event ${eventId}, and mark it "not an attack" — future requests with this text pass.`;
}

function trimMatches(matches: string[] | undefined): string[] | undefined {
  if (!matches?.length) return undefined;
  return matches.slice(0, MATCH_LIMIT).map(m => (m.length > MATCH_CAP ? m.slice(0, MATCH_CAP) + '…' : m));
}

/**
 * Build the block body for a detection-pipeline verdict.
 *
 * `eventId` must be the id of the event emitted for this same block, so that
 * pasting it into the dashboard finds the record the client was shown.
 */
export function explainBlock(opts: {
  eventId: string;
  result: PipelineResult;
  kind?: string;
  /** Base URL of this deployment's dashboard, so the hint is clickable. */
  dashboardUrl?: string;
}): BlockExplanation {
  const { eventId, result } = opts;
  return {
    error: 'prompt injection detected',
    event_id: eventId,
    stage: result.stage,
    kind: opts.kind ?? 'prompt',
    ruleset: RULESET_VERSION,
    score: result.score,
    similarity: result.similarity,
    matched: trimMatches(result.heuristicMatches ?? (result.nearestTemplate ? [result.nearestTemplate] : undefined)),
    remediation: remediationFor(eventId, opts.dashboardUrl),
    docs: DOCS_URL,
  };
}

/**
 * Build the block body for the non-pipeline gates (DLP, quota, taint, URL
 * filter). These have no PipelineResult, only a reason.
 */
export function explainGate(opts: {
  eventId: string;
  error: string;
  stage: string;
  kind: string;
  detail?: string;
  remediation?: string;
  dashboardUrl?: string;
}): BlockExplanation {
  return {
    error: opts.error,
    event_id: opts.eventId,
    stage: opts.stage,
    kind: opts.kind,
    ruleset: RULESET_VERSION,
    matched: opts.detail ? trimMatches([opts.detail]) : undefined,
    remediation: opts.remediation ?? remediationFor(opts.eventId, opts.dashboardUrl),
    docs: DOCS_URL,
  };
}

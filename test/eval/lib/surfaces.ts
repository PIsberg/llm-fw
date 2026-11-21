/**
 * Build the request body for an evaluation row, delivering it on the surface it
 * would really arrive on.
 *
 * Shared by the benchmark runner and the false-positive gate because they were
 * measuring the SAME corpus and disagreeing about it: the benchmark reported
 * 14.79% FPR on the benign set while the gate reported 13.38%. The gate was
 * right — the benchmark had no case for `system` or `tool_definition` and fed
 * those rows in as user messages, which the pipeline treats as untrusted and
 * scans in full. Production never takes that path, so the extra two blocks were
 * an artefact of the harness.
 *
 * Two numbers for one corpus is worse than either number alone, so there is now
 * one builder rather than two that can drift.
 */
export type EvalSurface = 'prompt' | 'tool_result' | 'system' | 'tool_definition';

export interface EvalRow {
  text: string;
  label: number;
  class?: string;
  surface?: EvalSurface;
  /**
   * A conversation's user turns, oldest first (the multi-turn splits, #540).
   * Delivered as one request holding the whole conversation, the way an LLM
   * API client resends it each turn, with ASSISTANT_PLACEHOLDER between the
   * turns. `text` is then the turns joined, for tools that print or hash a row.
   */
  turns?: string[];
}

/**
 * The reply put between the user turns of a multi-turn row. The datasets hold
 * no replies (tom-gibbs stores None, SafeMTData only the queries), and real
 * oasst1 replies would reach the benign rows only, so every row gets the same
 * short one.
 */
export const ASSISTANT_PLACEHOLDER = 'OK.';

/** Anthropic Messages request placing `row.text` on its declared surface. */
export function anthropicRequestFor(row: EvalRow, toolUseId = 'toolu_eval'): string {
  const base = { model: 'claude-3-haiku-20240307', max_tokens: 1 };
  switch (row.surface) {
    case 'system':
      // Developer-authored, and trusted by default (detection.scanSystemPrompt).
      return JSON.stringify({ ...base, system: row.text, messages: [{ role: 'user', content: 'Please continue.' }] });
    case 'tool_definition': {
      // Arrives in `tools`, which skips the fuzzy embedding stage. A row that
      // is not valid JSON would be a corpus error, so fall back rather than
      // throw mid-run.
      try {
        const tool = JSON.parse(row.text) as Record<string, unknown>;
        return JSON.stringify({ ...base, tools: [tool], messages: [{ role: 'user', content: 'Which tool should I use?' }] });
      } catch {
        return JSON.stringify({ ...base, messages: [{ role: 'user', content: row.text }] });
      }
    }
    case 'tool_result':
      return JSON.stringify({ ...base, messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: row.text }] }] });
    default:
      if (row.turns && row.turns.length > 0) {
        const messages = row.turns.flatMap((content, i) => [
          ...(i > 0 ? [{ role: 'assistant', content: ASSISTANT_PLACEHOLDER }] : []),
          { role: 'user', content },
        ]);
        return JSON.stringify({ ...base, messages });
      }
      return JSON.stringify({ ...base, messages: [{ role: 'user', content: row.text }] });
  }
}

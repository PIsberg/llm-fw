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
}

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
      return JSON.stringify({ ...base, messages: [{ role: 'user', content: row.text }] });
  }
}

// The error event that ends a stream the proxy cut (#573).
//
// The exfil hold (#551) and the system-prompt canary (#539) stop a streamed
// response part way. A connection reset there reads as a network fault:
// Claude Code retried it 4 to 13 times live, asking the model to resume, and
// each retry re-ran the model into the same cut. Ending the stream with the
// provider's own error event instead reports it as an API error, with a
// message that says llm-fw cut it and why.
//
// A protocol with no in-stream error event (Gemini) gets null, and the
// caller resets as before.

/** The SSE event that reports `message` as an error on `path`'s API; null when it has none. */
export function streamErrorEvent(path: string, message: string): string | null {
  const p = path.split('?')[0] ?? ''
  if (p === '/v1/messages') {
    return `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message } })}\n\n`
  }
  if (p.endsWith('/responses')) {
    const response = { id: 'resp_llmfw_cut', object: 'response', status: 'failed', error: { code: 'llm_fw_blocked', message } }
    return `event: response.failed\ndata: ${JSON.stringify({ type: 'response.failed', response })}\n\n`
  }
  if (p.endsWith('/chat/completions') || p.endsWith('/completions')) {
    return `data: ${JSON.stringify({ error: { message, type: 'invalid_request_error', code: 'llm_fw_blocked', param: null } })}\n\n`
  }
  return null
}

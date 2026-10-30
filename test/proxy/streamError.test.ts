import { describe, it, expect } from 'vitest'
import { streamErrorEvent } from '../../src/proxy/streamError.js'

// #573: a stream the proxy cuts (the exfil hold, the canary) used to end in a
// connection reset, which Claude Code retried 4 to 13 times as a lost
// connection, re-running the model each time. The stream now ends with the
// provider's own error event, which the client reports instead.

const MSG = 'llm-fw cut this response: it carried an exfil URL'

function data(event: string): unknown {
  const line = event.split('\n').find(l => l.startsWith('data:'))
  return JSON.parse(line!.slice(5))
}

describe('streamErrorEvent', () => {
  it('writes an Anthropic error event for the Messages API', () => {
    const ev = streamErrorEvent('/v1/messages?beta=true', MSG)!
    expect(ev.startsWith('event: error\n')).toBe(true)
    expect(ev.endsWith('\n\n')).toBe(true)
    expect(data(ev)).toEqual({ type: 'error', error: { type: 'invalid_request_error', message: MSG } })
  })

  it('writes an OpenAI error chunk for Chat Completions', () => {
    const ev = streamErrorEvent('/v1/chat/completions', MSG)!
    expect(ev.endsWith('\n\n')).toBe(true)
    expect(data(ev)).toEqual({ error: { message: MSG, type: 'invalid_request_error', code: 'llm_fw_blocked', param: null } })
  })

  it('writes a response.failed event for the Responses API and the ChatGPT Codex route', () => {
    for (const path of ['/v1/responses', '/backend-api/codex/responses']) {
      const ev = streamErrorEvent(path, MSG)!
      expect(ev.startsWith('event: response.failed\n')).toBe(true)
      expect(data(ev)).toMatchObject({ type: 'response.failed', response: { status: 'failed', error: { code: 'llm_fw_blocked', message: MSG } } })
    }
  })

  it('has nothing for a protocol without an error event', () => {
    expect(streamErrorEvent('/v1beta/models/gemini-2.5-pro:streamGenerateContent', MSG)).toBeNull()
    expect(streamErrorEvent('/unknown', MSG)).toBeNull()
  })
})

import { describe, it, expect } from 'vitest'
import { TokenPrunerModule, pruneText, estimateTokens } from '../../src/modules/builtin/tokenPruner.js'
import type { GatewayModuleContext } from '../../src/modules/types.js'

describe('pruneText — natural language prose', () => {
  it('collapses multiple horizontal spaces and tabs into a single space', () => {
    const input = 'This   is    a   test \t with   tabs   and   spaces.'
    const expected = 'This is a test with tabs and spaces.'
    expect(pruneText(input)).toBe(expected)
  })

  it('collapses 3 or more consecutive newlines into exactly 2 newlines', () => {
    const input = 'Paragraph 1\n\n\n\n\nParagraph 2\r\n\r\n\r\n\r\nParagraph 3'
    const expected = 'Paragraph 1\n\nParagraph 2\n\nParagraph 3'
    expect(pruneText(input)).toBe(expected)
  })

  it('preserves single and double newlines as paragraph boundaries', () => {
    const input = 'Line 1\nLine 2\n\nParagraph 2'
    expect(pruneText(input)).toBe('Line 1\nLine 2\n\nParagraph 2')
  })

  it('trims trailing whitespace on each line', () => {
    const input = 'Line 1   \nLine 2 \t  \nLine 3'
    expect(pruneText(input)).toBe('Line 1\nLine 2\nLine 3')
  })

  it('trims outer leading and trailing whitespace of the overall string', () => {
    const input = '   \n\nHello world\n\n   '
    expect(pruneText(input)).toBe('Hello world')
  })
})

describe('pruneText — code block preservation', () => {
  it('preserves indentation inside Python code fences', () => {
    const input = `Here is the function:

\`\`\`python
def calculate_total(items):
    total = 0
    for item in items:
        if item.is_valid:
            total += item.price
    return total
\`\`\`

Please review.`

    const output = pruneText(input)
    expect(output).toContain('    total = 0')
    expect(output).toContain('        if item.is_valid:')
    expect(output).toContain('            total += item.price')
  })

  it('preserves indentation inside YAML code fences', () => {
    const input = `Configuration:
\`\`\`yaml
server:
  host: 0.0.0.0
  port: 8080
  services:
    - name: api
      timeout: 30s
\`\`\``

    const output = pruneText(input)
    expect(output).toContain('  host: 0.0.0.0')
    expect(output).toContain('    - name: api')
  })

  it('preserves unlabelled code fences defensively', () => {
    const input = `Code:
\`\`\`
  indented line 1
    indented line 2
\`\`\``

    const output = pruneText(input)
    expect(output).toContain('  indented line 1\n    indented line 2')
  })

  it('prunes text outside code fences while keeping inside code intact', () => {
    const input = `Explain   this    code:  \n\n\n\`\`\`python\ndef foo():\n    return 42\n\`\`\`\n\n\nThanks   a   lot!`
    const expected = `Explain this code:\n\n\`\`\`python\ndef foo():\n    return 42\n\`\`\`\n\nThanks a lot!`
    expect(pruneText(input)).toBe(expected)
  })
})

describe('pruneText — embedded JSON minification', () => {
  it('minifies multiline embedded JSON objects in prose', () => {
    const input = `Here is the user record:
{
  "name": "Alice",
  "age": 30,
  "roles": [
    "admin",
    "developer"
  ]
}
Please check authorization.`

    const output = pruneText(input)
    expect(output).toContain('{"name":"Alice","age":30,"roles":["admin","developer"]}')
    expect(output).toContain('Here is the user record:')
    expect(output).toContain('Please check authorization.')
  })

  it('keeps every number and string byte for byte', () => {
    // Parse-and-print rounded the id to 12345678901234567000 and turned
    // 1.50 into 1.5, so the model saw a different record than the user sent.
    const input = 'Order:\n{\n  "id": 12345678901234567890,\n  "total": 1.50,\n  "note": "a  b"\n}\nWhy was it refunded?'
    expect(pruneText(input)).toContain('{"id":12345678901234567890,"total":1.50,"note":"a  b"}')
  })
})

describe('TokenPrunerModule — payload transformation', () => {
  const dummyCtx: GatewayModuleContext = {
    target: 'api.openai.com',
    method: 'POST',
    path: '/v1/chat/completions',
    isLlmRequest: true,
    parser: null,
  }

  it('transforms standard OpenAI messages payload and calculates tokens saved', () => {
    const module = new TokenPrunerModule({ enabled: true })
    const body = JSON.stringify({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'You   are   a   helpful    assistant.' },
        { role: 'user', content: 'Hello       there,    how   are   you?' },
      ],
    })

    const res = module.transformRequest(body, dummyCtx)
    expect(res.modified).toBe(true)

    const parsed = JSON.parse(res.body)
    expect(parsed.messages[0].content).toBe('You are a helpful assistant.')
    expect(parsed.messages[1].content).toBe('Hello there, how are you?')

    const stats = module.getStats()
    expect(stats.totalInvocations).toBe(1)
    expect(stats.tokensSaved).toBeGreaterThan(0)
    expect(stats.percentSaved).toBeGreaterThan(0)
  })

  it('transforms Anthropic messages and system prompt payload', () => {
    const module = new TokenPrunerModule({ enabled: true })
    const body = JSON.stringify({
      model: 'claude-3-5-sonnet-20241022',
      system: 'Instructions    with    lots   of   space.',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Text    block    one.' },
            { type: 'text', text: 'Text    block    two.' },
          ],
        },
      ],
    })

    const res = module.transformRequest(body, dummyCtx)
    expect(res.modified).toBe(true)

    const parsed = JSON.parse(res.body)
    expect(parsed.system).toBe('Instructions with lots of space.')
    expect(parsed.messages[0].content[0].text).toBe('Text block one.')
    expect(parsed.messages[0].content[1].text).toBe('Text block two.')
  })

  it('transforms Gemini contents parts payload', () => {
    const module = new TokenPrunerModule({ enabled: true })
    const body = JSON.stringify({
      contents: [
        {
          role: 'user',
          parts: [{ text: 'Question    with   extra   spaces.' }],
        },
      ],
    })

    const res = module.transformRequest(body, dummyCtx)
    expect(res.modified).toBe(true)

    const parsed = JSON.parse(res.body)
    expect(parsed.contents[0].parts[0].text).toBe('Question with extra spaces.')
  })

  it('does not modify already optimized payloads and reports 0 tokens saved', () => {
    const module = new TokenPrunerModule({ enabled: true })
    const body = JSON.stringify({
      messages: [{ role: 'user', content: 'Clean prompt with no extra spaces.' }],
    })

    const res = module.transformRequest(body, dummyCtx)
    expect(res.modified).toBe(false)
    expect(res.body).toBe(body)
  })

  it('passes non-JSON or unparseable payloads through safely', () => {
    const module = new TokenPrunerModule({ enabled: true })
    const raw = 'not-valid-json'
    const res = module.transformRequest(raw, dummyCtx)
    expect(res.modified).toBe(false)
    expect(res.body).toBe(raw)
  })
})

// Review findings on the first cut of the pruner. Each case below was red
// before the fix: the pruner rewrote content a reader depends on, or reported
// savings the upstream never saw.
describe('pruneText — leading indentation outside code fences', () => {
  it('keeps the indentation of a nested markdown list', () => {
    const input = '- parent\n  - child\n    - grandchild'
    expect(pruneText(input)).toBe(input)
  })

  it('keeps the indentation of unfenced Python pasted into a prompt', () => {
    const input = 'Why does this fail?\ndef f(x):\n    if x:\n        return  1'
    // Interior runs collapse; the indentation that carries meaning stays.
    expect(pruneText(input)).toBe('Why does this fail?\ndef f(x):\n    if x:\n        return 1')
  })

  it('keeps the indentation of the line after a collapsed run of blank lines', () => {
    const input = 'intro\n\n\n\n    indented after the gap'
    expect(pruneText(input)).toBe('intro\n\n    indented after the gap')
  })
})

describe('pruneText — bounded cost on adversarial input', () => {
  it('handles many unclosed brace lines without quadratic rescans', () => {
    // 80k lines that each open a JSON candidate. The first cut's lazy regex
    // rescanned to the end of the text from every one of them: measured 92,
    // 363 and 1440 ms at 40, 80 and 160 KB, all on the event loop.
    const input = '{\n'.repeat(80_000) + 'tail'
    const t0 = performance.now()
    pruneText(input)
    expect(performance.now() - t0).toBeLessThan(300)
  })

  it('trims fenced code lines without rescanning an interior run of spaces', () => {
    // /[^\S\r\n]+$/ restarted at every space of a run that does not reach
    // the end of the line: 1,109 ms for one 40,000-space run.
    const input = '```\nx' + ' '.repeat(40_000) + 'y  \n```'
    const t0 = performance.now()
    expect(pruneText(input)).toBe('```\nx' + ' '.repeat(40_000) + 'y\n```')
    expect(performance.now() - t0).toBeLessThan(100)
  })
})

describe('TokenPrunerModule — savings are measured on prompt text', () => {
  const ctx: GatewayModuleContext = {
    target: 'api.openai.com', method: 'POST', path: '/v1/chat/completions', isLlmRequest: true, parser: null,
  }

  it('does not count JSON re-serialisation of the envelope as tokens saved', () => {
    const module = new TokenPrunerModule({ enabled: true })
    // Pretty-printed envelope: JSON formatting the model never sees as prompt
    // tokens. Only the run of spaces inside the content is a real saving.
    const content = 'a' + ' '.repeat(41) + 'b'
    const body = JSON.stringify({ model: 'gpt-4o', temperature: 0, messages: [{ role: 'user', content }] }, null, 8)
    const res = module.transformRequest(body, ctx)
    expect(res.modified).toBe(true)
    expect(res.events?.[0]?.tokensOriginal).toBe(estimateTokens(content))
    expect(res.events?.[0]?.tokensSaved).toBe(estimateTokens(content) - estimateTokens('a b'))
  })
})

describe('TokenPrunerModule — running totals cover every examined request', () => {
  const ctx: GatewayModuleContext = {
    target: 'api.anthropic.com', method: 'POST', path: '/v1/messages', isLlmRequest: true, parser: null,
  }

  it('counts a request with nothing to prune in the denominator', () => {
    // Found live: a real Claude Code session had 5 tokens to prune in 16,811,
    // but requests with nothing to prune were left out of the totals, so the
    // percentage described only the requests that happened to shrink.
    const module = new TokenPrunerModule({ enabled: true })
    const clean = 'x'.repeat(400)
    const spaced = 'a' + ' '.repeat(41) + 'b. Some more text after the run.'
    module.transformRequest(JSON.stringify({ messages: [{ role: 'user', content: clean }] }), ctx)
    module.transformRequest(JSON.stringify({ messages: [{ role: 'user', content: spaced }] }), ctx)

    const stats = module.getStats()
    expect(stats.totalInvocations).toBe(2)
    expect(stats.tokensOriginal).toBe(estimateTokens(clean) + estimateTokens(spaced))
    expect(stats.tokensSaved).toBe(estimateTokens(spaced) - estimateTokens(pruneText(spaced)))
    expect(stats.tokensSaved).toBeGreaterThan(0)
  })
})

describe('TokenPrunerModule — enabled state is the live config', () => {
  const ctx: GatewayModuleContext = {
    target: 'api.openai.com', method: 'POST', path: '/v1/chat/completions', isLlmRequest: true, parser: null,
  }
  const body = JSON.stringify({ messages: [{ role: 'user', content: 'a    b' }] })

  it('follows a change to the config object it was built from (hot reload writes leaves in place)', () => {
    const cfg = { enabled: false }
    const module = new TokenPrunerModule(cfg)
    expect(module.transformRequest(body, ctx).modified).toBe(false)
    cfg.enabled = true
    expect(module.transformRequest(body, ctx).modified).toBe(true)
  })

  it('writes a toggle through to the config object, so persistence sees it', () => {
    const cfg = { enabled: true }
    const module = new TokenPrunerModule(cfg)
    module.enabled = false
    expect(cfg.enabled).toBe(false)
  })
})

describe('TokenPrunerModule — scope', () => {
  const ctx: GatewayModuleContext = {
    target: 'api.openai.com', method: 'POST', path: '/v1/chat/completions', isLlmRequest: true, parser: null,
  }

  it('leaves tool output alone: an agent copies exact whitespace from a file read into its next edit', () => {
    // Collapsing the run after a line-number tab turned "  12\t    x  = 1"
    // into "12 x = 1", so an Edit whose old_string quoted it never matched.
    const module = new TokenPrunerModule({ enabled: true })
    const fileRead = '    12\t    x  = 1\n    13\t        return  x'
    const body = JSON.stringify({
      messages: [
        { role: 'tool', tool_call_id: 'c1', content: fileRead },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: fileRead }] },
      ],
    })
    const res = module.transformRequest(body, ctx)
    expect(res.modified).toBe(false)
    expect(module.getStats().totalInvocations).toBe(0)
  })

  it('prunes OpenAI Responses API input and instructions', () => {
    const module = new TokenPrunerModule({ enabled: true })
    const body = JSON.stringify({
      instructions: 'Be    brief.',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'Hello     there' }] }],
    })
    const parsed = JSON.parse(module.transformRequest(body, { ...ctx, path: '/v1/responses' }).body)
    expect(parsed.instructions).toBe('Be brief.')
    expect(parsed.input[0].content[0].text).toBe('Hello there')
  })
})

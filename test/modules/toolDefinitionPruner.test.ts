import { describe, it, expect } from 'vitest'
import { ToolDefinitionPrunerModule } from '../../src/modules/builtin/toolDefinitionPruner.js'
import type { GatewayModuleContext } from '../../src/modules/types.js'

const ctx: GatewayModuleContext = { target: 'api.anthropic.com', method: 'POST', path: '/v1/messages', isLlmRequest: true, parser: null }

describe('ToolDefinitionPrunerModule', () => {
  const body = JSON.stringify({
    tools: [{
      name: 'run_query',
      description: 'Runs a query.\n\n\n\n    Use it   when   the user asks for data.   ',
      input_schema: {
        type: 'object',
        properties: {
          sql: { type: 'string', description: 'The   SQL   to run.  ' },
          mode: { type: 'string', enum: ['read  only', 'write'] },
        },
        required: ['sql'],
      },
    }],
    messages: [{ role: 'user', content: 'leave    me' }],
  })

  it('prunes tool and parameter descriptions and nothing else', () => {
    const res = new ToolDefinitionPrunerModule({ enabled: true }).transformRequest(body, ctx)
    expect(res.modified).toBe(true)
    const parsed = JSON.parse(res.body)
    const tool = parsed.tools[0]
    expect(tool.description).toBe('Runs a query.\n\n    Use it when the user asks for data.')
    expect(tool.input_schema.properties.sql.description).toBe('The SQL to run.')
    // Names, enum values and structure are part of the contract with the tool.
    expect(tool.name).toBe('run_query')
    expect(tool.input_schema.properties.mode.enum).toEqual(['read  only', 'write'])
    expect(tool.input_schema.required).toEqual(['sql'])
    expect(parsed.messages[0].content).toBe('leave    me')
  })

  it('counts its saving on the descriptions', () => {
    const mod = new ToolDefinitionPrunerModule({ enabled: true })
    mod.transformRequest(body, ctx)
    expect(mod.getStats().tokensSaved).toBeGreaterThan(0)
  })

  it('does nothing while off', () => {
    expect(new ToolDefinitionPrunerModule({ enabled: false }).transformRequest(body, ctx).modified).toBe(false)
  })
})

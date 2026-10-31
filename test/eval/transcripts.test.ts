import { describe, it, expect } from 'vitest'
import { claudeCodeItems, codexItems, dedupe } from './lib/transcripts.js'
import { diffReplays, type ReplayRecord } from './lib/replayDiff.js'
import { getParser } from '../../src/detection/parsers.js'

const jsonl = (...records: unknown[]): string => `${records.map(r => JSON.stringify(r)).join('\n')}\n{"torn":`

const SKILL_ENVELOPE = '<command-message>speckit-clarify</command-message>\n<command-name>speckit-clarify</command-name>\n<skill-format>true</skill-format>'
const SKILL_BODY = 'Base directory for this skill: C:\\repo\\.claude\\skills\\speckit-clarify\n\n## User Input'

describe('replay items from a Claude Code transcript', () => {
  const transcript = jsonl(
    { type: 'user', message: { role: 'user', content: 'review the open PRs' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Reading.' }, { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'C:\\repo\\README.md' } }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '# README\nhello' }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: SKILL_ENVELOPE }, { type: 'text', text: SKILL_BODY }] } },
    { type: 'attachment', rendered: [{ content: '<system-reminder>\nnote\n</system-reminder>' }] },
    { type: 'summary', summary: 'not traffic' },
  )
  const items = claudeCodeItems(transcript, 'session.jsonl')
  const parser = getParser('/v1/messages')!

  it('keeps one item per user message, tool result and attachment, and skips the rest', () => {
    expect(items.map(i => i.kind)).toEqual(['prompt', 'tool_result', 'prompt', 'reminder'])
    expect(items.every(i => i.client === 'claude-code' && i.path === '/v1/messages' && i.file === 'session.jsonl')).toBe(true)
  })

  it('sends a message whole, so the parser splits its blocks as on the wire', () => {
    expect(parser.extractPrompts(items[2]!.body)).toEqual([SKILL_ENVELOPE, SKILL_BODY])
    expect(parser.extractPrompts(items[0]!.body)).toEqual(['review the open PRs'])
  })

  it('puts a tool result after the tool_use that asked for it', () => {
    const results = parser.extractToolResults(items[1]!.body)
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ toolUseId: 'toolu_1', result: '# README\nhello', toolName: 'Read' })
  })

  it('keeps identical items once, with stable keys', () => {
    const twice = dedupe([...items, ...claudeCodeItems(transcript, 'other.jsonl')])
    expect(twice.map(i => i.key)).toEqual(items.map(i => i.key))
    expect(twice[0]!.file).toBe('session.jsonl')
  })
})

describe('replay items from a Codex transcript', () => {
  const transcript = jsonl(
    { type: 'session_meta', payload: { id: 's' } },
    { type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'You are Codex.' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'list the files in src' }] } },
    { type: 'response_item', payload: { type: 'function_call', call_id: 'call_1', name: 'shell', arguments: '{"command":["ls"]}' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'call_1', output: 'a.ts\nb.ts' } },
  )
  const items = codexItems(transcript, 'rollout.jsonl')
  const parser = getParser('/v1/responses')!

  it('keeps user messages and tool outputs, not developer messages', () => {
    expect(items.map(i => [i.client, i.kind, i.path])).toEqual([['codex', 'prompt', '/v1/responses'], ['codex', 'tool_result', '/v1/responses']])
  })

  it('rebuilds requests the Responses parser reads', () => {
    expect(parser.extractPrompts(items[0]!.body)).toContain('list the files in src')
    expect(parser.extractToolResults(items[1]!.body).map(r => r.result)).toEqual(['a.ts\nb.ts'])
  })
})

describe('diffing two replays', () => {
  const rec = (key: string, action: ReplayRecord['action'], stage?: string): ReplayRecord => ({ key, client: 'claude-code', kind: 'prompt', action, stage, file: 'f' })

  it('reports items that started or stopped blocking, matched by key', () => {
    const d = diffReplays(
      [rec('a', 'block', 'classifier'), rec('b', 'pass'), rec('c', 'pass'), rec('gone', 'block', 'heuristic')],
      [rec('a', 'pass'), rec('b', 'block', 'embedding'), rec('c', 'pass'), rec('new', 'block', 'heuristic')],
    )
    expect(d.compared).toBe(3)
    expect(d.changed).toHaveLength(2)
    expect(d.unblocked.map(r => [r.key, r.stage])).toEqual([['a', 'classifier']])
    expect(d.newlyBlocked.map(r => [r.key, r.stage])).toEqual([['b', 'embedding']])
  })
})

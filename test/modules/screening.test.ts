import { describe, it, expect, afterEach, vi } from 'vitest'
import { Screening } from '../../src/modules/screening.js'
import { collectTextSlots, type TextSlot } from '../../src/modules/payload.js'
import { parsePayload } from '../../src/modules/base.js'
import type { DlpFinding } from '../../src/types.js'

// Slice S2 of the tool result shunt: the screening record, against
// specs/001-tool-result-shunt/data-model.md "Screening record" (FR-012, D1).
// A Screening is filled while detection and DLP screen a request and read by
// the module afterwards. It says which tool-result slots the module must leave
// whole: `flagged` (placed), `unreached` (a cut-short scan did not get to
// them) and `all` (the record cannot place something, so no new result is safe).

const PROMPT = 'Run the tests and tell me what failed.'
const R1 = 'RESULT-ONE: 12 tests failed in suite alpha\nstack frame a1\nstack frame a2'
const R2 = 'RESULT-TWO: 40 files listed in directory bravo\nbravo/one.txt\nbravo/two.txt'
const R3 = 'RESULT-THREE: build finished with 3 warnings in package charlie\nwarning c1\nwarning c2'

type Result = { id: string; name?: string; text: string | string[] }

/** An Anthropic Messages body: one prompt, then a turn of tool calls and their results. */
function anthropicBody(results: Result[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    model: 'claude-sonnet-5-5',
    ...extra,
    messages: [
      { role: 'user', content: PROMPT },
      { role: 'assistant', content: results.map(r => ({ type: 'tool_use', id: r.id, name: r.name ?? 'Bash', input: { command: 'npm test' } })) },
      {
        role: 'user',
        content: results.map(r => ({
          type: 'tool_result',
          tool_use_id: r.id,
          content: typeof r.text === 'string' ? r.text : r.text.map(t => ({ type: 'text', text: t })),
        })),
      },
    ],
  })
}

/** An OpenAI chat body with one `role: 'tool'` message per result. */
function chatBody(results: Result[]): string {
  return JSON.stringify({
    model: 'gpt-5',
    messages: [
      { role: 'user', content: PROMPT },
      { role: 'assistant', content: null, tool_calls: results.map(r => ({ id: r.id, type: 'function', function: { name: r.name ?? 'Bash', arguments: '{"command":"npm test"}' } })) },
      ...results.map(r => ({ role: 'tool', tool_call_id: r.id, content: r.text as string })),
    ],
  })
}

/** An OpenAI Responses body, as Codex CLI sends it: function_call and function_call_output items. */
function responsesBody(results: Result[]): string {
  return JSON.stringify({
    model: 'gpt-5-codex',
    input: [
      { role: 'user', content: PROMPT },
      ...results.flatMap(r => [
        { type: 'function_call', call_id: r.id, name: r.name ?? 'shell', arguments: '{"command":["npm","test"]}' },
        { type: 'function_call_output', call_id: r.id, output: r.text as string },
      ]),
    ],
  })
}

const slotsOf = (body: string): TextSlot[] => collectTextSlots(parsePayload(body)!)
const at = (slots: readonly TextSlot[], text: string): number => {
  const i = slots.findIndex(s => s.text === text)
  if (i < 0) throw new Error(`no slot with text ${JSON.stringify(text)}`)
  return i
}
const toolResultIndexes = (slots: readonly TextSlot[]): number[] => slots.flatMap((s, i) => (s.kind === 'tool_result' ? [i] : []))
const sorted = (set: ReadonlySet<number>): number[] => [...set].sort((a, b) => a - b)

/** What the item loop notes for a body: every slot's text, a result's text parts joined by a newline. */
function scanAll(screening: Screening, body: string): void {
  const payload = parsePayload(body)!
  const seen = new Set<string>()
  const note = (text: string) => { if (!seen.has(text)) { seen.add(text); screening.noteItemScanned(text) } }
  for (const slot of collectTextSlots(payload)) if (slot.kind !== 'tool_result') note(slot.text)
  // A tool result as the parser hands it to the scan: the whole content, parts joined.
  const messages = (payload.messages ?? payload.input) as Array<Record<string, unknown>>
  for (const m of messages) {
    if (Array.isArray(m.content)) {
      for (const part of m.content as Array<Record<string, unknown>>) {
        if (part.type === 'tool_result') {
          const c = part.content
          note(typeof c === 'string' ? c : (c as Array<{ text: string }>).map(p => p.text).join('\n'))
        }
      }
    } else if (m.role === 'tool' && typeof m.content === 'string') {
      note(m.content)
    }
  }
}

const finding = (match: string, body: string, type = 'API_KEY'): DlpFinding => ({ type, label: type, match, index: body.indexOf(match) })

describe('Screening.flaggedSlots', () => {
  describe('what flags a tool-result slot (FR-012)', () => {
    it('flags a slot whose text a noted item flag equals; a clean result beside it is not flagged (US6-3)', () => {
      const body = anthropicBody([{ id: 'toolu_1', text: R1 }, { id: 'toolu_2', text: R2 }])
      const slots = slotsOf(body)
      const s = new Screening()
      s.noteItemScanned(PROMPT)
      s.noteItemScanned(R1)
      s.noteItemFlag(R1)
      s.noteItemScanned(R2)
      const { flagged, unreached, all } = s.flaggedSlots(slots)
      expect(sorted(flagged)).toEqual([at(slots, R1)])
      expect(unreached.size).toBe(0)
      expect(all).toBe(false)
    })

    it('flags every slot a noted item flag contains, when a parser joined a result\'s text parts', () => {
      const parts = ['PART-A: first block of output', 'PART-B: second block of output']
      const body = anthropicBody([{ id: 'toolu_1', text: parts }, { id: 'toolu_2', text: R2 }])
      const slots = slotsOf(body)
      const joined = parts.join('\n')
      const s = new Screening()
      s.noteItemScanned(PROMPT)
      s.noteItemScanned(joined)
      s.noteItemFlag(joined)
      s.noteItemScanned(R2)
      const { flagged, all } = s.flaggedSlots(slots)
      expect(sorted(flagged)).toEqual([at(slots, parts[0]!), at(slots, parts[1]!)])
      expect(all).toBe(false)
    })

    it('flags a slot whose tool call was MCP-audited, by its call id, and no other', () => {
      const body = anthropicBody([{ id: 'toolu_1', text: R1 }, { id: 'toolu_2', text: R2 }])
      const slots = slotsOf(body)
      const s = new Screening()
      scanAll(s, body)
      s.noteMcpAudit('toolu_2')
      const { flagged, all } = s.flaggedSlots(slots)
      expect(sorted(flagged)).toEqual([at(slots, R2)])
      expect(all).toBe(false)
    })

    it('flags by call id in OpenAI chat bodies too (role: tool)', () => {
      const body = chatBody([{ id: 'call_a', text: R1 }, { id: 'call_b', text: R2 }])
      const slots = slotsOf(body)
      const s = new Screening()
      scanAll(s, body)
      s.noteMcpAudit('call_b')
      expect(sorted(s.flaggedSlots(slots).flagged)).toEqual([at(slots, R2)])
    })

    it('flags a slot whose pre-DLP counterpart at the same index holds a DLP match', () => {
      const secret = 'AKIAQ3EXAMPLEREALKEY99'
      const pre = anthropicBody([{ id: 'toolu_1', text: `deploy log\nkey=${secret}\ndone` }, { id: 'toolu_2', text: R2 }])
      const post = anthropicBody([{ id: 'toolu_1', text: 'deploy log\nkey=[REDACTED:AWS_KEY]\ndone' }, { id: 'toolu_2', text: R2 }])
      const slots = slotsOf(post)
      const s = new Screening()
      s.noteDlp(pre, [finding(secret, pre, 'AWS_KEY')])
      scanAll(s, post)
      const { flagged, all } = s.flaggedSlots(slots)
      expect(sorted(flagged)).toEqual([at(slots, 'deploy log\nkey=[REDACTED:AWS_KEY]\ndone')])
      expect(all).toBe(false)
    })

    it('flags a slot when the DLP match appears only JSON-escaped: a PEM key spanning lines', () => {
      const pem = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----'
      const preText = `cat key.pem\n${pem}\n`
      const pre = anthropicBody([{ id: 'toolu_1', text: preText }, { id: 'toolu_2', text: R2 }])
      // DLP scans the raw request string, where each newline is the two characters \n.
      const match = JSON.stringify(pem).slice(1, -1)
      expect(preText.includes(match)).toBe(false)
      expect(pre.includes(match)).toBe(true)
      const post = anthropicBody([{ id: 'toolu_1', text: 'cat key.pem\n[REDACTED:PRIVATE_KEY]\n' }, { id: 'toolu_2', text: R2 }])
      const slots = slotsOf(post)
      const s = new Screening()
      s.noteDlp(pre, [finding(match, pre, 'PRIVATE_KEY')])
      scanAll(s, post)
      const { flagged, all } = s.flaggedSlots(slots)
      expect(sorted(flagged)).toEqual([at(slots, 'cat key.pem\n[REDACTED:PRIVATE_KEY]\n')])
      expect(all).toBe(false)
    })

    it('flags a slot when the DLP match holds an escaped quote', () => {
      const text = 'export DB_URL="postgres://admin:hunter2pass@db.internal/prod"'
      const pre = anthropicBody([{ id: 'toolu_1', text: R1 }, { id: 'toolu_2', text }])
      const match = JSON.stringify(text).slice(1, -1)
      expect(text.includes(match)).toBe(false)
      const post = anthropicBody([{ id: 'toolu_1', text: R1 }, { id: 'toolu_2', text: 'export DB_URL=[REDACTED:DB_URL]' }])
      const slots = slotsOf(post)
      const s = new Screening()
      s.noteDlp(pre, [finding(match, pre, 'DB_URL')])
      scanAll(s, post)
      expect(sorted(s.flaggedSlots(slots).flagged)).toEqual([at(slots, 'export DB_URL=[REDACTED:DB_URL]')])
    })

    it('flags nothing when DLP found a secret in a prompt slot only (the match is in some slot, no tool result)', () => {
      const secret = 'sk-live-0123456789abcdef0123'
      const preBody = JSON.stringify({
        model: 'm',
        messages: [
          { role: 'user', content: `my key is ${secret}, use it` },
          { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: R1 }] },
        ],
      })
      const postBody = preBody.replace(secret, '[REDACTED:API_KEY]')
      const slots = slotsOf(postBody)
      const s = new Screening()
      s.noteDlp(preBody, [finding(secret, preBody)])
      scanAll(s, postBody)
      const { flagged, all } = s.flaggedSlots(slots)
      expect(flagged.size).toBe(0)
      expect(all).toBe(false)
    })

    it('holds only tool_result indices: an item flag on a prompt does not put the prompt in flagged', () => {
      const body = anthropicBody([{ id: 'toolu_1', text: R1 }])
      const slots = slotsOf(body)
      const s = new Screening()
      scanAll(s, body)
      s.noteItemFlag(PROMPT)
      const { flagged, unreached } = s.flaggedSlots(slots)
      for (const i of [...flagged, ...unreached]) expect(slots[i]!.kind).toBe('tool_result')
      expect(flagged.size).toBe(0)
    })

    it('reads the same on a second call and leaves the slots alone', () => {
      const body = anthropicBody([{ id: 'toolu_1', text: R1 }, { id: 'toolu_2', text: R2 }])
      const slots = slotsOf(body)
      const before = slots.map(sl => sl.text)
      const s = new Screening()
      scanAll(s, body)
      s.noteItemFlag(R2)
      const first = s.flaggedSlots(slots)
      const second = s.flaggedSlots(slots)
      expect(sorted(second.flagged)).toEqual(sorted(first.flagged))
      expect(second.all).toBe(first.all)
      expect(slots.map(sl => sl.text)).toEqual(before)
    })
  })

  describe('the unscanned rule: a result the item loop never noted counts as flagged (FR-012, US1-6)', () => {
    it('flags a slot no noted scanned text contains, while all is false', () => {
      const body = anthropicBody([{ id: 'toolu_1', text: R1 }, { id: 'toolu_2', text: R2 }])
      const slots = slotsOf(body)
      const s = new Screening()
      s.noteItemScanned(PROMPT)
      s.noteItemScanned(R1)
      const { flagged, unreached, all } = s.flaggedSlots(slots)
      expect(sorted(flagged)).toEqual([at(slots, R2)])
      expect(unreached.size).toBe(0)
      expect(all).toBe(false)
    })

    it('flags every tool result when nothing was noted at all (a request with no record of what was judged)', () => {
      const body = anthropicBody([{ id: 'toolu_1', text: R1 }, { id: 'toolu_2', text: R2 }])
      const slots = slotsOf(body)
      const { flagged, all } = new Screening().flaggedSlots(slots)
      expect(sorted(flagged)).toEqual(toolResultIndexes(slots))
      expect(all).toBe(false)
    })

    it('does not flag a slot on that account once all is true (incomplete)', () => {
      const body = anthropicBody([{ id: 'toolu_1', text: R1 }, { id: 'toolu_2', text: R2 }])
      const slots = slotsOf(body)
      const s = new Screening()
      s.noteItemScanned(PROMPT)
      s.noteItemScanned(R1)
      s.incomplete()
      const { flagged, all } = s.flaggedSlots(slots)
      expect(all).toBe(true)
      expect(flagged.size).toBe(0)
    })

    it('counts an Anthropic array-content result noted as its parts joined by a newline as scanned', () => {
      const parts = ['PART-A: first block of output', 'PART-B: second block of output']
      const body = anthropicBody([{ id: 'toolu_1', text: parts }, { id: 'toolu_2', text: R2 }])
      const slots = slotsOf(body)
      expect(slots.filter(sl => sl.kind === 'tool_result').map(sl => sl.text)).toEqual([...parts, R2])
      const s = new Screening()
      s.noteItemScanned(PROMPT)
      s.noteItemScanned(parts.join('\n'))
      s.noteItemScanned(R2)
      const { flagged, unreached, all } = s.flaggedSlots(slots)
      expect(flagged.size).toBe(0)
      expect(unreached.size).toBe(0)
      expect(all).toBe(false)
    })

    it('flags an OpenAI Responses function_call_output the item loop never noted (the parser does not read it)', () => {
      const body = responsesBody([{ id: 'call_1', text: R1 }])
      const slots = slotsOf(body)
      const s = new Screening()
      s.noteItemScanned(PROMPT)
      const { flagged, unreached, all } = s.flaggedSlots(slots)
      expect(sorted(flagged)).toEqual([at(slots, R1)])
      expect(unreached.size).toBe(0)
      expect(all).toBe(false)
    })

    it('leaves a Responses output alone once a scan has noted its text', () => {
      const body = responsesBody([{ id: 'call_1', text: R1 }])
      const slots = slotsOf(body)
      const s = new Screening()
      s.noteItemScanned(PROMPT)
      s.noteItemScanned(R1)
      expect(s.flaggedSlots(slots).flagged.size).toBe(0)
    })

    it('treats an OpenAI chat tool message the same way', () => {
      const body = chatBody([{ id: 'call_a', text: R1 }, { id: 'call_b', text: R2 }])
      const slots = slotsOf(body)
      const s = new Screening()
      s.noteItemScanned(PROMPT)
      s.noteItemScanned(R2)
      expect(sorted(s.flaggedSlots(slots).flagged)).toEqual([at(slots, R1)])
    })
  })

  describe('each way all becomes true', () => {
    it('is false for a complete scan, with or without a DLP pass that found nothing', () => {
      const body = anthropicBody([{ id: 'toolu_1', text: R1 }])
      const s = new Screening()
      scanAll(s, body)
      s.noteDlp(body, [])
      expect(s.flaggedSlots(slotsOf(body)).all).toBe(false)
      expect(new Screening().flaggedSlots(slotsOf(body)).all).toBe(false)
    })

    it('is true after incomplete(), a fail-open pipeline error', () => {
      const body = anthropicBody([{ id: 'toolu_1', text: R1 }])
      const s = new Screening()
      scanAll(s, body)
      s.incomplete()
      expect(s.flaggedSlots(slotsOf(body)).all).toBe(true)
    })

    it('is true when the pre-DLP body has a different number of slots than the slots passed in', () => {
      const secret = 'AKIAQ3EXAMPLEREALKEY99'
      const pre = anthropicBody([{ id: 'toolu_1', text: `key=${secret}` }, { id: 'toolu_2', text: R2 }, { id: 'toolu_3', text: R3 }])
      const post = anthropicBody([{ id: 'toolu_2', text: R2 }, { id: 'toolu_3', text: R3 }])
      const s = new Screening()
      s.noteDlp(pre, [finding(secret, pre)])
      scanAll(s, post)
      expect(s.flaggedSlots(slotsOf(post)).all).toBe(true)
    })

    it('is true when a DLP match appears in no pre-DLP slot of any kind (a secret outside the text slots)', () => {
      const secret = 'sk-ant-api03-metadata-only-secret-4242'
      const pre = anthropicBody([{ id: 'toolu_1', text: R1 }], { metadata: { user_id: secret } })
      const post = anthropicBody([{ id: 'toolu_1', text: R1 }], { metadata: { user_id: '[REDACTED:API_KEY]' } })
      const s = new Screening()
      s.noteDlp(pre, [finding(secret, pre)])
      scanAll(s, post)
      expect(s.flaggedSlots(slotsOf(post)).all).toBe(true)
    })

    it('is true for a secret in a tool_use input, which is not a text slot either', () => {
      const secret = 'ghp_0123456789abcdefghijklmnopqrstuvwxyzAB'
      const mk = (cmd: string) => JSON.stringify({
        model: 'm',
        messages: [
          { role: 'user', content: PROMPT },
          { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: cmd } }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: R1 }] },
        ],
      })
      const pre = mk(`git clone https://${secret}@github.com/o/r`)
      const post = mk('git clone https://[REDACTED:GITHUB_TOKEN]@github.com/o/r')
      const s = new Screening()
      s.noteDlp(pre, [finding(secret, pre, 'GITHUB_TOKEN')])
      scanAll(s, post)
      expect(s.flaggedSlots(slotsOf(post)).all).toBe(true)
    })
  })

  describe('flagged while all is true (the slots the record can still place)', () => {
    it('keeps the slots a noted item flag places, and skips only the DLP rule on a slot-count mismatch', () => {
      const secret = 'AKIAQ3EXAMPLEREALKEY99'
      // Pre-DLP: prompt, R1 (the secret), R2, R3. Post-DLP slots: prompt, R2, R3.
      // Same index, different result: were the DLP rule applied, slot 1 (R2) would
      // be flagged for R1's secret.
      const pre = anthropicBody([{ id: 'toolu_1', text: `key=${secret}` }, { id: 'toolu_2', text: R2 }, { id: 'toolu_3', text: R3 }])
      const post = anthropicBody([{ id: 'toolu_2', text: R2 }, { id: 'toolu_3', text: R3 }])
      const slots = slotsOf(post)
      const s = new Screening()
      s.noteDlp(pre, [finding(secret, pre)])
      s.noteItemScanned(PROMPT)
      s.noteItemScanned(R3)
      s.noteItemFlag(R3)
      const { flagged, all } = s.flaggedSlots(slots)
      expect(all).toBe(true)
      expect(sorted(flagged)).toEqual([at(slots, R3)])
    })

    it('keeps the slots a noted MCP audit places while all is true', () => {
      const pre = anthropicBody([{ id: 'toolu_1', text: R1 }, { id: 'toolu_2', text: R2 }])
      const slots = slotsOf(pre)
      const s = new Screening()
      s.incomplete()
      s.noteMcpAudit('toolu_1')
      const { flagged, all } = s.flaggedSlots(slots)
      expect(all).toBe(true)
      expect(sorted(flagged)).toEqual([at(slots, R1)])
    })

    it('keeps the slot a DLP match places when the counts agree, though a match elsewhere cannot be placed', () => {
      const secret = 'AKIAQ3EXAMPLEREALKEY99'
      const unplaced = 'sk-ant-api03-metadata-only-secret-4242'
      const pre = anthropicBody([{ id: 'toolu_1', text: `key=${secret}` }, { id: 'toolu_2', text: R2 }], { metadata: { user_id: unplaced } })
      const post = anthropicBody([{ id: 'toolu_1', text: 'key=[REDACTED:AWS_KEY]' }, { id: 'toolu_2', text: R2 }], { metadata: { user_id: '[REDACTED:API_KEY]' } })
      const slots = slotsOf(post)
      const s = new Screening()
      s.noteDlp(pre, [finding(secret, pre, 'AWS_KEY'), finding(unplaced, pre)])
      const { flagged, all } = s.flaggedSlots(slots)
      expect(all).toBe(true)
      expect(sorted(flagged)).toEqual([at(slots, 'key=[REDACTED:AWS_KEY]')])
    })
  })

  describe('an observe-mode block ended the scan: cutShort() (audit 4 M1)', () => {
    it('flags the last noted item, leaves the earlier one alone, and puts the one never reached in unreached', () => {
      const body = anthropicBody([{ id: 'toolu_1', text: R1 }, { id: 'toolu_2', text: R2 }, { id: 'toolu_3', text: R3 }])
      const slots = slotsOf(body)
      const s = new Screening()
      s.noteItemScanned(PROMPT)
      s.noteItemScanned(R1)
      s.noteItemScanned(R2)
      s.cutShort()
      const { flagged, unreached, all } = s.flaggedSlots(slots)
      expect(sorted(flagged)).toEqual([at(slots, R2)])
      expect(sorted(unreached)).toEqual([at(slots, R3)])
      expect(all).toBe(false)
      expect(flagged.has(at(slots, R1))).toBe(false)
      expect(unreached.has(at(slots, R1))).toBe(false)
    })

    it('does not also flag, as unscanned, a result the cut-short scan never reached', () => {
      const body = anthropicBody([{ id: 'toolu_1', text: R1 }, { id: 'toolu_2', text: R2 }])
      const slots = slotsOf(body)
      const s = new Screening()
      s.noteItemScanned(PROMPT)
      s.noteItemScanned(R1)
      s.cutShort()
      const { flagged, unreached } = s.flaggedSlots(slots)
      expect(sorted(flagged)).toEqual([at(slots, R1)])
      expect(sorted(unreached)).toEqual([at(slots, R2)])
    })

    it('puts every tool_result slot in unreached when nothing was noted (a block before the item loop)', () => {
      const body = anthropicBody([{ id: 'toolu_1', text: R1 }, { id: 'toolu_2', text: R2 }, { id: 'toolu_3', text: R3 }])
      const slots = slotsOf(body)
      const s = new Screening()
      s.cutShort()
      const { flagged, unreached, all } = s.flaggedSlots(slots)
      expect(flagged.size).toBe(0)
      expect(sorted(unreached)).toEqual(toolResultIndexes(slots))
      expect(all).toBe(false)
      for (const i of unreached) expect(slots[i]!.kind).toBe('tool_result')
    })

    it('puts an OpenAI Responses output, which the item loop never reaches, in unreached', () => {
      const body = responsesBody([{ id: 'call_1', text: R1 }])
      const slots = slotsOf(body)
      const s = new Screening()
      s.noteItemScanned(PROMPT)
      s.cutShort()
      const { flagged, unreached, all } = s.flaggedSlots(slots)
      expect(sorted(unreached)).toEqual([at(slots, R1)])
      expect(flagged.has(at(slots, R1))).toBe(false)
      expect(all).toBe(false)
    })

    it.each([
      ['incomplete() then cutShort()', (s: Screening) => { s.incomplete(); s.cutShort() }],
      ['cutShort() then incomplete()', (s: Screening) => { s.cutShort(); s.incomplete() }],
    ])('gives all and an empty unreached after %s', (_name, act) => {
      const body = anthropicBody([{ id: 'toolu_1', text: R1 }, { id: 'toolu_2', text: R2 }, { id: 'toolu_3', text: R3 }])
      const slots = slotsOf(body)
      const s = new Screening()
      s.noteItemScanned(PROMPT)
      s.noteItemScanned(R1)
      act(s)
      const { flagged, unreached, all } = s.flaggedSlots(slots)
      expect(all).toBe(true)
      expect(unreached.size).toBe(0)
      // The item the scan stopped on is still placed.
      expect(sorted(flagged)).toEqual([at(slots, R1)])
    })
  })

  describe('what it records (D1)', () => {
    afterEach(() => { vi.restoreAllMocks() })

    it('logs nothing, and no DLP match reaches a log', () => {
      const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(m => vi.spyOn(console, m).mockImplementation(() => {}))
      const secret = 'AKIAQ3EXAMPLEREALKEY99'
      const pre = anthropicBody([{ id: 'toolu_1', text: `key=${secret}` }, { id: 'toolu_2', text: R2 }])
      const post = anthropicBody([{ id: 'toolu_1', text: 'key=[REDACTED:AWS_KEY]' }, { id: 'toolu_2', text: R2 }])
      const s = new Screening()
      s.noteDlp(pre, [finding(secret, pre, 'AWS_KEY')])
      scanAll(s, post)
      s.noteItemFlag(R2)
      s.noteMcpAudit('toolu_2')
      s.incomplete()
      s.cutShort()
      s.flaggedSlots(slotsOf(post))
      for (const spy of spies) expect(spy).not.toHaveBeenCalled()
    })

    it('keeps one record per request: a new Screening starts empty', () => {
      const body = anthropicBody([{ id: 'toolu_1', text: R1 }])
      const slots = slotsOf(body)
      const used = new Screening()
      used.incomplete()
      used.noteItemFlag(R1)
      used.noteMcpAudit('toolu_1')
      expect(used.flaggedSlots(slots).all).toBe(true)
      const fresh = new Screening()
      scanAll(fresh, body)
      const { flagged, unreached, all } = fresh.flaggedSlots(slots)
      expect(all).toBe(false)
      expect(flagged.size).toBe(0)
      expect(unreached.size).toBe(0)
    })
  })
})

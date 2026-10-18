import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { pairToolResults, extractKeyFacts, detectionScreen, replay, type ReplayItem, type ReplayOptions, type ScreenVerdict } from './shunt/replay.js'
import { renderCondensed } from '../../src/modules/shuntWorker.js'
import { StoredOriginals } from '../../src/modules/shuntStore.js'
import { estimateTokens } from '../../src/modules/tokens.js'
import { DEFAULT_CONFIG } from '../../src/config/config.js'
import { DlpScanner } from '../../src/detection/dlp/scanner.js'
import { startFakeWorker, chatAnswer, promptTokensOf, DEFAULT_FACTS, type FakeWorker, type FakeWorkerReply } from '../modules/fixtures/fakeWorker.js'

// The replay stage of the tool result shunt (specs/001-tool-result-shunt: US5,
// FR-019, FR-020, SC-002, SC-006, SC-010; plan Design 9): recorded Claude Code
// sessions in, the figures of US5-1 out, with a fake worker on loopback and a
// scratch LLM_FW_DIR so nothing reaches a model or the operator's folder.
//
// test/eval/shunt/fixtures/session.jsonl is a synthetic transcript, one JSON
// entry per line, as Claude Code writes them (a message that has several
// content blocks is several entries with one `message.id`):
//
//   line  entry
//    1    user prompt
//   2-3   assistant msg_01: text, tool_use toolu_01 Bash `npm test`
//    4    user: result R1 (354 lines, a vitest run with two failures)
//   5-6   assistant msg_02: tool_use toolu_02 Grep, tool_use toolu_03 Read
//    7    user: result R3 (Read, text parts) then R2 (Grep), the other way round from the calls
//    8    assistant msg_03: tool_use toolu_04 Bash `ls src`
//    9    user: result R5 (3 lines, below the threshold)
//   10-11 assistant msg_04: two text blocks
//   12    assistant msg_05: tool_use toolu_05 Bash `npm run build`
//   13    user: result R4 (361 lines, CRLF line endings)
//   14    assistant msg_06: text
//   15    system, "subtype":"compact_boundary"
//   16    assistant msg_07: tool_use toolu_06 Bash `npm run lint`
//   17    user: result R6 (361 lines)
//   18    assistant msg_08: text
//  19-20  assistant msg_09: tool_use toolu_07 Bash `git log --stat`, tool_use toolu_08 Bash `echo done` (never answered)
//   21    user: a result for toolu_99, a call the transcript never shows
//   22    user: result R7 (371 lines); nothing from the assistant follows
//
// Every large result opens with `RESULT-MARK-R<n>`. The re-reads (plan Design
// 9) follow from the layout: R1 4, R2 and R3 3, R5 2, R4 0, R6 1, R7 0.

const FIXTURE = fs.readFileSync(new URL('./shunt/fixtures/session.jsonl', import.meta.url), 'utf8')

/** A deterministic stand-in for the tokenizer: the replay has to hand it LF-normalised text. */
const countTokens = (text: string): number => text.length
const nl = (text: string): string => text.replace(/\r\n/g, '\n')
const sum = (values: number[]): number => values.reduce((a, b) => a + b, 0)
const markOf = (item: ReplayItem): string => /RESULT-MARK-(R\d)/.exec(item.text)?.[1] ?? 'none'
const lineCount = (text: string): number => text.split('\n').length

const clean = async (): Promise<ScreenVerdict> => 'clean'

describe('replay of recorded sessions (US5)', { timeout: 60_000 }, () => {
  const savedDir = process.env.LLM_FW_DIR
  let root: string
  let worker: FakeWorker
  /** What the fake worker answers; undefined is the default fact list. */
  let reply: (body: unknown) => FakeWorkerReply | undefined

  /** The forwarded form of an original, as the module renders it for the path the scratch folder gives it. */
  const forwarded = (text: string): string => renderCondensed(text, DEFAULT_FACTS, new StoredOriginals(() => Number.MAX_SAFE_INTEGER).pathFor(text))
  const folder = (): string => join(root, 'tool-results')
  const stored = (): string[] => (fs.existsSync(folder()) ? fs.readdirSync(folder()).filter(name => name.endsWith('.txt')) : [])

  const run = (items: ReplayItem[], over: Partial<ReplayOptions> = {}) =>
    replay(items, { worker: { url: worker.url, model: 'fake-worker-model' }, countTokens, includeFileReads: false, screen: clean, ...over })

  /** The sample without the CRLF result, whose forwarded header depends on how a replay counts a carriage return. */
  const sample = (): ReplayItem[] => pairToolResults(FIXTURE).filter(item => markOf(item) !== 'R4')

  beforeEach(async () => {
    root = fs.mkdtempSync(join(tmpdir(), 'llm-fw-shunt-replay-'))
    process.env.LLM_FW_DIR = root
    reply = () => undefined
    worker = await startFakeWorker(body => reply(body))
  })

  afterEach(async () => {
    await worker.close()
    if (savedDir === undefined) delete process.env.LLM_FW_DIR
    else process.env.LLM_FW_DIR = savedDir
    fs.rmSync(root, { recursive: true, force: true })
  })

  describe('pairToolResults (US5-1)', () => {
    it('pairs each tool_result with the tool_use of its id whatever the order, and skips a call with no result and a result with no call', () => {
      const items = pairToolResults(FIXTURE)
      expect(items.map(markOf).sort()).toEqual(['R1', 'R2', 'R3', 'R4', 'R6', 'R7', 'none'])
      const by = (mark: string) => items.find(item => markOf(item) === mark)!
      expect(by('R1')).toMatchObject({ name: 'Bash', input: { command: 'npm test' } })
      expect(by('R2')).toMatchObject({ name: 'Grep', input: { pattern: 'retry', path: 'src' } })
      expect(by('R3')).toMatchObject({ name: 'Read', input: { file_path: '/repo/src/big.ts' } })
      expect(by('R4')).toMatchObject({ name: 'Bash', input: { command: 'npm run build' } })
      expect(by('R6')).toMatchObject({ name: 'Bash', input: { command: 'npm run lint' } })
      expect(by('R7')).toMatchObject({ name: 'Bash', input: { command: 'git log --stat' } })
      // The short one is a result like the others; only the transcript's orphan (toolu_99) has no call and is left out.
      expect(by('none')).toMatchObject({ name: 'Bash', input: { command: 'ls src' }, text: 'a.ts\nb.ts\nc.ts' })
      expect(items.some(item => item.text.includes('a call this transcript never shows'))).toBe(false)
    })

    it('reads a result sent as text parts and a result sent as a string alike, keeping every line', () => {
      const items = pairToolResults(FIXTURE)
      expect(lineCount(items.find(item => markOf(item) === 'R3')!.text)).toBe(401)
      expect(lineCount(items.find(item => markOf(item) === 'R1')!.text)).toBe(354)
      expect(items.find(item => markOf(item) === 'R1')!.text.startsWith('RESULT-MARK-R1 vitest\n')).toBe(true)
    })

    it('counts the re-reads of a result: distinct assistant message ids after it, several entries of one id counted once, none after a compaction, less the one that reads it as new input (plan Design 9, audit 4 M4)', () => {
      const rereads = Object.fromEntries(pairToolResults(FIXTURE).map(item => [markOf(item), item.rereads]))
      expect(rereads).toEqual({ R1: 4, R2: 3, R3: 3, none: 2, R4: 0, R6: 1, R7: 0 })
    })
  })

  describe('replay: the figures of US5-1', () => {
    it.each([false, true])('reports every figure for the sample with file reads included: %s (US5-1, FR-019)', async includeFileReads => {
      const items = sample()
      const eligible = items.filter(item => lineCount(item.text) >= 350 && (includeFileReads || item.name !== 'Read'))
      expect(eligible.map(markOf).sort(), 'the eligible results of the fixture').toEqual(includeFileReads ? ['R1', 'R2', 'R3', 'R6', 'R7'] : ['R1', 'R2', 'R6', 'R7'])

      const report = await run(items, { includeFileReads })

      const original = eligible.map(item => countTokens(nl(item.text)))
      const condensed = eligible.map(item => countTokens(nl(forwarded(item.text))))
      const avoided = original.map((o, k) => o - condensed[k]!)
      const tokensAvoided = sum(avoided)
      const billWeighted = sum(eligible.map((item, k) => avoided[k]! * (1.25 + 0.1 * item.rereads)))
      const workerIn = sum(worker.received.map(r => promptTokensOf(r.body)))
      const workerOut = eligible.length * estimateTokens(DEFAULT_FACTS)

      expect(report.fileReadsIncluded).toBe(includeFileReads)
      expect(report.workerModel).toBe('fake-worker-model')
      expect(report.scope).toMatch(/only.*condense/i)
      expect(report.seen).toBe(items.length)
      expect(report.eligible).toBe(eligible.length)
      expect(report.condensed).toBe(eligible.length)
      expect(report.workerFailed).toBe(0)
      expect(report.rejected).toBe(0)
      expect(report.excluded).toEqual({ flagged: 0, unscanned: 0 })
      expect(report.originalTokens).toBe(sum(original))
      expect(report.condensedTokens).toBe(sum(condensed))
      expect(report.reduction).toBeCloseTo(1 - sum(condensed) / sum(original), 9)
      expect(report.shareSaved).toBeCloseTo(tokensAvoided / sum(items.map(item => countTokens(nl(item.text)))), 9)
      // Main-model tokens: the plain count and the bill-weighted saving, each from the same differences.
      expect(report.tokensAvoided).toBe(tokensAvoided)
      expect(report.billWeighted).toBeCloseTo(billWeighted, 6)
      // Worker tokens, reported apart, and each net of them.
      expect(worker.received).toHaveLength(eligible.length)
      expect(report.workerIn).toBe(workerIn)
      expect(report.workerOut).toBe(workerOut)
      expect(report.netTokensAvoided).toBe(tokensAvoided - (workerIn + workerOut))
      expect(report.netBillWeighted).toBeCloseTo(billWeighted - (workerIn + workerOut), 6)
      expect(report.labelledSubset).toBe(eligible.filter(item => extractKeyFacts(item.text).length > 0).length)
    })

    it('counts a carriage return as no character: no text reaches the tokenizer with a CRLF, and the original is counted as its LF form (FR-019)', async () => {
      const text = Array.from({ length: 360 }, (_, i) => `build step ${i + 1} done`).join('\r\n')
      expect(nl(text).length).toBeLessThan(text.length)
      const given: string[] = []
      const report = await run([{ name: 'Bash', input: { command: 'npm run build' }, text, rereads: 2 }], {
        countTokens: t => { given.push(t); return t.length },
      })
      expect(given.length).toBeGreaterThan(0)
      expect(given.filter(t => t.includes('\r'))).toEqual([])
      expect(report.originalTokens).toBe(nl(text).length)
    })

    it('agrees with itself on results seen, results eligible and original tokens when it runs twice, whatever the worker says the second time (US5-2)', async () => {
      const items = pairToolResults(FIXTURE)
      const first = await run(items)
      let n = 0
      reply = body => ({ json: chatAnswer(`facts of run two, call ${++n}: 3 tests failed`, { prompt_tokens: promptTokensOf(body), completion_tokens: 12 }) })
      const second = await run(items)
      expect(second.seen).toBe(first.seen)
      expect(second.eligible).toBe(first.eligible)
      expect(second.originalTokens).toBe(first.originalTokens)
      expect(first.eligible).toBeGreaterThan(0)
    })

    it('keeps what it stores under the scratch LLM_FW_DIR and nowhere under the operator\'s ~/.llm-fw, and each stored file is its original byte for byte (FR-020, US5-5, SC-010)', async () => {
      const real = join(homedir(), '.llm-fw', 'tool-results')
      const listing = (): string[] | null => (fs.existsSync(real) ? fs.readdirSync(real).sort() : null)
      const realBefore = listing()

      // The CRLF result is stored exactly as the agent received it.
      const crlf: ReplayItem = { name: 'Bash', input: { command: 'npm run build' }, text: Array.from({ length: 360 }, (_, i) => `build step ${i + 1} done`).join('\r\n'), rereads: 0 }
      const items = [...sample(), crlf]
      const report = await run(items)
      const eligible = items.filter(item => lineCount(item.text) >= 350 && item.name !== 'Read')
      expect(report.condensed).toBe(eligible.length)

      const store = new StoredOriginals(() => Number.MAX_SAFE_INTEGER)
      expect(stored()).toHaveLength(eligible.length)
      for (const item of eligible) {
        expect(fs.readFileSync(store.pathFor(item.text)).equals(Buffer.from(item.text, 'utf8')), markOf(item)).toBe(true)
      }
      expect(listing()).toEqual(realBefore)
    })
  })

  describe('key facts and their retention (SC-002, plan D6)', () => {
    const RUN = [
      'RESULT-MARK-FACTS vitest',
      ...Array.from({ length: 345 }, (_, i) => ` ✓ src/mod${i + 1}.test.ts (${(i % 7) + 1} tests) ${(i % 13) + 2}ms`),
      ' FAIL  src/math.test.ts > adds negative numbers',
      'AssertionError: expected -1 to be 1',
      ' FAIL  src/net.test.ts > retries on ECONNRESET',
      'Error: connect ECONNREFUSED 127.0.0.1:5432',
      ' Test Files  2 failed | 5 passed (7)',
      '      Tests  2 failed | 41 passed (43)',
      'npm ERR! Test failed.  See above for more details.',
      'exit code 1',
    ].join('\n')
    const item: ReplayItem = { name: 'Bash', input: { command: 'npm test' }, text: RUN, rereads: 1 }

    it('finds the failing test names, the error messages, the final status and the summary counts, each as the original writes it (SC-002)', () => {
      const facts = extractKeyFacts(RUN)
      expect(facts.length).toBeGreaterThanOrEqual(4)
      for (const fact of facts) expect(RUN.includes(fact), fact).toBe(true)
      expect(facts.some(f => f.includes('adds negative numbers'))).toBe(true)
      expect(facts.some(f => f.includes('retries on ECONNRESET'))).toBe(true)
      expect(facts.some(f => f.includes('ECONNREFUSED'))).toBe(true)
      expect(facts.some(f => f.includes('2 failed'))).toBe(true)
      expect(facts.some(f => /exit code 1|Test failed/.test(f))).toBe(true)
      // Rule-based: the same text gives the same facts.
      expect(extractKeyFacts(RUN)).toEqual(facts)
    })

    it('reports retention 1 when the condensed result holds every fact and less when it holds none, over the results that have facts (SC-002)', async () => {
      const facts = extractKeyFacts(RUN)
      reply = body => ({ json: chatAnswer(facts.join('\n'), { prompt_tokens: promptTokensOf(body), completion_tokens: 40 }) })
      const full = await run([item])
      expect(full.condensed).toBe(1)
      expect(full.labelledSubset).toBe(1)
      expect(full.keyFactRetention).toBe(1)

      reply = body => ({ json: chatAnswer('Nothing notable happened.', { prompt_tokens: promptTokensOf(body), completion_tokens: 6 }) })
      const none = await run([item])
      const text = renderCondensed(RUN, 'Nothing notable happened.', new StoredOriginals(() => Number.MAX_SAFE_INTEGER).pathFor(RUN))
      expect(none.condensed).toBe(1)
      expect(none.keyFactRetention).toBeCloseTo(facts.filter(f => text.includes(f)).length / facts.length, 9)
      expect(none.keyFactRetention!).toBeLessThan(1)
    })
  })

  describe('replay: what it leaves out and what it counts apart (FR-019, audit 4 M4)', () => {
    it('leaves a result the screen calls flagged or unscanned out of every token figure, never sends it to the worker, and counts it in excluded', async () => {
      const items = sample()
      const verdict = async (item: ReplayItem): Promise<ScreenVerdict> => (markOf(item) === 'R2' ? 'flagged' : markOf(item) === 'R6' ? 'unscanned' : 'clean')
      const report = await run(items, { screen: verdict })

      expect(report.excluded).toEqual({ flagged: 1, unscanned: 1 })
      expect(JSON.stringify(worker.received)).not.toContain('RESULT-MARK-R2')
      expect(JSON.stringify(worker.received)).not.toContain('RESULT-MARK-R6')

      const kept = items.filter(item => markOf(item) === 'R1' || markOf(item) === 'R7')
      expect(worker.received).toHaveLength(kept.length)
      const avoided = kept.map(item => countTokens(nl(item.text)) - countTokens(nl(forwarded(item.text))))
      expect(report.condensed).toBe(kept.length)
      expect(report.originalTokens).toBe(sum(kept.map(item => countTokens(nl(item.text)))))
      expect(report.condensedTokens).toBe(sum(kept.map(item => countTokens(nl(forwarded(item.text))))))
      expect(report.tokensAvoided).toBe(sum(avoided))
      expect(report.billWeighted).toBeCloseTo(sum(kept.map((item, k) => avoided[k]! * (1.25 + 0.1 * item.rereads))), 6)
      expect(report.workerIn).toBe(sum(worker.received.map(r => promptTokensOf(r.body))))
      expect(report.workerOut).toBe(kept.length * estimateTokens(DEFAULT_FACTS))
    })

    it('counts a failing worker and a timeout as workerFailed and an answer that fails the citation check as rejected, and none of the three as a condensation or a saving, though the rejected answer cost the worker tokens (FR-007, FR-019)', async () => {
      reply = body => {
        const sent = JSON.stringify(body)
        if (sent.includes('RESULT-MARK-R1')) return { status: 500 }
        if (sent.includes('RESULT-MARK-R6')) return { json: chatAnswer('see /nowhere/ghost.ts, line 9999', { prompt_tokens: promptTokensOf(body), completion_tokens: 40 }) }
        // The last one the replay asks about, so a wait limit counted from the start of the run cannot starve the others.
        if (sent.includes('RESULT-MARK-R7')) return { delayMs: 3_000, json: chatAnswer(DEFAULT_FACTS, { prompt_tokens: promptTokensOf(body), completion_tokens: 8 }) }
        return undefined
      }
      const items = sample()
      const report = await run(items, { waitMs: 300 })

      expect(report.workerFailed).toBe(2)
      expect(report.rejected).toBe(1)
      expect(report.condensed).toBe(1)

      const good = items.find(item => markOf(item) === 'R2')!
      const avoided = countTokens(nl(good.text)) - countTokens(nl(forwarded(good.text)))
      expect(report.tokensAvoided).toBe(avoided)
      expect(report.billWeighted).toBeCloseTo(avoided * (1.25 + 0.1 * good.rereads), 6)

      // The rejected answer and the good one were read and written by the worker; the failure and the timeout reported nothing.
      const answered = worker.received.filter(r => /RESULT-MARK-R(2|6)/.test(JSON.stringify(r.body)))
      expect(answered).toHaveLength(2)
      const workerIn = sum(answered.map(r => promptTokensOf(r.body)))
      const workerOut = 40 + estimateTokens(DEFAULT_FACTS)
      expect(report.workerIn).toBe(workerIn)
      expect(report.workerOut).toBe(workerOut)
      expect(report.netTokensAvoided).toBe(avoided - (workerIn + workerOut))
      expect(report.netBillWeighted).toBeCloseTo(report.billWeighted - (workerIn + workerOut), 6)
    })

    it('counts the tokens a worker read of an input it only partly read in workerIn, and the result as workerFailed (D12, FR-007)', async () => {
      reply = () => ({ json: chatAnswer(DEFAULT_FACTS, { prompt_tokens: 137, completion_tokens: 9 }) })
      const r1 = sample().filter(item => markOf(item) === 'R1')
      const report = await run(r1)
      expect(report.workerFailed).toBe(1)
      expect(report.rejected).toBe(0)
      expect(report.condensed).toBe(0)
      expect(report.tokensAvoided).toBe(0)
      expect(report.workerIn).toBe(137)
    })
  })

  describe('detectionScreen: the detection runs first (FR-012, FR-019)', { timeout: 120_000 }, () => {
    const plain = [
      ...Array.from({ length: 400 }, (_, i) => ` ✓ src/mod${i + 1}.test.ts (${(i % 7) + 1} tests) ${(i % 13) + 2}ms`),
      ' Test Files  400 passed (400)',
      '      Tests  1600 passed (1600)',
    ]
    const item = (lines: string[]): ReplayItem => ({ name: 'Bash', input: { command: 'npm test' }, text: lines.join('\n'), rereads: 0 })
    const corpus = JSON.parse(fs.readFileSync(new URL('../detection/fixtures/corpus.json', import.meta.url), 'utf8')) as { attacks: Array<{ category: string; prompt: string }> }

    it('calls a result holding a secret the DLP scanner finds flagged, and plain test-runner output clean', async () => {
      const secret = item([...plain.slice(0, 200), `GITHUB_TOKEN=ghp_${'a'.repeat(36)}`, ...plain.slice(200)])
      expect(new DlpScanner(DEFAULT_CONFIG.dlp).scan(secret.text).length, 'the DLP scanner finds the secret').toBeGreaterThan(0)
      const screen = detectionScreen({ ...DEFAULT_CONFIG })
      expect(await screen(item(plain))).toBe('clean')
      expect(await screen(secret)).toBe('flagged')
    })

    it('calls a result the pipeline would refuse flagged (a block action)', async () => {
      const attack = corpus.attacks.find(a => a.category === 'override')!.prompt
      const injected = item([...plain.slice(0, 200), attack, ...plain.slice(200)])
      const screen = detectionScreen({ ...DEFAULT_CONFIG })
      expect(await screen(injected)).toBe('flagged')
      expect(await screen(item(plain))).toBe('clean')
    })

    // A 32-character value of 32 distinct characters (entropy 5.0), assembled at runtime and never written out: see test/fixtures/syntheticSecrets.ts.
    const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
    const entropyValue = Array.from({ length: 32 }, (_, i) => ALPHABET[(i * 7) % ALPHABET.length]).join('')
    /** A result whose text quotes a command line: JSON-escaped in the request body, its token value ends in the backslash of the escaped quote. */
    const quoted = (): ReplayItem => item([...plain.slice(0, 200), `run(["deploy", "--token=${entropyValue}"])`, ...plain.slice(200)])

    it('calls a result flagged, and does not throw, when DLP redaction leaves the request body unparseable (FR-012, FR-019)', async () => {
      // The premise: the entropy match takes the backslash of the escaped quote after the value, so the
      // redaction removes it and leaves a bare quote in the JSON string.
      const probe = JSON.stringify({ text: quoted().text })
      const dlp = new DlpScanner(DEFAULT_CONFIG.dlp)
      const found = dlp.scan(probe)
      expect(found.some(f => f.type === 'GENERIC_SECRET'), 'the entropy rule finds the token value').toBe(true)
      expect(() => JSON.parse(dlp.redact(probe, found)), 'the redacted body is no longer JSON').toThrow(SyntaxError)

      const screen = detectionScreen({ ...DEFAULT_CONFIG })
      // The real module forwards a body it cannot parse unchanged (parsePayload returns null), so it condenses nothing in it.
      await expect(screen(quoted())).resolves.toBe('flagged')
      expect(await screen(item(plain))).toBe('clean')
    })

    it('counts such a result in excluded.flagged and goes on with the next one instead of stopping the replay (FR-019)', async () => {
      const report = await run([quoted(), item(plain)], { screen: detectionScreen({ ...DEFAULT_CONFIG }) })
      expect(report.seen).toBe(2)
      expect(report.excluded).toEqual({ flagged: 1, unscanned: 0 })
      expect(report.eligible).toBe(1)
      expect(report.condensed).toBe(1)
    })
  })
})

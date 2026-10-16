import type { Duplex } from 'node:stream'
import type { Config, PipelineResult } from '../types.js'
import type { Pipeline } from '../detection/pipeline.js'
import type { DlpScanner } from '../detection/dlp/scanner.js'
import type { EventBus } from '../dashboard/eventBus.js'
import { isObserving } from '../config/config.js'
import { explainBlock } from '../detection/explain.js'
import { MAX_TRANSCRIBE_SECONDS } from '../detection/transcribe.js'
import { FrameReader, OPCODE, RealtimeAudioBuffer, audioScanBody, refuseRealtime, encodeFrame, type Frame, type RealtimeProtocol } from './websocket.js'
import { createLogger } from '../logger.js'

const log = createLogger('realtime')

/**
 * With server-side voice activity detection the client never ends a turn, so
 * buffered audio is also scanned every this many seconds as it streams.
 */
const REALTIME_AUDIO_WINDOW_S = 15

/** What a relay needs from the listener it runs under (the proxy or the gateway). */
export interface RealtimeRelayDeps {
  config: Config
  pipeline: Pipeline
  dlp: DlpScanner
  eventBus: EventBus
  dashboardUrl: () => string | undefined
}

export interface RealtimeSession {
  protocol: RealtimeProtocol
  /** Provider host, for events and the pipeline. */
  target: string
  path: string
  sessionKey: string
  /** The gateway tenant the session belongs to, for enforcement and attribution. */
  tenant?: { id: string; enforcement?: 'enforce' | 'observe' | undefined } | undefined
}

/**
 * A WebSocket session relayed to a provider with its client messages
 * inspected (#270, #344). Shared by the proxy (after TLS interception) and
 * the gateway (as the endpoint), so both apply the same rules.
 *
 * `upstream` is a socket to the provider that emits `readyEvent` once
 * connected; `requestHead` is the handshake to send it, ending in a blank
 * line. Once the provider answers 101, every client message is inspected and
 * then forwarded in order; anything else it answers is passed back as is.
 *
 * Decision points. A message that ends a turn is held until the turn's audio
 * has been scanned; text, tool output and video frames are held until they
 * have been scanned. When the client never ends a turn (server-side voice
 * activity detection), every REALTIME_AUDIO_WINDOW_S of buffered audio is
 * also scanned as it streams, and a block there terminates the session: that
 * audio has already reached the provider. Audio goes through the same path as
 * an `input_audio` part in a chat request, so `nonText.transcribe` and
 * `nonText.mode` apply unchanged, and each scan is capped at
 * MAX_TRANSCRIBE_SECONDS.
 *
 * Observation (deployment-wide, or the tenant's) never refuses: blocks are
 * recorded with `enforced: false`, DLP audits instead of redacting, and a
 * message the relay cannot read is forwarded and recorded.
 */
export function relayRealtimeSession(
  deps: RealtimeRelayDeps,
  session: RealtimeSession,
  sockets: { client: Duplex; head: Buffer; upstream: Duplex; readyEvent: 'connect' | 'secureConnect'; requestHead: string },
): void {
  const { client, upstream, head } = sockets
  upstream.on('error', () => { client.destroy(); upstream.destroy() })
  // Either side going away ends the session. 'end' as well as 'close': the
  // socket handed over by the http server allows half-open connections, so a
  // client that disconnected only ever emits 'end', and waiting for 'close'
  // leaked the upstream connection of every finished session.
  client.on('end', () => { upstream.destroy(); client.destroy() })
  client.on('close', () => upstream.destroy())
  upstream.on('end', () => { client.destroy(); upstream.destroy() })
  upstream.on('close', () => client.destroy())
  upstream.once(sockets.readyEvent, () => upstream.write(sockets.requestHead))

  let headBuf = Buffer.alloc(0)
  const onHead = (chunk: Buffer): void => {
    headBuf = Buffer.concat([headBuf, chunk])
    const end = headBuf.indexOf('\r\n\r\n')
    if (end < 0) return
    upstream.off('data', onHead)
    client.write(headBuf.subarray(0, end + 4))
    const rest = headBuf.subarray(end + 4)
    if (rest.length) client.write(rest)
    upstream.pipe(client)
    if (!/^HTTP\/1\.1 101/.test(headBuf.subarray(0, headBuf.indexOf('\r\n')).toString('latin1'))) return
    relayClient(deps, session, client, upstream, head)
  }
  upstream.on('data', onHead)
}

/** The handshake headers a relay never forwards upstream. */
export const WS_SKIPPED_HEADERS = new Set(['host', 'proxy-authorization', 'proxy-connection', 'content-length',
  // permessage-deflate would compress every frame and leave nothing readable to inspect.
  'sec-websocket-extensions'])

/** Client-to-upstream half of a session: inspect, then forward each message in order. */
function relayClient(deps: RealtimeRelayDeps, session: RealtimeSession, client: Duplex, upstream: Duplex, head: Buffer): void {
  const { config, pipeline, dlp, eventBus } = deps
  const { protocol, target, path, sessionKey, tenant } = session
  const observing = isObserving(config.enforcement, tenant?.enforcement)
  const tags = { ...(tenant ? { tenant: tenant.id } : {}), ...(observing ? { enforced: false } : {}) }
  const reader = new FrameReader(config.proxy.maxBodyBytes > 0 ? config.proxy.maxBodyBytes : undefined)
  let audio = new RealtimeAudioBuffer(MAX_TRANSCRIBE_SECONDS)
  let fragments: Frame[] = []
  let refused = false
  let queue: Promise<void> = Promise.resolve()

  const endSession = (message: string, eventId: string): void => {
    if (refused) return
    refused = true
    const errorEvent = protocol.errorEvent(message, eventId)
    // The close reason is all a Gemini Live client sees, and it is capped at
    // 123 bytes, so it carries the event id rather than the explanation.
    refuseRealtime(client, errorEvent, `${message.split(':')[0]} (event ${eventId})`)
    try { upstream.end(encodeFrame(OPCODE.close, Buffer.from([0x03, 0xf0]), true)) } catch { upstream.destroy() }
  }
  const refuse = (result: PipelineResult, eventId: string, what: string): void => {
    const explanation = explainBlock({ eventId, result, dashboardUrl: deps.dashboardUrl() })
    endSession(`llm-fw blocked this ${what}: ${explanation.error} (stage ${result.stage}, event ${eventId}). ${explanation.remediation}`, eventId)
  }
  const emit = (partial: Parameters<EventBus['emit']>[0]): string => eventBus.emit({ ...partial, ...tags }).id

  const scan = async (body: string, what: string): Promise<boolean> => {
    let eventId = ''
    const result = await pipeline.run('/v1/chat/completions', body, {
      target, method: 'WS', path, sessionKey, onEvent: (e) => { eventId = e.id },
      ...(tenant ? { tenant: tenant.id } : {}),
      ...(tenant?.enforcement ? { enforcement: tenant.enforcement } : {}),
    })
    if (result.action !== 'block') return true
    refuse(result, eventId, what)
    return false
  }
  const scanAudio = async (what: string): Promise<boolean> => {
    const wav = audio.toWav()
    audio.clear()
    return scan(audioScanBody(wav), what)
  }

  /** Read one complete message as a JSON event; null means it was refused (or, observing, forwarded). */
  const readEvent = (message: Frame[], raw: Buffer): { event: Record<string, unknown>; text: string } | null => {
    // Fail closed on anything this relay cannot read: these APIs speak JSON
    // events only, so anything else is either a protocol error or an attempt
    // to get bytes past inspection.
    const uninspectable = (why: string): null => {
      const id = emit({
        stage: 'none', score: 100, similarity: 0, target, method: 'WS', path,
        payload_preview: `${protocol.label} ${why}: ${observing ? 'forwarded (observe)' : 'refused'}, cannot be inspected`,
        payload_full: `${protocol.label} ${why}`,
        action: 'blocked', kind: 'unparsed',
      })
      if (observing) upstream.write(raw)
      else endSession(`llm-fw refused this session: a ${why} cannot be inspected (event ${id}).`, id)
      return null
    }
    const opcode = message[0]?.opcode
    if (opcode !== OPCODE.text && !(opcode === OPCODE.binary && protocol.jsonInBinary)) return uninspectable('binary message')
    const text = Buffer.concat(message.map(m => m.payload)).toString('utf8')
    let event: unknown
    try { event = JSON.parse(text) } catch { return uninspectable(`${opcode === OPCODE.text ? 'text' : 'binary'} message that is not a JSON event`) }
    if (!event || typeof event !== 'object' || Array.isArray(event)) return uninspectable('message that is not a JSON event')
    return { event: event as Record<string, unknown>, text }
  }

  const handle = async (frames: Frame[]): Promise<void> => {
    for (const frame of frames) {
      if (refused) return
      // Control frames go straight through; close ends our side too.
      if (frame.opcode >= OPCODE.close) { upstream.write(frame.raw); continue }
      fragments.push(frame)
      if (!frame.fin) continue
      const message = fragments
      fragments = []
      let raw: Buffer = Buffer.concat(message.map(m => m.raw))
      const read = readEvent(message, raw)
      if (!read) { if (refused) return; continue }
      const { event, text } = read
      const plan = protocol.plan(event, audio.seconds > 0)

      // DLP, as for an HTTP request body. Redaction re-encodes the event as a
      // new text frame.
      if (plan.dlp && config.dlp.enabled) {
        const findings = dlp.scan(text)
        if (findings.length) {
          const types = Array.from(new Set(findings.map(f => f.type))).join(', ')
          const mode = observing ? 'audit' : config.dlp.mode
          const id = emit({
            stage: 'dlp', score: 100, similarity: 0, target, method: 'WS', path,
            payload_preview: types, payload_full: types,
            action: config.dlp.mode === 'block' ? 'blocked' : 'warned', kind: 'dlp', dlpType: findings[0]!.type,
          })
          if (mode === 'block') { endSession(`llm-fw blocked this message: sensitive data detected (${types}, event ${id}).`, id); return }
          if (mode === 'redact') raw = encodeFrame(OPCODE.text, Buffer.from(dlp.redact(text, findings), 'utf8'), true)
        }
      }

      if (plan.clearAudio) audio.clear()
      for (const chunk of plan.audio) {
        if (chunk.sampleRate !== audio.sampleRate) {
          // A new rate starts a new buffer; what was buffered at the old one is scanned first.
          if (audio.seconds > 0 && !await scanAudio('spoken audio')) return
          audio = new RealtimeAudioBuffer(MAX_TRANSCRIBE_SECONDS, chunk.sampleRate)
        }
        audio.append(chunk.data)
      }

      for (const decision of plan.scans) {
        if (decision.kind === 'audio') {
          if (!await scanAudio('spoken turn')) return
        } else if (decision.kind === 'body') {
          const what = { tool_result: 'tool output', 'audio-item': 'audio item', video: 'video frame', prompt: 'message' }[decision.surface]
          if (!await scan(decision.body, what)) return
        }
      }
      if (refused) return
      upstream.write(raw)

      if (audio.seconds >= REALTIME_AUDIO_WINDOW_S) {
        // The client has not ended the turn: scan the window as it streams.
        const wav = audio.toWav()
        audio.clear()
        void scan(audioScanBody(wav), 'spoken audio').catch(err => log.error(`${protocol.label} audio scan failed`, { err }))
      }
    }
  }

  const feed = (chunk: Buffer): void => {
    let frames: Frame[]
    try { frames = reader.push(chunk) }
    catch (err) {
      log.warn(`${protocol.label} session closed: ${(err as Error).message}`)
      client.destroy(); upstream.destroy()
      return
    }
    // One message at a time, in order: a held event must not be overtaken.
    queue = queue.then(() => handle(frames)).catch(err => {
      log.error(`${protocol.label} relay error`, { err })
      client.destroy(); upstream.destroy()
    })
  }
  if (head.length) feed(head)
  client.on('data', feed)
}

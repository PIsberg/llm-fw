import type { DlpFinding } from '../types.js'
import { parsePayload } from './base.js'
import { collectTextSlots, type TextSlot } from './payload.js'

/**
 * What detection and DLP made of one request body, so a module that runs
 * after them can tell which tool results to leave whole. One instance per
 * request: the proxy and the gateway note into it while they screen, and the
 * module reads it afterwards through `flaggedSlots`.
 *
 * It holds the text the scan saw only to compare it with the request's slots,
 * for the length of one request. It logs nothing, and a DLP match is used to
 * find a slot and then dropped.
 */
export class Screening {
  /** Every text the item loop handed to the scan, a result's text parts joined by a newline. */
  private readonly scanned = new Set<string>()
  /** The texts the scan flagged. */
  private readonly flags = new Set<string>()
  /** The call ids of tool calls the MCP audit flagged. */
  private readonly audited = new Set<string>()
  /** Slot indices, in the pre-DLP body, that held a DLP match. */
  private readonly dlpSlots = new Set<number>()
  /** Slot count of every pre-DLP body that had a match. */
  private readonly dlpCounts: number[] = []
  /** A DLP match that no slot of the pre-DLP body holds, or a body that would not parse. */
  private dlpUnplaced = false
  private last: string | undefined
  private isIncomplete = false
  private isCutShort = false

  /** The item loop is about to scan `text`. */
  noteItemScanned(text: string): void {
    this.scanned.add(text)
    this.last = text
  }

  /** Detection flagged `text`. */
  noteItemFlag(text: string): void {
    this.flags.add(text)
  }

  /**
   * DLP ran on `preDlpBody`, the body before it redacted anything. Each
   * finding is placed in the slot of that body that holds its match, so the
   * slot at the same index of the redacted body can be left whole.
   */
  noteDlp(preDlpBody: string, findings: readonly DlpFinding[]): void {
    if (findings.length === 0) return
    const payload = parsePayload(preDlpBody)
    if (!payload) {
      this.dlpUnplaced = true
      return
    }
    const slots = collectTextSlots(payload)
    this.dlpCounts.push(slots.length)
    // DLP scans the raw request string, so a match can hold the JSON escape
    // of a newline or a quote that the slot's decoded text does not.
    const escaped = new Map<number, string>()
    const escapedText = (i: number): string => {
      let e = escaped.get(i)
      if (e === undefined) {
        e = JSON.stringify(slots[i]!.text).slice(1, -1)
        escaped.set(i, e)
      }
      return e
    }
    for (const finding of findings) {
      let placed = false
      for (let i = 0; i < slots.length; i++) {
        if (slots[i]!.text.includes(finding.match) || escapedText(i).includes(finding.match)) {
          this.dlpSlots.add(i)
          placed = true
        }
      }
      if (!placed) this.dlpUnplaced = true
    }
  }

  /** The MCP audit flagged the tool call `toolUseId`. */
  noteMcpAudit(toolUseId: string): void {
    this.audited.add(toolUseId)
  }

  /** The pipeline failed open: nothing it did not note can be trusted to have been screened. */
  incomplete(): void {
    this.isIncomplete = true
  }

  /** An observe-mode block ended the scan at the last item noted. */
  cutShort(): void {
    this.isCutShort = true
  }

  /**
   * Which `tool_result` slots to leave whole. `flagged`: a scan, the MCP
   * audit or DLP flagged it, or no scan noted it. `unreached`: a cut-short
   * scan never got to it. `all`: the record cannot place something, so no
   * result it did not already place is safe.
   */
  flaggedSlots(slots: readonly TextSlot[]): { flagged: ReadonlySet<number>; unreached: ReadonlySet<number>; all: boolean } {
    const mismatch = this.dlpCounts.some(n => n !== slots.length)
    const all = this.isIncomplete || this.dlpUnplaced || mismatch
    const flagged = new Set<number>()
    const unreached = new Set<number>()
    const stoppedOn = this.isCutShort ? this.last : undefined

    slots.forEach((slot, i) => {
      if (slot.kind !== 'tool_result') return
      const text = slot.text
      if (
        holds(this.flags, text)
        || (slot.toolCallId !== undefined && this.audited.has(slot.toolCallId))
        || (!mismatch && this.dlpSlots.has(i))
        || (stoppedOn !== undefined && stoppedOn.includes(text))
      ) {
        flagged.add(i)
      } else if (!all && !holds(this.scanned, text)) {
        if (this.isCutShort) unreached.add(i)
        else flagged.add(i)
      }
    })
    return { flagged, unreached, all }
  }
}

/** Whether some text in `texts` is, or contains, `text` (a joined result holds its parts). */
function holds(texts: ReadonlySet<string>, text: string): boolean {
  if (texts.has(text)) return true
  for (const t of texts) if (t.includes(text)) return true
  return false
}

import type { DlpFinding } from '../types.js'
import type { TextSlot } from './payload.js'

/**
 * What detection and DLP made of one request body, so a module that runs
 * after them can tell which tool results to leave whole. Stub: every method
 * throws until the record is written.
 */
export class Screening {
  noteItemScanned(_text: string): void {
    throw new Error('Screening.noteItemScanned is not implemented')
  }

  noteItemFlag(_text: string): void {
    throw new Error('Screening.noteItemFlag is not implemented')
  }

  noteDlp(_preDlpBody: string, _findings: readonly DlpFinding[]): void {
    throw new Error('Screening.noteDlp is not implemented')
  }

  noteMcpAudit(_toolUseId: string): void {
    throw new Error('Screening.noteMcpAudit is not implemented')
  }

  incomplete(): void {
    throw new Error('Screening.incomplete is not implemented')
  }

  cutShort(): void {
    throw new Error('Screening.cutShort is not implemented')
  }

  flaggedSlots(_slots: readonly TextSlot[]): { flagged: ReadonlySet<number>; unreached: ReadonlySet<number>; all: boolean } {
    throw new Error('Screening.flaggedSlots is not implemented')
  }
}

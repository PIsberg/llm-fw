import { describe, it, expect } from 'vitest'
import { detectHarmfulCompliance } from '../../src/detection/responseHarm.js'

describe('detectHarmfulCompliance', () => {
  it('flags a response that gives a harmful how-to (harmful term + procedure)', () => {
    const r = detectHarmfulCompliance('Sure. To make thermite, combine iron oxide and aluminium powder in a 3:1 ratio.')
    expect(r).not.toBeNull()
    expect(r!.term).toBe('thermite')
  })

  it('flags step-by-step weapon synthesis', () => {
    const r = detectHarmfulCompliance('Here is how to build a pipe bomb. Step 1: you will need a sealed metal pipe and an explosive filler.')
    expect(r).not.toBeNull()
  })

  it('does NOT flag a refusal that names the harmful topic', () => {
    expect(detectHarmfulCompliance("I can't help you make a pipe bomb or any other explosive. That would be dangerous.")).toBeNull()
  })

  it('does NOT flag a harmful term mentioned without procedural compliance', () => {
    expect(detectHarmfulCompliance('Ransomware is a serious cybersecurity threat that organizations should defend against.')).toBeNull()
  })

  it('does NOT flag a benign procedural answer (no harmful vocabulary)', () => {
    expect(detectHarmfulCompliance('To make a great omelette, first combine the eggs, then add a pinch of salt.')).toBeNull()
  })

  it('does NOT flag a high-level security explanation', () => {
    expect(detectHarmfulCompliance('A keylogger is malware that records keystrokes; antivirus tools detect them via signatures.')).toBeNull()
  })

  it('returns null for empty or tiny input', () => {
    expect(detectHarmfulCompliance('')).toBeNull()
    expect(detectHarmfulCompliance('hi')).toBeNull()
  })
})

import { describe, it, expect } from 'vitest'
import { normalize } from '../../src/detection/normalize.js'

describe('normalize', () => {
  it('full-width IGNORE normalized contains "ignore"', () => {
    const input = 'ＩＧＮＯＲＥ'
    expect(normalize(input)).toContain('ignore')
  })

  it('zero-width space removed', () => {
    expect(normalize('hello​world')).toBe('helloworld')
  })

  it('U+200C removed', () => {
    expect(normalize('ab‌cd')).toBe('abcd')
  })

  it('BOM removed', () => {
    expect(normalize('﻿text')).toBe('text')
  })

  it('soft hyphen removed', () => {
    expect(normalize('hyph­en')).toBe('hyphen')
  })

  it('punctuation collapsed: "!!!!" contains single "!" not multiple', () => {
    const result = normalize('!!!!')
    expect(result).toContain('!')
    expect(result).not.toMatch(/!!/)
  })

  it('dashes collapsed: "------" -> "-"', () => {
    expect(normalize('------')).toBe('-')
  })

  it('whitespace normalized: "a   b\\tc" -> "a b c"', () => {
    expect(normalize('a   b\tc')).toBe('a b c')
  })

  it('lowercase: "HELLO" -> "hello"', () => {
    expect(normalize('HELLO')).toBe('hello')
  })

  it('trim: "  hello  " -> "hello"', () => {
    expect(normalize('  hello  ')).toBe('hello')
  })

  it('empty string: "" -> ""', () => {
    expect(normalize('')).toBe('')
  })

  it('clean passthrough: "hello world" -> "hello world"', () => {
    expect(normalize('hello world')).toBe('hello world')
  })
})

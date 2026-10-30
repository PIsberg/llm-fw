import { describe, it, expect } from 'vitest'
// #543: operating points per surface. `--sweep=<surface>.<knob>=v1,v2,...`
// reruns the chosen splits once per value of one per-surface threshold.
import { parseSweep, applySweepValue } from '../../scripts/run-benchmark.js'
import { DEFAULT_CONFIG } from '../../src/config/config.js'
import type { Config } from '../../src/types.js'

describe('parseSweep', () => {
  it('reads a surface, a knob and the values in the order given', () => {
    expect(parseSweep(['--sweep=tool_result.heuristicBlockThreshold=30,40,50'])).toEqual({
      surface: 'tool_result', knob: 'heuristicBlockThreshold', values: [30, 40, 50],
    })
    expect(parseSweep(['--sweep=document.classifierBlockThreshold=0.9,0.97'])).toEqual({
      surface: 'document', knob: 'classifierBlockThreshold', values: [0.9, 0.97],
    })
  })

  it('is absent without the flag', () => {
    expect(parseSweep(['cheap', '--json'])).toBeUndefined()
  })

  it('refuses a surface or knob the pipeline does not read per surface, and a non-number', () => {
    // The prompt surface takes no threshold override, and the embedding
    // stage's absolute cosines are global calibration constants.
    expect(() => parseSweep(['--sweep=prompt.heuristicBlockThreshold=40'])).toThrow(/surface/)
    expect(() => parseSweep(['--sweep=tool_result.embeddingBlockThreshold=0.8'])).toThrow(/knob/)
    expect(() => parseSweep(['--sweep=tool_result.heuristicBlockThreshold=40,high'])).toThrow(/number/)
    expect(() => parseSweep(['--sweep=tool_result.heuristicBlockThreshold='])).toThrow(/value/)
  })
})

describe('applySweepValue', () => {
  it('sets only that surface\'s knob, keeping what the surface already held', () => {
    const c = structuredClone(DEFAULT_CONFIG) as Config
    applySweepValue(c, { surface: 'tool_result', knob: 'heuristicBlockThreshold', values: [] }, 35)
    expect(c.detection.surfaces?.tool_result?.heuristicBlockThreshold).toBe(35)
    expect(c.detection.surfaces?.tool_result?.onBlock).toBe('withhold')
    expect(c.detection.heuristicBlockThreshold).toBe(DEFAULT_CONFIG.detection.heuristicBlockThreshold)
    expect(c.detection.surfaces?.document?.heuristicBlockThreshold).toBeUndefined()
  })
})

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import { extractCodexTags, codexTagDrift, ANCHOR, SOURCES } from '../../scripts/codex-tags.js'

// Shapes copied from codex-rs at rust-v0.167.0 (#607): the protocol block and
// the private constants in other crates.
const PROTOCOL = [
  'pub const USER_INSTRUCTIONS_OPEN_TAG: &str = "<user_instructions>";',
  'pub const USER_INSTRUCTIONS_CLOSE_TAG: &str = "</user_instructions>";',
  'pub const ENVIRONMENT_CONTEXT_OPEN_TAG: &str = "<environment_context>";',
  'pub const ENVIRONMENT_CONTEXT_CLOSE_TAG: &str = "</environment_context>";',
  'const NOT_A_TAG: &str = "plain text";',
].join('\n')
const files = (): Record<string, string> => ({
  [ANCHOR]: PROTOCOL,
  'core/src/realtime_context.rs': 'const STARTUP_CONTEXT_OPEN_TAG: &str = "<startup_context>";\nconst STARTUP_CONTEXT_CLOSE_TAG: &str = "</startup_context>";',
  'core/src/context/internal_model_context.rs': 'const CONTEXT_START_MARKER: &str = "<codex_internal_context";\nconst LEGACY_GOAL_CONTEXT_START_MARKER: &str = "<goal_context>";',
  'ext/git-attribution/src/world_state.rs': 'const START_MARKER: &str = "<git_attribution>";',
  'context-fragments/src/additional_context.rs': 'const ADDITIONAL_CONTEXT_START_MARKER_PREFIX: &str = "<external_";',
})

describe('Codex tag extraction', () => {
  it('reads the protocol block and the private constants, opening forms only', () => {
    expect(extractCodexTags(files())).toEqual([
      'codex_internal_context', 'environment_context', 'external_*', 'git_attribution',
      'goal_context', 'startup_context', 'user_instructions',
    ])
  })

  it('fails instead of guessing when the protocol block is gone', () => {
    const f = files()
    f[ANCHOR] = 'const USER_INSTRUCTIONS: &str = "<user_instructions>";'
    expect(() => extractCodexTags(f)).toThrow(/protocol\.rs/)
  })

  it('fails when a listed source moved or no longer holds a tag constant', () => {
    const missing = files()
    delete missing['ext/git-attribution/src/world_state.rs']
    expect(() => extractCodexTags(missing)).toThrow(/world_state\.rs is missing/)
    const empty = files()
    empty['core/src/realtime_context.rs'] = 'fn nothing() {}'
    expect(() => extractCodexTags(empty)).toThrow(/realtime_context\.rs holds no tag constant/)
  })

  it('reports a tag added and one gone', () => {
    expect(codexTagDrift(['a', 'b'], ['b', 'c'])).toEqual({ added: ['c'], removed: ['a'] })
    expect(codexTagDrift(['a'], ['a'])).toEqual({ added: [], removed: [] })
  })

  it('commits a list made from every listed source', () => {
    const committed = JSON.parse(fs.readFileSync(new URL('../../scripts/codex-tags.json', import.meta.url), 'utf8')) as { release: string; tags: string[] }
    expect(committed.release).toMatch(/^rust-v\d+\.\d+\.\d+$/)
    // One tag from the anchor block and one from each private-constant file.
    for (const t of ['environment_context', 'startup_context', 'goal_context', 'git_attribution', 'external_*']) expect(committed.tags).toContain(t)
    expect(SOURCES[0]).toBe(ANCHOR)
  })
})

// The licence terms in one place the CLI can print. `llm-fw license` exists so
// that "what am I allowed to do with this?" is answerable without leaving the
// terminal — the question that otherwise gets answered by guessing, because the
// npm page shows "SEE LICENSE IN LICENSE.md" and stops there.
//
// LICENSE_NAME is asserted against LICENSE.md by test/cli/license.test.ts: the
// file is the authority, this constant is a copy, and the test is what keeps the
// copy honest.
export const LICENSE_NAME = 'PolyForm Noncommercial License 1.0.0'
export const LICENSE_URL = 'https://polyformproject.org/licenses/noncommercial/1.0.0'
export const COMMERCIAL_URL = 'https://deversity.se/llmfw'

export const SHORT_NOTICE =
  `llm-fw is licensed under the ${LICENSE_NAME} — free for noncommercial use. ` +
  `Commercial use requires a licence: ${COMMERCIAL_URL}`

export const NOTICE = `llm-fw — Copyright 2026 Peter Isberg
Licensed under the ${LICENSE_NAME}
${LICENSE_URL}

FREE — no key, no signup, no telemetry
  Any noncommercial purpose: personal projects, hobby work, private study,
  research, teaching, and use by charities, educational institutions, public
  research bodies, and government institutions.

NOT GRANTED BY THIS LICENCE — commercial use
  If llm-fw runs anywhere in a for-profit organisation's work — on a developer
  machine, in CI, or as a shared standalone server — that is commercial use and
  needs a separate licence.

  Buy one, or ask for an invoice:  ${COMMERCIAL_URL}

Full terms ship with the package as LICENSE.md.`

export function run(): void {
  console.log(NOTICE)
}

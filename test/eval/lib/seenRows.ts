/**
 * Held-out rows read while writing or checking a detection rule, by split, with
 * the issue or PR that read them.
 *
 * A held-out split measures how detection handles attacks nobody fitted a
 * rule to. Once a row has been read to write a rule, or to check that a
 * narrowed rule still blocks it, its verdict says nothing about that. So
 * `npm run recall:floor` reports each split twice: every row (the floor, a
 * regression gate, which does not need the rows to be unseen) and the unseen
 * rows only (the generalisation number).
 *
 * Add a row here in the same PR that reads it. Better: do not read held-out
 * rows when writing a rule; write fresh variants of the shape instead. The
 * list starts on 2026-10-26; earlier work read rows that are not recorded.
 */
export const SEEN_ROWS: Readonly<Record<string, ReadonlyArray<readonly [number, string]>>> = {
  'safeguard-prompt-injection': [
    // #480: the 8 direct injections lost between 2026-10-10 and 2026-10-25,
    // read to explain the loss; 7 of them then shaped the #492 patterns.
    [299, '#480, #492'], [557, '#480'], [687, '#480, #492'], [995, '#480, #492'],
    [1138, '#480, #492'], [1142, '#480, #492'], [1165, '#480, #492'], [1755, '#480, #492'],
    // #495: rows the "stay in character" change moved, read to choose the
    // trade and the "never refuses" exclusion.
    [848, '#495'], [862, '#495'], [913, '#495'], [1377, '#495'],
    // #486: every attack row with "unrestricted", read so the narrowed rule
    // keeps blocking them.
    [76, '#486'], [293, '#486'], [858, '#486'], [980, '#486'], [1472, '#486'],
    [1565, '#486'], [1644, '#486'], [1942, '#486'], [1964, '#486'],
    // The "run <word> + <word>" narrowing (live replay FPs): the one row it
    // moved, read to check why. It had scored only through a quoted install
    // step, "Run sudo chmod +x ...", not through the jailbreak it carries.
    [499, 'live replay FPs, 2026-11-01, #626'],
    // #533, with the maintainer's approval (2026-11-11): an evenly spaced
    // sample of 10 of the 150 unseen misses, read to find their shapes. Rules
    // were written from fresh variants, not from these rows.
    [84, '#533'], [315, '#533'], [583, '#533'], [740, '#533'], [900, '#533'],
    [1155, '#533'], [1301, '#533'], [1488, '#533'], [1647, '#533'], [1865, '#533'],
    // A second sample of 10 of the then 121 unseen misses, same day, same way.
    [99, '#533'], [296, '#533'], [595, '#533'], [742, '#533'], [905, '#533'],
    [1163, '#533'], [1290, '#533'], [1479, '#533'], [1674, '#533'], [1834, '#533'],
  ],
  'deepset-prompt-injections': [
    // #533, with the maintainer's approval (2026-11-11): an evenly spaced
    // sample of 10 of the 43 unseen misses, read the same way.
    [0, '#533'], [37, '#533'], [70, '#533'], [79, '#533'], [85, '#533'],
    [89, '#533'], [94, '#533'], [101, '#533'], [106, '#533'], [111, '#533'],
  ],
  'gandalf-ignore-instructions': [
    // #533 (2026-11-11): an evenly spaced sample of 7 of the 14 unseen misses.
    // No rule came of them: three are plain questions about the instructions,
    // and fresh variants of the one attack shape already block.
    [4, '#533'], [21, '#533'], [29, '#533'], [52, '#533'], [54, '#533'],
    [90, '#533'], [103, '#533'],
  ],
  'heldout': [
    [21, '#486'],
    // The transformers 4.3 bump moved these two under the embedding gate. Read
    // with the maintainer's approval to write a stage 1 rule of their shape.
    [0, '#511'], [2, '#511'],
  ],
}

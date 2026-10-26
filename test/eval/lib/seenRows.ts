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
  ],
  'heldout': [
    [21, '#486'],
  ],
}

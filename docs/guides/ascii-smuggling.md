[llm-fw](../../README.md) > [Documentation](../README.md) > ASCII Smuggling Detection

# ASCII Smuggling Detection

A growing class of prompt injection hides instructions in **invisible characters** that render as nothing to a human (and to this dashboard) but are still tokenized and obeyed by the LLM. Standard normalization strips ordinary zero-width characters but not these ranges, so a payload written in them otherwise passes every other stage untouched.

`llm-fw` scans the **raw** prompt — before normalization — for three smuggling channels:

- **Unicode Tags block** (`U+E0000`–`U+E007F`) — the primary "ASCII smuggling" vector. `U+E0020`–`U+E007E` mirror printable ASCII, so an entire sentence can be encoded invisibly and is recovered verbatim by the detector.
- **Bidi overrides** (`U+202D`, `U+202E`) — reorder rendered text so what a reviewer sees differs from the bytes the model receives (Trojan-Source-style).
- **Plane-14 variation selectors** (`U+E0100`–`U+E01EF`) — zero-width selectors, blocked except in the one legitimate shape below.

Common-and-benign invisibles (emoji zero-width joiners, `U+FE0F`, bidi isolates, RTL marks) are reported but **not** blocked on their own, to avoid false positives on legitimate multilingual and emoji text.

Two legitimate uses of the blocked ranges pass, matched by exact shape:

- **The England, Scotland and Wales flag emoji.** Each is a black flag followed by tag characters spelling `gbeng`, `gbsct` or `gbwls` and a cancel tag. Only those three exact sequences pass: tag text dressed up as any other flag, or appended after a real one, still blocks. Other subdivision flags still block too; no major platform renders them.
- **Ideographic variation sequences.** One CJK ideograph followed by exactly one plane-14 selector picks a registered glyph variant, which Japanese personal and place names need (for example the one-dot form of 辻 in a surname). A run of two or more selectors, or a selector on anything that is not an ideograph, still blocks, because that is how a byte-per-selector payload is carried.

A hit is blocked with `403 { "error": "prompt injection detected", "stage": "ascii-smuggling", … }`; the **decoded** hidden instruction is surfaced in the event so an operator can see exactly what was concealed. Events appear on the dashboard under the **ASCII Smuggling** badge with an `ascii-smuggling` stage chip.

### Configuration

```json
{
  "asciiSmuggling": {
    "enabled": true
  }
}
```

Environment overrides:

| Variable | Effect |
|----------|--------|
| `LLM_FW_ASCII_SMUGGLING_ENABLED` | `true`/`false` — enable or disable invisible-character smuggling detection |

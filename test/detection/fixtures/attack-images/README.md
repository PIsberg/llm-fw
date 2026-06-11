# Attack-image fixtures

16 real prompt-injection screenshots (`attack1.png`…`attack16.png`). Each is a
payload — zero-size HTML `<div>`s, hidden SVG `<text>`/CDATA, base64 in
`data-*` attributes, `[SYSTEM OVERRIDE]` / "ignore all previous instructions",
fake "APPROVED" validation results — **rendered as pixels**, the way a user
would paste a screenshot into a multimodal model.

Key property: the injection text exists **only in the pixels**. There is no
text chunk, EXIF, or printable run in the file bytes (`strings` returns
nothing), so without OCR these exercise the *uninspectable media* path (issue
#60), not the text-decoding path used by `text/*` documents and PDFs.

Consumed by `test/detection/image-attacks.test.ts`:

- **Always on (no OCR):** the image is opaque (no extractable text);
  `nonText.mode = 'block'` refuses every one (the designed defense for media the
  firewall can't inspect); `nonText.mode = 'audit'` (default) passes but emits a
  `non-text` warn, so unscanned content reaching the model is never silent.
- **`RUN_OCR=1` (opt-in `nonText.ocr`):** OCR reads the pixels and the recovered
  text is scanned like any prompt. 13 of the 16 block on **content** even in
  audit mode; `attack2/3/5` hide the imperative in base64 / HTML-entity encoding
  OCR can't cleanly recover, so block mode's opacity refusal backstops them.
  Gated because the first run downloads ~12 MB of tesseract.js core + lang data.
